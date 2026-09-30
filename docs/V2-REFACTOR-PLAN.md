# wgpu-kit v2.0 重构计划（最终版）

> **版本：** 2026-09-29 · v3（终稿）
> **性质：** 计划文档，未动任何代码。所有数字均已核实，标注了复现方式。
> **输入：** 三份外部指导意见、外部评审四项指控（已在 v1.1.3 全部修复）、TypeGPU/vgpu 竞品分析、npm 公开数据、对 `main`（f2c9929…）源码的通读与实测。
> **范围决议（用户已确认）：** 不再分 v1.2/v1.3 多个版本——**一个 v2.0 大版本**完成重构 + 删除演示 + 文档重写；`life` 整包删除。

---

## 0. 已定决策（不再重复讨论）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 版本形态 | **单一 v2.0 大版本**，breaking changes 允许 |
| D2 | 演示去留 | `life` **整包删除**（1202 行，比 core 还大）；`fields`/`image` 同删（fields 依赖 life/map.ts，连体删除）；`particles` **保留**（旗舰 + 验收载体）；v1.1.3 git tag 永久兜底 |
| D3 | scan 多档 | **本次就做**多 workgroup 档（N>65536）——它是对"core 抽象能否表达跨 workgroup 协作"这一最大假设的试金石，躲了它重构就白干 |
| D4 | histogram | **砍掉**，聚焦 scan + reduce |
| D5 | sideEffects | **注册表静态化**（内置表并入注册表，删除顶层副作用），不做白名单 carving |
| D6 | shader 类型层 | **冻结** `defineSchema`（不再与 TypeGPU 的 `d.*` 军备竞赛）；不做 TS→WGSL 编译器 |
| D7 | 分支策略 | `v2` 分支开发，每 Phase 独立提交可回退，全量验证绿后合 `main` |
| D8 | 方向排他 | 明确不做：TS→WGSL 编译器、新增任何 pack、3D 渲染引擎、ML 运行时、WebGL 降级、**重写 core** |
| D9 | TypeGPU 关系 | **互通而非依赖**：零硬依赖核心不变；双向 seam——我方暴露 `Buffer.gpuBuffer` + `GpuContext.adopt(device)`，接受对方 `root.unwrap()` 产物；README 双语设 "Using with TypeGPU" 互通章节；将来按需出独立适配小包，主包永远干净 |

---

## 1. 诊断（全部经实测核实）

### 1.1 结构失衡

| 层 | 行数 | 性质 |
|---|---|---|
| `src/packs` | **3159**（68%） | 应用/演示 = 负债 |
| `src/core` | **1090**（24%） | 基础设施 = 资产 |
| 胶水（react/three/media/observe/vite） | 371（8%） | 集成，保留 |

`life` 单包 1202 行 > 整个 core。复现：`find src/packs -name '*.ts' | xargs wc -l | tail -1`。

### 1.2 同一 scan 写了两遍、修了三遍

`packs/grid` 的 `main_scan` 与 `packs/particles` 的 `gridScanWgsl` 是同一算法的两个手写变体；git 中 scan 相关 4 条提交里 **3 条是修复**（163e3a3 / f3da99e / 0e7dc52）。结论：**core 缺原语层**，scan 应写一次、测一次、处处复用。

### 1.3 两个已核实的真 bug（v1.2 遗留，v2.0 一并修）

| bug | 证据 | 状态 |
|---|---|---|
| `sideEffects: false`（package.json:17）与 `src/index.ts:19-27` 顶层 `registerPack()` 冲突 | 已核实。打包器可合法 shake 掉注册调用 → `listPacks()` 返回空，README 承诺违约 | 待修（本计划 Phase E） |
| `timeGpu()` 两个时间戳 pass 写在自己的 encoder，`fn` 的提交在其外部——队列顺序为 fn 先行、双时间戳背靠背，**测得 Δ≈0** | 已核实（src/observe.ts 静态分析） | 待修（Phase E） |

### 1.4 编排断层（核心主线，此前被低估）

