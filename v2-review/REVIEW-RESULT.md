# wgpu-kit v2 独立复审结果

**复审日期：** 2026-09-30

**复审基线：** `v2` HEAD `aeebe6e`，对照 `main`；本次按当前源码、测试、计划和委托书重新检查。`v2-review/REVIEW-RESULT.md` 旧内容没有作为评审依据。
**总评：** 0 个 P0、0 个 P1、3 个 P2。当前结论为 **FAIL / 建议修复后再复审**：原语 dispatch 边界没有兑现 API 所声称的 `UsageError` 合同；另外有资源错误路径清理和公开示例问题。

## 发现

### [P2] scan/reduce 的 workgroup 上限未在运行时校验

- `src/primitives/scan.ts:255-256` 的 scan 输入上限为 `SEGMENT * BLOCK_COUNT_CAP`，其中 `BLOCK_COUNT_CAP = 65536`；但 `blockCount = ceil(count / SEGMENT)` 在第 281 行计算后，第 325、337 行直接按 `blockCount` dispatch。输入 `8192 × 65535 + 1` 已产生 **65536** 个 workgroup，超过 WebGPU `maxComputeWorkgroupsPerDimension` 的 65535 上限。
- `src/primitives/reduce.ts:117-126,147` 只验证 count 是非负整数，没有限制 `ceil(count / 8192)`；同样的边界输入会 dispatch 65536 个 workgroup。
- `docs/API.md:748-750` 声称两个上限会以明确的 `UsageError` 校验。当前实现既没有对应的拒绝，也没有该错误合同；超限输入进入 WebGPU dispatch 验证路径。
- 临时 mock GPU 探针确认 scan 和 reduce 都能编码出 `dispatchWorkgroups(65536)`。探针文件已删除。
- 建议在发命令前分别校验 `blockCount/workgroups <= 65535`，越界抛 `UsageError`；补测 `65535` / `65536` 个 workgroup 的 accept/reject 边界，并同步文档。

参考：[WebGPU limits](https://www.w3.org/TR/2026/CRD-webgpu-20260512/#limits)。

### [P2] `reduce.sum()` 在失败路径不销毁私有 scratch buffer

- `src/primitives/reduce.ts:157-160` 先分配 `scratchDst`、`scratchRead`，再调用 `sumInto()`；非法 count 会在第 117 行抛错。
- 两个 buffer 只在 `mapAsync()` 成功、读回完成后才于第 167-168 行销毁。`sumInto()` 校验拒绝、encoder/submit 失败或 `mapAsync()` 拒绝时没有 `finally` 清理。
- 临时 mock GPU 探针传入 `count = -1`，确认 `sum()` 正确拒绝，但两个新建 scratch buffer 的 `destroyed` 仍为 `false`。临时探针文件已删除。
- 建议用 `try/finally` 管理两块临时 buffer，并在 map 状态允许时执行必要的 `unmap()`。

### [P2] 英文 API 的 scan 示例无法按示例运行

- `docs/API.md:734` 只导入 `createScan`、`createReduce`，但第 738-739 行使用未导入的 `Buffer.create`。
- 第 740 行没有 `await scan.run(...)`；第 741 行用 `src.slice` 判断读回，但 `Buffer` API 没有 `slice`，所以 `total` 恒为 `null`，示例也没有展示预期的 scan 结果。
- 建议补上 `Buffer` 导入、等待 `scan.run()`，并直接读取/断言 `dst` 中的前缀和；删除无效的 `src.slice` 条件。

## 审查区结论

| 区域 | 结论 | 依据摘要 |
|---|---|---|
| ① `primitives/scan.ts` WGSL / 双档边界 / 静态绑定 | **FAIL** | GPU 探针覆盖的 65535/65536/65537 元素档位、70000 多档、exclusive/inclusive、重复执行均正确；但 dispatch workgroup 数 65536 的极限未拦截，reduce 同样缺限制。 |
| ② `core/kernel.ts` prepare/encode/run | **PASS-with-notes** | prepare 前 encode 检查、uniform 打包失败后重试、提交后 guard 复位通过。局部变量遮蔽资源名的词法分析限制仍存在，英文/中文 API 已明确记载并给出重命名规避方式（`docs/API.md:186`、`docs/API.zh-CN.md:182-184`）。 |
| ③ particles scan 迁移与渲染相位 | **PASS** | tick 顺序为 counts → scan 独立 pass → post → scatter → force；提交后调用 `endSubmit()`；渲染使用 swap 前 `pp.other`。当前 ngrid 与 grid-debug GPU 探针通过。 |
| ④ 删除完整性 | **PASS** | 在 `src`、`playground`、`tests`、包配置及面向用户文档中搜索委托书列出的死引用模式，无残留匹配；对应 life/fields/image 目录和页面未发现。 |
| ⑤ 注册表静态化 | **PASS** | 根入口静态合成内置包、拒绝注册保留名，单测覆盖重复名、内置名和 `getPack`；`sideEffects: false` 不再依赖顶层 `registerPack()`。 |
| ⑥ `timeGpu` | **PASS-with-notes** | ts0 独立提交 → 等待 `fn(ctx)` → ts1/resolve/readback 提交的队列顺序正确。运行时 timestamp-query 数值仍无法在本机验证，属于委托书 §5 已列缺口，不作为新发现。 |

## 本次验证

- `npm run typecheck`：通过。
- `npm test`：4 个测试文件、29/29 通过。
- 当前 HEAD 的本地真机 GPU 验证：smoke 24/24、primitives 30/30、ngrid 6/6、grid-debug 19/19，共 79/79 通过。并发 reduce sum 与 uniform 校验失败后重试均有专项探针。
- dispatch 极限及失败路径 scratch 清理：用临时 mock GPU 探针检查；观察到上述问题后已删除 `tests/review-temp.test.ts`。
- 死引用搜索：无匹配；工作树中的临时探针已清理。
- CI 未运行、timeGpu 缺少 timestamp-query 真机数值、Phase F 延后：均为委托书 §5 的已知缺口，不作为本轮发现。

## 结论

scan/reduce 的常规数据正确性和本轮并发修复通过；kernel 编码合同、particles 迁移、注册表与删除检查也通过或带说明通过。由于原语的设备 dispatch 上限和文档承诺不一致，且存在失败路径资源清理与不可运行的公共示例，本次评审结论为 **FAIL（3 个 P2 待处理）**。未修改产品代码、未推送、未发布。
