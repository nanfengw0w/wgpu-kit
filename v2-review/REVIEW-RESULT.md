# v2 分支代码审查结果

审查对象：`git diff main..v2`（委托书所述 9 个未合并提交，41 个文件，约 +1710/-3834）  
审查范围：按 `v2-review/REVIEW-BRIEF.md` §3 的风险顺序审查；对照 `docs/V2-REFACTOR-PLAN.md`、`CHANGELOG.md` 和完整 diff。  
结论：**未发现 P0；发现 5 项 P1、4 项 P2。总体不建议批准合并，需先处理 P1。**

## P1

### P1-1 `timeGpu` 没有测到回调工作

`src/observe.ts:26` 在计时 encoder 中写入起始 timestamp，`:31` 执行回调，`:33` 写入结束 timestamp，`:38` 才提交该 encoder。回调发出的 queue work 会在计时 encoder 提交前入队，因此两个时间戳实际包围的是空档，而不是回调提交的 GPU 工作。当前 `tests/gpu/smoke.ts:336` 只断言时间值为正，无法验证测量对象正确。当前设备不支持 `timestamp-query`，本次无法用该设备验证 GPU 时间戳数值。`src/observe.ts` 不在本次 diff 中，但该 API 被作为本次变更的审查重点检查。

### P1-2 同一对象多次 `encode` 会覆盖尚未提交的 uniform 参数

`src/core/kernel.ts:276` 在编码时更新共享 uniform buffer；`src/primitives/scan.ts:276` 和 `src/primitives/reduce.ts:114` 也复用并更新对象内部的参数 buffer。若在提交 command encoder 前对同一实例连续调用 `encode`，多次 dispatch 读取到的可能都是最后一次写入的参数。

实测复现：同一个 kernel 连续编码两个不同参数后提交，首个 dispatch 得到 5（预期 1）；同一个 scan 连续编码后，首个结果 `dst[65536]` 为 0（预期 65536）。当前 API 没有说明同一对象只能在提交间隔内编码一次，因此这属于可观察的调用语义问题。

### P1-3 静态绑定提取会把未调用 helper 的资源也纳入布局

`src/core/kernel.ts:106-112` 从 WGSL 源码提取静态绑定；生成 bind group/layout 的路径位于 `src/core/kernel.ts:290`。临时 GPU 探针中，未被 `main` 调用的 `unusedHelper()` 引用了 `ghost`，创建 bind group 时因 layout 包含 shader 实际未使用的 binding 2 而触发 WebGPU validation error。提取结果应与入口调用图/实际 shader 静态使用集合一致，或在构造时保证布局兼容。

### P1-4 计划中的 `NeighborGrid` 迁移未完成，旧路径仍会错误运行

计划要求删除 `packs/grid/main_scan`（`docs/V2-REFACTOR-PLAN.md:120`），但公开的 `src/packs/grid/index.ts:91` 仍创建旧 scan。该路径绑定与 WGSL 声明不一致：`bgScan` 在 `src/packs/grid/index.ts:102-109` 使用 bindings 1/2/3，而 shader 在 `:175-180` 声明 2/3/4；`bgScatter` 在 `:111-119` 使用 2/3，而 shader 需要 4/5。旧 scan 的前缀计算（`:207-235`）先累计 lane 跨 chunk 的值再做 prefix，超过 256 个 cell 时不符合全局前缀语义。真实 GPU 的 289-cell 探针得到 `cellFill[0]=0`，预期为 1。

这项发现位于公开 `NeighborGrid` 路径；particles 自身的 scan 与渲染相位探针通过，不代表旧公开路径正确。

### P1-5 静态 pack 注册表没有拒绝内置名称重复注册

`src/core/pack.ts:49-52` 只检查用户注册表内部的重名。`src/index.ts:35-46` 随后把内置 pack 与用户 pack 合并，而查找优先选择内置 pack。注册名为 `particles` 的自定义 pack 后，枚举会出现两个 `particles`，查找却静默返回内置项。本地运行时探针确认了该行为；这与计划中“内置名称重复注册时报错”的要求不符。

