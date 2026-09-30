# wgpu-kit v2 独立复审结果

**复审日期：** 2026-09-30

**复审基线：** `v2` HEAD `7076b61`，对照 `main`。独立检查当前源码、最新提交、GPU 探针和委托书；不以此前的本结果文档作为评审依据。

**总评：** 0 个 P0、0 个 P1、0 个 P2。结论 **PASS-with-notes**；剩余说明均为委托书 §5 已列验证缺口或文档化限制。

## 本轮复核

上一轮发现的 API 示例重复声明已由 `fd906b1` 删除。当前 `docs/API.md` 示例只导入并声明一份 `Buffer`、`scan`、`reduce`、`sum`；`scan.run()` 已等待，且示例读回 `dst` 的前缀值。没有发现新的可操作问题。

## 审查区结论

| 区域 | 结论 | 依据摘要 |
|---|---|---|
| ① `primitives/scan.ts` WGSL / 双档边界 / 静态绑定 | **PASS** | 多档 WGSL、exclusive/inclusive 与边界结果通过真机探针；scan/reduce dispatch 上限校验在边界处抛 `UsageError`。 |
| ② `core/kernel.ts` prepare/encode/run | **PASS-with-notes** | prepare 合同、uniform 校验失败后的重试和 encode-once 行为通过探针。局部变量遮蔽资源名的词法分析限制已在英/中文文档说明及给出规避方式（`docs/API.md:186`、`docs/API.zh-CN.md:182-184`）。 |
| ③ particles scan 迁移与渲染相位 | **PASS** | counts → scan → post → scatter → force 次序、扫描提交 guard 复位及 `pp.other` 渲染相位通过 GPU 回归。 |
| ④ 删除完整性 | **PASS** | 源码、playground、测试、包配置和 API 文档中搜索委托书列出的死引用模式，无残留匹配。 |
| ⑤ 注册表静态化 | **PASS** | 内置包静态合成和保留名行为通过单测；不依赖顶层注册副作用。 |
| ⑥ `timeGpu` | **PASS-with-notes** | ts0 → 被测函数 → ts1/resolve 的队列顺序经代码复核。当前设备没有 `timestamp-query`，运行时计时探针跳过；此项是委托书 §5 已知缺口。 |

## 验证

- 本轮 `npm run typecheck`：通过。
- 本轮 `npm test`：4 个测试文件、29/29 通过。
- 最近一次运行时代码验证（HEAD `3832165`，后续提交只改 API 文档与审查材料）：smoke 24/24、primitives 31/31、ngrid 6/6、grid-debug 19/19，共 **80/80** 真机 GPU 探针通过；包括 dispatch 上限拒绝探针。
- `npm run bundle:tests`：在上一轮验证中通过；本轮未改测试或运行时代码。
- CI 未运行、`timeGpu` 缺少支持设备上的数值验证、Phase F 延后：均按委托书 §5 记录，不作为新发现。

## 结论

上轮唯一 P2 文档问题已修复。本轮未发现新增问题，六个审查区均为 PASS 或 PASS-with-notes。除本评审文档外，本轮未修改产品代码，未推送、未发布。
