# v2 分支复审结果

审查基准：当前 `main..v2`，HEAD=`b0bdd1e`。相较首轮复审新增修复提交后，目前为 10 个提交；排除 `v2-review/` 审查材料后，diff 为 45 个文件、约 +2116/-3980。原委托书中的 9 个提交/41 个文件统计已过期。<br>
审批结论：**不批准合并**。未发现 P0；仍有 **3 项 P1、4 项 P2**。上轮问题中多数已修复，但以下问题仍可复现或由当前代码直接确认。

## P1

### P1-1 `scan.encode` / `reduce.sumInto` 仍会互相覆盖同实例参数

`src/primitives/scan.ts:248,276-277` 在编码每个 dispatch 时都把 count/模式写入实例共享的 `paramsA/paramsB`；`src/primitives/reduce.ts:103-114` 同样写入单个共享 `params`。两个调用在同一 command encoder 提交前发生时，前一个 dispatch 读取到后一个调用的参数。`Scan.encode` 与 `Reduce.sumInto` 的接口没有限制同一次提交只能调用一次（`src/primitives/scan.ts:173-182`、`src/primitives/reduce.ts:63-73`）。

Edge 真机 GPU 复现：同一 scan 实例先编码 `count=4` 再编码 `count=1`，首个输出 `dst[3]=0`，预期 3；同一 reduce 实例先求 4 个 1 再求 1 个 1，首个和为 1，预期 4。新加的 encode-once guard 只在 `src/core/kernel.ts`，没有覆盖这两个公开原语。

### P1-2 静态绑定分析仍会把 WGSL 结构成员误判为资源使用

`src/core/kernel.ts:153-162` 在 userFn 可达函数体中按词法 token 匹配资源名。它能排除未调用 helper 中的字段，但区分不了全局资源名与结构体成员名。若 `inputs` 声明了 `ghost`，userFn 只访问 `item.ghost`，分析仍将 ghost 对应 binding 加入 bind group；WGSL entry point 实际未静态使用该全局资源，`layout:'auto'` 布局不含它。真实 GPU 上出现 WebGPU validation errors，dispatch 没有写出预期 `out[0]=7`。

复现形式：`inputs: { ghost: 'f32' }`，WGSL 中声明 `struct Item { ghost: f32, }` 并令 `userFn` 写入 `item.ghost`。因此上轮“未调用 helper 引用 ghost”的特定问题已修，但词法分析本身仍能使合法 kernel 失效。

### P1-3 默认 `GpuContext` 从未启用 `timestamp-query`，`timeGpu` 在默认路径不可用

