# wgpu-kit v2.0 重构 —— 外部 AI 审查委托书

> **给审查者的话**：请以怀疑态度审查下述改动。本项目的历史教训是"实现与测试共享同一个错误假设"以及"注释声称已修但逻辑仍错"——请特别警惕这两类问题。你只做审查，**不修改任何代码**。

---

## 一、审查对象

- **仓库**：`D:\mynpm\wgpu-kit-release`（本地，无远程同步）
- **分支**：`v2`（基于 main 的 `f2c9929`）
- **审查范围**：`git diff main..v2`（41 个文件，+1710/-3834 行），完整 patch 已附：`v2-review/diff-main-v2.patch`
- **提交清单**（`git log main..v2 --oneline`）：
  ```
  98427ef test(v2): encode-contract chain probe + review round fixes
  73b0a92 chore(build): core gzip budget reset to <19 kB
  093c1aa docs(v2): CHANGELOG for 2.0.0
  b310abb feat(v2)!: static pack registry + honest timeGpu timing
  15c7b2a feat(v2)!: GpuContext.adopt + vector uniforms
  adc6507 feat(v2)!: migrate particles/grid scans to core scan primitive
  f8e0130 feat(v2): core primitives layer — dual-tier scan + GPU-resident reduce
  d495162 feat(v2)!: prepare/encode/run encoding contract for kernels and grid
  9a123d3 feat(v2)!: remove demo packs (life/fields/image)
  ```
- **计划文档**（改动的立项依据）：`docs/V2-REFACTOR-PLAN.md`
- **变更清单**：`CHANGELOG.md`（breaking changes 全清单）

## 二、项目背景（30 秒版）

wgpu-kit 是浏览器 WebGPU 计算运行时：elementKernel（用户只写单元素函数，库生成绑定/uniform 打包/错误行号映射）、类型化 schema、O(N) 计数排序邻域网格、200k 粒子旗舰。v2.0 主题 = **可组合计算**：kernel 拆 prepare/encode/run 三层（多个 kernel 可写入同一 encoder 组成计算链）、core 原语层（scan 双档前缀和 + reduce）、删除全部演示包（life/fields/image，-1767 行）、接入已有设备（adopt）、uniform 向量化、修两个已核实的真 bug（sideEffects 与顶层副作用冲突、timeGpu 时间戳未夹住被测计算）。

## 三、重点审查区（按风险排序）

### ① `src/primitives/scan.ts` —— 全计划最高风险件
双档 u32 前缀和：N≤65536 单 workgroup 分块循环（dispatch 1）；之上三级（scan_block 段内扫 / scan_bases 块和排他原地扫 / add_bases 加基址），三 pass 依赖 WebGPU pass 边界可见性。请审：
- WGSL 正确性：exclusive/inclusive 语义、段边界（8192 对齐、count 非整段）、原地扫块和的读写顺序
- 线性索引一致性：scan_block 每线程持**连续 32 项**（此前 strided 版本是错的——strided 分治对 scan 不成立，只对 reduce 成立）
- bind group：`scan_bases` 只静态使用 binding 0 与 3，多给即校验失败静默 no-op（本项目两次踩过同类坑）
- count=0、65535/65536/65537（档位边界）、重复执行残留

### ② `src/core/kernel.ts` —— prepare/encode/run 拆分
- encode 前未 prepare 的合同是否严密（pipeline / cachedCtx / uniformBuffer 三态）
- `replace()` 热重载后同步管线引用、bind group 缓存失效是否完整
- usedBindings 静态使用分析（剥注释后的词法匹配）是否仍有语义漏洞
- run() 兼容路径是否与 v1 行为完全一致

### ③ `src/packs/particles/index.ts` + `grid.ts` —— scan 原语迁移
- tick 的 pass 顺序：counts → scan（原语，自管 pass）→ post（fill 游标归位 + counts 归零）→ scatter → force
- 曾出的事故：把 scan.encode 包进已打开的 pass → encoder 锁定 → 整帧丢弃（已修，确认无同类残留）
- 渲染相位 `writtenSide = pp.other`（v1.1.3 修复，确认未被本轮回退/破坏）

### ④ 删除完整性
life/fields/image 三包及页面/探针/exports 已删。请全局搜索残留死引用（已知并已修：gallery.ts 的 4 张 life 卡片死链）。grep 建议：`life\.html|fieldsPack|packs/fields|packs/image|gridScanWgsl|SCAN_WORKGROUP`。

### ⑤ `src/core/pack.ts` + `src/index.ts` —— 注册表静态化
`sideEffects: false` 与顶层副作用曾经的冲突是否真正消除；`listPacks/getPack` 静态合成 + 用户注册表的语义是否有漏（重复注册、未知名）。

### ⑥ `src/observe.ts` timeGpu 三段提交
ts0 提交 → fn → ts1+resolve 提交。口径=GPU 墙钟含提交间空隙（文档已注明）。

## 四、复现验证命令（有 WebGPU 浏览器 + Node 22+ 即可）

```bash
cd /d/mynpm/wgpu-kit-release
npx tsc --noEmit                 # 预期:零错误
npx vitest run                   # 预期:27/27
npm run bundle:tests
node scripts/verify.mjs tests/gpu/smoke.html tests/gpu/primitives.html tests/gpu/grid-debug.html --timeout=180000
# 预期:16/16 · 27/27 · 19/19(需 Chrome/Edge 真机 GPU;探针页在 tests/gpu/*.html)
npm run build                    # 预期:预算 <19 kB 断言通过
```

**已实测（2026-09-29，RTX 4060 Laptop / Edge 153）**：GPU 探针 100/100 · vitest 27/27 · 端到端 playground 探针 20/20 · scan 迁移性能门 grid@200k +0.6%（门限 3%）。

## 五、已知的验证缺口（请勿作为"新发现"上报，但欢迎给出补验建议）

1. **CI 未运行**：禁推远程，SwiftShader gpu-probes 的首跑要等推送后（新探针在 CPU 光栅化上的行为未验证）
2. **timeGpu 运行时数值**：本机 Edge 不暴露 timestamp-query，探针按特性跳过；三段提交修复经代码审查确认，缺真机实测数值
3. **统一展示站（Phase F）**：按用户指示推迟到 v2.0 发布后，不在本次审查范围

## 六、输出要求

请按以下格式输出，每条发现必须带 `文件:行号` 证据与推理链：

```
[P0] 致命——物理错误/数据损坏/API 合同破坏
[P1] 严重——边界条件错误/语义含混/验证缺口
[P2] 建议——API 设计/文档/一致性
```

最后给每个审查区（①~⑥）一个结论：PASS / PASS-with-notes / FAIL。

## 七、审查纪律

- **只读**：不修改代码、不执行 git push、不发布 npm
- 可以运行验证命令与探针（需真机浏览器）
- 如果你只能读 patch 附件而无法访问仓库，请指出 patch 之外你还需要哪些文件