## P2

### P2-1 `getPack` 的类型签名丢失 config 类型

`src/index.ts:43,46` 将结果暴露为 `WgpuKitPack<never, PackSim>`。但 `src/core/pack.ts:31` 的 `create` 接口接受 `config?: TConfig`，调用者通过 `getPack` 获取 pack 后不能在 TypeScript 中传入其配置。运行时注册/获取不受影响，类型层面的配置 API 不完整。

### P2-2 gzip 预算未覆盖公开 primitives 实现

`scripts/build.mjs:49-52` 的 gzip 汇总包含 entry、`core/`、layout/errors，但没有包含公开导出的 `src/primitives/scan.ts` 和 `src/primitives/reduce.ts` 实现（导出见 `src/index.ts:12-13`）。预算因而不能约束这部分新增公共代码体积。

### P2-3 删除后仍有死引用，API 文档与实际合同不一致

- `scripts/i18n-errors.cjs:62` 仍读取已删除的 `src/packs/image/index.ts`，运行该 helper 会因源文件不存在而失败。
- `docs/API.md:164,191,198` 仍描述旧 scalar uniforms / run-only 调用方式，没有覆盖 prepare/encode 合同和 vector uniforms。
- 旧 `fields` 示例仍见于 `docs/API.md:379`、`docs/API.zh-CN.md:378`、`README.cn.md:105`。
- `CHANGELOG.md:44` 声称 CI jobs 已通过；本次委托书明确 CI 未运行，发布记录与验证状态不一致。

### P2-4 CI workflow 没有运行 primitives GPU 页面

`.github/workflows/ci.yml:29,34-40,49-51` 会打包 primitives，但测试步骤只覆盖 smoke/grid-debug，没有运行 `tests/gpu/primitives.html`。因此即使 CI 被触发，scan 的档位边界等也没有自动覆盖。本条指 workflow 覆盖不足；“本次 CI 未运行”本身按委托书 §5 作为已知缺口，不另列为新发现。

## 验证记录

- `npm run typecheck`：通过。
- `npm test`：27/27 通过。
- Edge 真机 GPU：`tests/gpu/primitives.html` 27/27；`tests/gpu/smoke.html` 18/18（`timeGpu` 因设备缺少 `timestamp-query` 被跳过）；`tests/gpu/grid-debug.html?lite=1` 19/19。
- 额外 GPU 探针验证了上述重复 encode、未调用 helper 资源布局、静态 pack 重名和旧 `NeighborGrid` 路径问题。
- CI 未运行（委托书所述禁推状态）。`npm run build` 未运行，因为该脚本会删除并重建现有 `dist`。
- 探针脚本及其输出已清理；未修改源码、未推送、未发布。除本报告外，没有新增审查产物。

## 按委托书 §3 的审查区结论

| 审查区 | 结论 | 说明 |
|---|---|---|
| ① `primitives/scan.ts` WGSL 正确性 | **FAIL** | 独立 scan 边界探针通过；但同一实例多次 `encode` 会覆盖参数，影响 scan 结果合同（P1-2）。 |
| ② `kernel.ts` prepare/encode/run 拆分 | **FAIL** | 重复 encode 参数覆盖和静态绑定误判均可导致 GPU 结果错误或验证失败（P1-2、P1-3）。 |
| ③ particles scan 迁移与渲染相位 | **FAIL** | particles 自身 scan/渲染相位探针通过；但计划中的公开 `NeighborGrid` 迁移未完成，旧路径有 binding/前缀错误（P1-4）。 |
| ④ 删除完整性 | **PASS-with-notes** | 运行时演示包已删除；辅助脚本与文档仍有指向已删 API/文件的死引用（P2-3）。 |
| ⑤ 注册表静态化 | **FAIL** | 用户注册表可重复注册内置名称并造成枚举重复（P1-5）。 |
| ⑥ `timeGpu` | **FAIL** | 时间戳没有包围回调提交的 GPU 工作，且当前设备不支持该能力（P1-1）。 |