`elementKernel.run()` 自建 encoder 自提交、通用 grid 自管资源、three.ts 每次 `update()` 做 GPU→CPU→GPU 往返、`GpuContext` 单例无法接入调用方已有设备。共同指向：**当前封装是"单项功能能独立用"，缺"多项能力能可靠组合"**。这是 v2.0 的主攻方向（Phase A）。

### 1.5 竞品定位（已核实）

| 项目 | 占位 | 对我们的含义 |
|---|---|---|
| TypeGPU（3.2k★） | 类型化资源 + TS 写 shader（TGSL） | **不追**。shader 编写侧是代差，D6 冻结类型层 |
| vgpu（vercel-labs） | TS WebGPU 工具包 + 多 pass 流体/FFT 示例 | 工具包+示例侧的竞品；"可验证原语 + 数据常驻运行时"仍无对手 |
| Taichi.js / GPU.js | JS 写 kernel 的体验层 | 非正面对手 |

**空位结论**：没有一家做"**可验证的 GPU 计算原语 + 数据常驻的运行时**"。v2.0 占这个位。

### 1.6 存量验证资产（不可再生，重构中必须原样保全）

- 真机 GPU 探针 harness + CI SwiftShader 正确性子集（两 job 已全绿）
- 物理等价性回归（grid == tiled == CPU，单帧逐位一致）
- 扫描不变量 + 冻结带检测（v1.1.1 冻结带事故的常驻回归）
- git log 中的运行时知识：adapter 被 GC → Dawn "Instance dropped"（3d75fb5）、SwiftShader compile-info 修复链（05696d0/5195965）、scan 三次返工教训

---

## 2. v2.0 定位

> **wgpu-kit 2.0：可验证的 GPU 计算原语与数据常驻运行时。**
> 你描述计算过程，它负责让数据常驻 GPU、可靠地组合与执行。

README 主叙事由"5 行代码 200k 粒子"（演示）切换为上述定位（基础设施）。粒子系统保留为旗舰与验收载体——**验收标准采用原话：现有粒子系统尽可能完全通过公共核心 API 完成计算、资源管理和测量；它做不到的地方，就是 core 要补的地方。**

---

## 3. 执行计划（Phase 0 → F，顺序即依赖）

### Phase 0 · 删除演示层（v2 分支第一个提交）

**删**：`src/packs/life`（1202 行）、`src/packs/fields`（285 行，依赖 life/map.ts，连体）、`src/packs/image`（280 行）、`playground/life.html + life.ts`、`tests/gpu/packages.ts`（fields+image 探针页）、exports `./life ./fields ./image`、CI/探针套件对应项、README/API 对应章节。

**保**：`packages.ts` 中的 `gpu-raw` 纹理读写回诊断**迁移进 smoke**（环境诊断有价值，与被删包无关）。gallery 页经核实不依赖 life（URL 分享链接），保留。react/three/media/observe/vite 五个胶水入口保留。

**验收**：`tsc` 零错误；探针套件删减后全绿；`npm pack` 产物无死链。

**规模**：S

### Phase A · 编码合同（地基）

| 项 | 内容 |
|---|---|
| A1 `elementKernel` 三层拆分 | `prepare()`（异步编译+预热，幂等）/ `encode(encoder, resources, uniforms)`（**同步**写命令、不提交；未 prepare 先 encode 抛 `UsageError`）/ `run()`（便捷路径 = prepare+encode+内部提交，行为兼容现状） |
| A2 `rawKernel` 同拆 | 同上语义 |
| A3 `NeighborGrid` 拆分 | `update(pos)` → `encode(encoder, pos)` + `run(pos)` |

**验收**：两个 elementKernel 可写入调用方同一 encoder 组成计算链；现有探针不改一行仍全绿（run 兼容层）。

**规模**：M

### Phase B · 原语层（建在 A 的合同上）

