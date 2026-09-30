# v2 第三轮独立审查结果

## 审查基线与范围

- 基线：分支 `v2`，HEAD `4aef96a`；审查当前 `git diff main..v2` 和工作树源文件。
- 本报告未读取或依赖旧的 `v2-review/REVIEW-RESULT.md` 作为证据；主要依据是当前代码、实际 diff、委托书、重构计划、变更清单及本轮验证结果。
- 没有改动产品源代码。临时 GPU 探针在复现后已删除；最终工作树仅新增本报告。

## 发现

### [P1] 同一 Reduce 实例并发 `sum()` 会争用 readback buffer

证据：`src/primitives/reduce.ts:86-87,155-165`。每个实例只创建一个 `dstBuf` 和一个 `readBuf`，每次 `sum()` 都复用它们；提交后立即对共享 `readBuf` 调用 `mapAsync()`。同一实例并发调用时，两个 map/readback 生命周期重叠。

复现：先 `await r.prepare()`，再执行 `Promise.all([r.sum(a, 4), r.sum(b, 1)])`。本机 Edge/NVIDIA 实测第一项返回 `4`，第二项以 `Buffer already has an outstanding map pending` 拒绝。`sum()` 没有声明需串行调用，且这是便利 API 的常见并发用法，当前实现不能满足该调用方式。

建议：为每次读回分配独立 scratch/readback，或串行化 `sum()`；若选择不支持并发，也应在提交前明确拒绝，而不是让 WebGPU map 失败。

### [P2] uniform 校验失败会把 kernel encode guard 留在打开状态

证据：`src/core/kernel.ts:338-341`。资源检查结束后先设置 `encodeGuardOpen = true`，随后 `packUniformInto()` 才检查缺失或非法 uniform。打包抛出 `UsageError` 时 guard 没有回滚；用户修正值后在同一实例上重试，会错误地收到“called twice before submit”。`run()` 也经过此路径。

复现：`encode()` 首次缺少必需的 `dt`，捕获 `Missing uniform value for "dt"`；随后以 `{ dt: 9 }` 重试，仍被 encode-once guard 拒绝。当前 `tests/gpu/smoke.ts:331-350` 只覆盖缺资源后重试，未覆盖 uniform 打包失败。

建议：uniform 验证成功后再打开 guard，并确保后续同步编码异常不会留下错误状态。

### [P2] 静态绑定分析把同名局部变量误判为全局资源引用

证据：`src/core/kernel.ts:159-167` 仅在可达函数体中按标识符词法匹配，没有解析局部作用域；命中后 `src/core/kernel.ts:361-364` 会把相应资源加入 bind group。若 WGSL 中写 `let ghost = 2.0;`，而 kernel 同时声明全局资源 `ghost`，分析器会把局部变量当成全局资源使用；但 `layout: 'auto'` 的入口点布局不包含该未使用全局资源，额外绑定会使命令缓冲无效。本机 GPU 探针以 `state: { out: 'f32', ghost: 'f32' }` 和局部 `let ghost` 复现，输出未执行且提交报错。

实现注释 `src/core/kernel.ts:115-116` 已承认词法边界，但仓库文档没有找到对应的用户侧限制说明。另，现有结构体成员探针 `tests/gpu/smoke.ts:355-368` 同时执行 `ghost[idx] = 0.0`，因此全局 `ghost` 确实被引用，不能单独证明 `item.ghost` 不会误判。

建议：改用能区分标识符作用域的 WGSL 分析；短期可增加局部变量同名回归探针，并明确记录限制。

### [P2] scan/reduce 的可接受长度与 WebGPU dispatch 上限不一致

证据：`src/primitives/scan.ts:171,255-256,281,325,337` 将 block 数上限设为 `65536`，并允许 `count = 8192 × 65536 = 536,870,912`；这会向 `dispatchWorkgroups()` 传入 `65536`。WebGPU 的 `maxComputeWorkgroupsPerDimension` 上限为 `65535`（[WebGPU limits](https://www.w3.org/TR/2026/CRD-webgpu-20260512/)），因此该公开支持上限会触发 dispatch 验证错误。`src/primitives/reduce.ts:130,151` 也没有限制 workgroup 数，超出 `65535 × 8192` 的有效 count 会派发超过该上限的 workgroup。

建议：将允许的 block 数限制为不超过 `65535` 并在 scan/reduce API 层提前校验，或采用二维 dispatch/分批策略。

### [P2] v2 新 API 与向量 uniform 文档未同步

证据：

- `src/index.ts:12-13` 已导出 `createScan` / `createReduce`，但 `docs/API.md` 和 `docs/API.zh-CN.md` 没有对应 API 章节；`src/core/context.ts:43-58` 新增 `GpuContext.adopt()`，API 文档也未说明它必须早于首次 `get()` 调用。
- `src/packs/grid/index.ts:42-52` 为 `NeighborGrid` 新增 `prepare()`、`encode()`、`endSubmit()`；英文与中文 API 文档的成员表仍只列 `update()` 和 `destroy()`（`docs/API.md:683-703`、`docs/API.zh-CN.md:644-663`）。
- `docs/API.md:164` 把 kernel spec 的 `uniforms` 声明类型写成运行时值 `UniformValue`；实际 spec 类型是 `Record<string, ScalarKind>`（`src/core/kernel.ts:17-27`）。中文文档仍描述标量-only（`docs/API.zh-CN.md:162,188-195`），但运行时和类型已支持向量 uniform（`src/core/layout.ts:81-105`）。

建议：同步中英文 API 文档，分别写清声明的 `ScalarKind` 与调用时的 `UniformValue`，并补齐 primitives、device adoption 和 grid 编码合同。

## 验证结果

- `npm run typecheck`：通过。
- `npm test`：4 个文件、29/29 通过。
- `npm run bundle:tests`：通过。
- 本机 Edge/NVIDIA WebGPU：`smoke` 22/22、`primitives` 29/29、`ngrid` 6/6、`grid-debug` 19/19，合计 76/76 通过。
- 本轮临时 GPU 探针额外复现了上述 Reduce 并发、uniform guard 重试、局部变量遮蔽三条路径；探针文件已清理。
- CI 未运行、当前设备不支持 timestamp-query、Phase F 延后，均是委托书 §5 已列的验证缺口，不作为新发现。

## 各审查区结论

| 审查区 | 结论 | 说明 |
| --- | --- | --- |
| ① primitives / scan WGSL | **FAIL** | 常测档位与多档输出通过；P1 Reduce 并发读回缺陷，以及 P2 dispatch 上限边界待处理。 |
| ② kernel prepare / encode / run | **FAIL** | P2 uniform 校验失败锁 guard；P2 局部变量遮蔽造成静态绑定误判。 |
| ③ particles scan 迁移与渲染相位 | **PASS** | ngrid 与 grid-debug GPU 探针全通过，未发现迁移或相位回归。 |
| ④ 删除完整性 | **PASS** | 全库搜索未发现已删除包的存活代码/配置引用；命中仅为计划、委托书中的历史说明。 |
| ⑤ 注册表静态化 | **PASS** | vitest 覆盖内置名防覆盖与单份枚举，当前通过。 |
| ⑥ timeGpu | **PASS-with-notes** | 三段队列提交顺序经代码审查；运行时 timestamp 数值缺测属于委托书 §5 已知缺口。 |

## 总结

**总体结论：暂不通过。** 没有 P0；有 1 条 P1 与 4 条 P2。建议先修复 Reduce 并发读回，再处理 encode guard、局部作用域绑定分析与 dispatch 上限，并同步 API 文档后复审。