`src/core/context.ts:89` 的 `adapter.requestDevice()` 只传 `label` 和 `requiredLimits`，没有请求 `timestamp-query`；而 `src/observe.ts:14-15` 只有在 `device.features.has('timestamp-query')` 时才继续，否则直接抛错。WebGPU 规范中 `GPUDeviceDescriptor.requiredFeatures` 默认为空，设备只获得请求/默认启用的能力；`timestamp-query` 是可选能力。[WebGPU 规范](https://www.w3.org/TR/webgpu/) 因此即便 adapter 支持它，通过库默认 `GpuContext.get()` 建出的 device 也不会启用该 feature。经 `GpuContext.adopt()` 传入且已启用此 feature 的 device 可能可用，但普通默认路径不能使用 `timeGpu`。

三段提交修正了 timestamp 的队列先后顺序；本次设备因 feature 缺失跳过运行时数值探针，这符合委托书已知缺口，但没有覆盖默认设备没有请求 feature 这一独立问题。

## P2

### P2-1 `encode` 参数校验失败会锁住 kernel 的 encode guard

`src/core/kernel.ts:307-310` 在检查资源之前将 `encodeGuardOpen` 置为 true；资源校验从 `:313` 开始。第一次 `encode()` 若因缺失资源等原因抛错，尚未写入 dispatch，之后同一实例的有效重试仍会在 guard 处被当成重复 encode 拒绝。guard 只由成功的 `run()`（`:369-375`）或调用者显式 `endSubmit()`（`:377-380`）重置。可在参数/资源校验成功后再打开 guard，或在抛错时回滚。

GPU 探针复现：先对缺少 `out` 的资源调用 `encode()` 并捕获错误，再用同一 encoder 和正确资源重试，第二次仍因 `twice before submit` 被拒绝。

### P2-2 API/README 仍描述旧合同和已删除 pack

- `docs/API.md:164` 仍称 uniforms 仅支持标量；`:191-198` 只列 `run()` 且参数类型仅 `number`，没有 `prepare/encode/endSubmit` 或向量 uniform 合同。
- 已删除的 `fields` pack 仍出现在 `docs/API.md:379`、`docs/API.zh-CN.md:378`、`README.cn.md:105` 的 `listPacks()` 示例中。

### P2-3 新的 `NeighborGrid` GPU 回归页未接入 CI

`.github/workflows/ci.yml:32-42,49-54` 运行 smoke、primitives 与 particles 的 grid-debug 页面，但没有运行 `tests/gpu/ngrid.html`。新页面的逐格 CPU 对照、400 格覆盖、排列和重复 update 测试见 `tests/gpu/ngrid.ts:31-47,83-150`。本地真机 GPU 探针通过，但该公开 API 的关键回归测试不会由 CI 自动执行。

### P2-4 委托书中的审查基线统计未随修复提交更新

`v2-review/REVIEW-BRIEF.md:10-19` 仍列 9 个提交和旧提交清单，未包含当前 HEAD `b0bdd1e`；首段的 41 文件统计也与当前排除审查材料后的 45 文件 diff 不同。复审以当前 Git 实际状态为准。

## 上轮问题闭环情况

| 上轮问题 | 当前状态 |
|---|---|
| timeGpu 时间戳没有包围回调 | **提交顺序已修**；默认设备未请求 timestamp-query，见 P1-3。 |
| kernel 重复 encode 覆盖 uniforms | **已加运行时拒绝**；但原语层 scan/reduce 未覆盖，见 P1-1；校验失败会锁 guard，见 P2-1。 |
| 未调用 helper 误纳资源绑定 | **该特定情形已修**；结构成员同名仍有误判，见 P1-2。 |
| NeighborGrid 旧 scan/bindings 错误 | **已迁移到 scan 原语**；本地 ngrid 专项探针通过，CI 漏跑该页见 P2-3。 |
| 内置 pack 重名注册 | **已修**；`tests/pack.test.ts:31-40` 覆盖，vitest 通过。 |
| getPack config 泛型丢失 | **已修**；`src/index.ts:47-50` 接受调用方 `TConfig`。 |
| gzip 预算漏掉 primitives | **已修**；`scripts/build.mjs:49-53` 将 `primitives/` 纳入预算。 |
| 删除后 i18n 脚本死引用、CHANGELOG 声称 CI 通过 | **已修**；脚本已删除，CHANGELOG 已标注 CI 尚未运行。 |
| CI 未跑 primitives 页 | **已修**；workflow 已加入 `primitives.html`。 |

## 验证记录

- `npm run typecheck`：通过。
- `npm test`：29/29 通过。
- 当前 Edge 真机 GPU：smoke 20/20、primitives 27/27、ngrid 6/6、grid-debug 19/19，合计 72/72。
- 临时 GPU 复现探针：4/4 确认上述 scan 参数覆盖、reduce 参数覆盖、encode guard 锁住重试、结构成员名触发绑定误判。临时 TS/HTML/bundle 均已删除。
- `timeGpu` 数值探针因本机 device 不含 `timestamp-query` 而跳过；这是委托书 §5 已知设备验证缺口。CI 未运行（禁推状态）。
- `npm run build` 未运行：该脚本会删除并重建现有 `dist`。未修改源码、未推送、未发布。

## 按委托书 §3 的审查区结论

| 审查区 | 结论 | 说明 |
|---|---|---|
| ① `primitives/scan.ts` WGSL 正确性 | **FAIL** | 27 个边界/语义探针通过；但同实例在提交前重复编码不同 count 会覆盖参数（P1-1）。 |
| ② `kernel.ts` prepare/encode/run 拆分 | **FAIL** | 重复 encode guard 有效，但绑定词法分析仍误判结构成员（P1-2），校验异常会锁 guard（P2-1）。 |
| ③ particles scan 迁移与渲染相位 | **PASS-with-notes** | grid-debug、NeighborGrid 真机 GPU 探针均通过；ngrid 页面未纳入 CI（P2-3）。 |
| ④ 删除完整性 | **PASS-with-notes** | 运行时包/脚本引用已删除；README/API 仍有旧 `fields` 示例和旧 kernel 合同文档（P2-2）。 |
| ⑤ 注册表静态化 | **PASS** | 内置名重复注册被拒绝；新 vitest 覆盖通过。 |
| ⑥ `timeGpu` | **FAIL** | 三段提交时序已修；默认创建的 device 没有启用查询 feature（P1-3）。 |