| 项 | 设计 |
|---|---|
| B1 `primitives/scan.ts` | `encode(enc, src, dst, count, exclusive?)` + `run()`。**双档**：N ≤ 65536 单 workgroup 分块循环（`dispatch(1)`，barrier 单 workgroup 内合法，正确性不依赖时序——现 particles 设计原样上提）；N > 65536 三级（① 各 workgroup 扫块+写块和 → ② **独立 pass** 单 workgroup 扫块和 → ③ **独立 pass** 加基址），铁律：跨 workgroup 协作必须以 pass 边界保证可见性 |
| B2 `primitives/reduce.ts` | `sumInto(enc, src, count, dst)`（GPU 常驻一等公民）+ `sum(): Promise<number>`（读回糖）。微 pass 清零 → workgroup 树形归约 → atomicAdd |

不做 histogram（D4）。radixSort / tileKernel / indirect dispatch → v2.x 后续（见 §7）。

**验收**：新探针页（`tests/gpu/primitives.ts`）8 类断言全绿，全部对 CPU 参考**位一致**（u32 无浮点问题）：空 count / 1 / 255 / 256 / 257 / 65535 / 65536 / 65537 / 70000（多档路径）/ 全零 / 全一 / **重复执行结果必须一致**（专杀残留状态类 bug）。

**规模**：L（B1 多档是全计划最高风险项）

### Phase C · 迁移 + 删重复

- `packs/particles/grid.ts` 的 `gridScanWgsl` 与 `packs/grid` 的 `main_scan` **删除**，改 `scan` + 应用侧 post kernel（`fill = start + count; counts = 0`，十几行）
- scan 保持**纯函数**（不带清零/fill 副作用）——组合显式化，正是对外部评审"实现与测试共享假设"的解药

**验收（硬性门）**：① grid-debug 全套 19 项原样全绿（= 集成探针）；② bench 的 grid@200k 同步延迟与管线吞吐**劣化 ≤ 3%**（每帧多一个 post pass 的成本必须实测；超标即回改分解方式，**不许上调预算了事**）。

**规模**：M

### Phase D · 资源契约与 uniform

| 项 | 内容 |
|---|---|
| D1 `GpuContext.adopt(device)` | 接入调用方已有 GPUDevice（`Buffer.create` 同步获得 ctx 注入路径）——"让库能进别人的工程"；同时是 **TypeGPU 互通的关键桥**：对方 `tgpu.init()` 的设备由此进入我们的运行时（决策 D9） |
| D2 uniform 向量化 | `layout.ts` 支持 vec2f/vec3f/vec4f 字段，消除 `Only scalars are currently supported` 基础缺口 |

**验收**：以 `adopt` 方式跑通现有任一探针；含 vec3f 的 uniform kernel 在真机 + SwiftShader 双环境编译运行成功。

**规模**：M

### Phase E · 两个真 bug + 平台语义

| 项 | 修法 |
|---|---|
| E1 sideEffects | 注册表静态化：`listPacks()` = 内置静态表 ∪ 用户注册表；删除 `src/index.ts` 顶层 `registerPack` 调用；`registerPack` 对内置名仍报错。**验收**：模拟 tree-shake（仅 import elementKernel）后 `listPacks()` 仍含内置包 |
| E2 timeGpu | 三段提交：`enc0`(ts0)→submit → `await fn(ctx)` → `enc1`(ts1+resolve)→submit；队列顺序 = ts0 → fn 全部工作 → ts1。口径注释写明"含 fn 各提交之间的 GPU 空隙"。**验收**：对已知耗时的 kernel（sleep pass 等价物），测得值落在合理区间，不再 ≈0 |

平台语义冻结：`definePack` / `probe()` 不再加码；平台化扩张的前置检验（Doc 3 §8.2）写进 README——"一个非内置使用者能否只靠公共接口完成多阶段计算"，Phase A 的验收就是答案。

**规模**：S

### Phase F · 统一展示站

| 项 | 内容 |
|---|---|
| F1 站点形态 | 单一展示站取代"GitHub README + 分散 playground 页"的碎片形态：**主页 hero → 特性区 → 示例卡片（实况 + 源码视图）→ 文档**，一个站走完。暗色高级感、滚动叙事；构建用 vite 静态站（无重框架锁死），部署仍是 gh-pages |
| F2 Hero（独属演示，**不照抄棱镜**） | 首屏 = **200k 粒子生命实况**：指针力场搅动、fps 治理、`prefers-reduced-motion` 静态帧、非 WebGPU 静态图兜底。demo 即运行时背书——首屏由公共 encode 合同驱动，"我们是什么"一眼可见 |
| F3 示例卡片 | playground 既有探针页升级为示例卡片（实况渲染 + 只读源码 + 参数区），新增 scan/reduce 原语示例卡片；每卡配 "Copy prompt"（参数 + URL + 种子即提示词，vgpu 式 agent 友好） |
| F4 文档融合 | API 指南 / 概念 / primitives 章节进站内渲染（markdown 源仍随仓库）；**Copy page** 按钮、`/llms.txt`、`/sitemap.md` agent 入口 |
| F5 GitHub 侧 | README.md / README.cn.md 精简为站点入口 + badge + 快速开始，API 细节移站内；docs/*.md 保留为站内源 |
| F6 口径 | BENCHMARK 重新生成（含迁移前后对比）；gzip 双数字 + 探针计数命令化 |

**验收**：主页 hero 为 200k 粒子实况（走公共 encode 合同）；文档/示例/主页一个站走完；双语齐全；`/llms.txt` 与 Copy page 可用；无 life/fields/image 痕迹；探针与 BENCHMARK 数据同步。

**规模**：L（站点 + 内容迁移，v2.0 发布前最后一个 Phase）

**口径关账（Doc 2 附 B 三项）**：
- core gzip：README 同时给两个数 + 命令——拼接值（`cat dist/core/*.js | gzip | wc -c`）与 per-file 预算值（build.mjs 强制口径，偏保守），注明差异原因（逐文件 gzip 各自含头部开销，合计大于拼接值）
- 探针计数：README 加探针目录表（页 × 探针数），附统计命令
- sideEffects：Phase E 关账

**规模**：M

---

## 4. 全局验收门（发布门，全部满足才发 2.0.0）

1. **正确性**：本地真机 + CI SwiftShader 双环境，探针全绿——smoke（含迁移进来的 gpu-raw、13 项存量）、primitives（新，≥8 项）、grid-debug（19 项，一行不改）、bench
2. **性能**：bench grid@200k 同步延迟与管线吞吐劣化 ≤ 3%；BENCHMARK.md 重新生成，**附带认真实现的原生 WebGPU 基线对比**（Doc 3 §7.2：只赢旧版不算数）
3. **结构**：`src/core` 零 packs 依赖；`src/packs` 仅剩 particles；主包 gzip 不破预算（<17 kB，per-file 口径）
4. **产物**：`npm pack` 审计 exports/死链/双语文档对应；CHANGELOG breaking changes 全清单
5. **叙事**：README 能回答"拿掉演示后用户为什么安装"——答案 ≥ 3 条且每条有探针或基准背书

---

## 5. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| scan 多档再踩跨 workgroup 可见性坑 | 中 | 三条铁律制度化进设计（pass 边界/静态分析一致/历史返工点探针先行）；8 类探针在实现**前**写好 |
| 迁移使 grid 性能劣化 | 中 | 性能门 3% 硬性；不过关改分解方式而非调预算 |
| elementKernel 单元素模型表达不了 workgroup 协作 | 低-中 | Phase B1 就是可证伪测试；若证伪，scan 以独立原语形态存在（自带 encode 合同），结论本身即重大产出 |
| 删 demo 流失用户 | 低 | v1.1.3 tag 兜底 + CHANGELOG 迁移指南；npm 月下载 1379，量级可控 |
| v2 分支周期长、与 main 漂移 | 中 | main 冻结功能性改动（只收 bug 修复）；每 Phase 合一次 main 的修复 |

---

## 6. 明确不做（全程有效）

重写 core · 新增任何 pack · TS→WGSL 编译器 · 3D 渲染引擎 · ML 运行时 · WebGL 降级 · 与 TypeGPU 在类型层竞争（改为互通：`gpuBuffer`/`unwrap` 边界已在文档写明）· **硬依赖 TypeGPU**（决策 D9：0.x 变更风险 + 运行时用不到写侧能力 + 双路径维护成本反噬瘦身）

## 7. v2.0 之后的路线备忘（不承诺、不排期，防丢失）

按价值排序，全部依赖 v2.0 的编排合同落地后再评估：

1. kernel DAG：显式读写声明、自动依赖推导、自动 ping-pong、状态版本语义（`position_before → integrate → position_after`）
2. indirect dispatch：compact/筛选结果不回 CPU，GPU 决定工作组数
3. 声明式不变量（`invariant({ energyDrift: { max: 1e-3 } })`）+ 确定性契约
4. 跨厂商性能矩阵（Apple M / Adreno / Intel——"A 卡跑得动 B 卡炸掉"是这类库最常见的死法）
5. per-pass `timestampWrites` 真实挂接、读写字节/带宽占比口径
6. 邻域网格边界语义文档化（高度聚集/稀疏/单格拥挤/结果顺序保证/maxCand 截断的物理语义）
7. 产品打磨层：交互力场、自适应质量治理器（排在基础设施之后，理由：它们是 demo 侧的深）
8. SPH 流体评估（弱可压缩、Müller 2003）——仅当验证体系能逐项对 CPU 参考时才启动
9. **Showcase Hero 首屏（v2.0 发布后的对外门面，用户已拍板要做）**：vgpu.sh 风格的丝滑交互首屏——指针白光射入玻璃棱镜，色散成四束物种色光注入 200k 粒子场（选项 C"棱镜分光粒子场"；备选 B"引力透镜粒子场"）。工程护栏：渲染目标限幅 + fps 治理 + prefers-reduced-motion 静态帧 + 非 WebGPU 静态图兜底；**全程走公共 encode 合同实现**——首屏即 v2.0 验收标准的对外证明。竞品参照：vgpu.sh 主页（agent 优先叙事 + 全屏 shader 首屏）

---

## 附录 A · v1.1.x 已完成项存档（本计划的起点状态）

| 版本 | 内容 |
|---|---|
| 1.1.1 | grid 扫描截断（每帧只扫前 256 格 → 水平冻结带）+ cellFill 语义修复；counts/scan/scatter 拆独立 pass |
| 1.1.2 | 四项评审修复：CI SwiftShader gpu-probes、双口径 bench、defineSchema 类型层（含 @size 前置 + 真实编译器探针）、definePack 平台、adapter 强引用（Instance-dropped 根因）、shader 模块去重与 getCompilationInfo 降级、自动布局未用绑定过滤 |
| 1.1.3 | 渲染双缓冲相位（1,1,3,3 序列）、setParams dt 死参数、注释盲区使用分析——各带行为级探针；BENCHMARK 双口径重生成 |

## 附录 B · 关键数字（全部可复现）

| 数字 | 值 | 复现 |
|---|---|---|
| src/packs 行数 | 3159 | `find src/packs -name '*.ts' \| xargs wc -l \| tail -1` |
| src/core 行数 | 1090 | `find src/core -name '*.ts' \| xargs wc -l \| tail -1` |
| life 包行数 | 1202（> 整个 core） | `find src/packs/life -name '*.ts' \| xargs wc -l \| tail -1` |
| npm 下载 | 1379/月 · 248/周（2026-09-27） | `curl api.npmjs.org/downloads/point/last-month/wgpu-kit` |
| scan 相关提交 | 4 条中 3 条为修复 | `git log --oneline --all \| grep -i scan` |
| CI | verify + gpu-probes 双 job 全绿（SwiftShader 18/18 + 19/19） | `gh run list --workflow CI` |
