# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/);`Bench` 一节记录性能数字(基准即文档)。

## [0.8.0] — 2026-08-29

### Added
- **fields 包**:`flow(config)` 向量场平迹(vortex/curl/twin),复用沉积-扩散-上屏管线
- **image 包**:`applyImage(source, target, ops)` GPU 滤镜管线(blur/sharpen/edge/grayscale/invert/brightness/contrast),数值化 readback
- **kernel 热重载**:`ElementKernel.replace(code)`(先编译后切换,失败保持旧版)+ `wgpuKitHotReload()` Vite 插件 + `hotKernel` 助手
- 探针页标配 `uncapturederror` 监听

### Fixed
- fields:tick 部分重写 uniform 导致 deposit/worldHalf 清零
- image:headless 下 copyExternalImageToTexture 从 canvas 拿不到内容 → 2D getImageData + writeTexture;blit 死 uniform 触发 "binding 0 not present"

### Bench
- fields:65k 粒子平流,60 帧信息素峰值 45/80(vortex/curl)
- image:invert 0/255、blur 边缘 116、edge 255/0(64×64 数值断言)

## [0.7.0] — 2026-08-29

### Added
- **React 绑定**:`<ParticleCanvas {...config} onReady={...} />`(`wgpu-kit/react`,react 为 peerDependency)

### Bench
- 演示页 66,000 粒子 @ **161.9 fps**(grid)

## [0.6.0] — 2026-08-29

### Added
- **画布录制**:`CanvasRecorder`(MediaRecorder,webm vp9 优先,mp4 协商保守)+ 一键下载
- **力矩阵可视化编辑器**:4×4 热力格,拖动改引力,即时生效
- **宇宙画廊**:精选卡片 + localStorage 收藏 + 分享链接导入(Shadertoy 模式雏形)

### Fixed
- headless 下 mp4 录制"协商成功、产物 0 字节" → webm 提前 + 空产物守卫

## [0.5.0] — 2026-08-29

### Added
- **life 包:四种人工生命**(每个都是一条可发布素材)
  - 图灵斑图(Gray-Scott,9 点 Laplacian,每帧 12 迭代)@115.8fps
  - 粘菌(Physarum,三触须 + 沉积扩散)@135.7fps
  - Boids 鸟群(三规则 + counting-sort grid,朝向三角渲染)@165fps
  - 软体触手(Verlet 链 + 黄金角锚点)@151.6fps
- 共享 `MapRenderer`(浓度图上屏,fields 复用)
- life 演示页(选择器 + 领域探针:花纹标准差/信息素峰值/平均速度/约束残差)

### Fixed
- WGSL 保留字:`target`、`fn`;atomic 数组须 atomicStore/atomicLoad
- **触手约束竞态**:原地求解 → ping-pong(残差 0.23 → 0.0067)
- 多步迭代的读写侧按全局迭代序号追踪

## [0.9.9] — 2026-08-29

### Fixed
- 「速度」着色模式下相机缩放 uniform 与 vel 缓冲撞 binding 2,导致 WGSL 编译失败黑屏
  (用户实测抓到;探针矩阵此前未覆盖着色选项叉积,已补测)

## [0.9.12] — 2026-08-29

### Fixed
- **grid 分支重复 pass.end()**:pass 拆分重构后,底部残留的 end/submit 对已结束的
  pass 再次调用,每帧 2 条 "ComputePassEncoder was already ended"(探针计数抓到)

### Verified
- grid vs tiled 形态等价回归 11/11:总力 GPU=CPU 精确一致、单 tick 最终位置三方一致、
  300 帧形态统计偏差 2.5%/7.4%(混沌分岔范围内)——**物理与邻域算法彻底解耦**

## [0.9.10] — 2026-08-29

### Fixed
- **velocity 着色自 S3 起黑屏**:渲染器 bind group 未接入 vel 缓冲(用户实测抓到,
  探针从未覆盖该选项)。bind group 条目现按管线 layout 裁剪(velocity 不读 species、
  species 不读 vel)
- resize → rebuild 竞态:重建期间 rAF 触碰已销毁缓冲 → 重建前置空 sim + 串行化 + 防抖

### Added
- 探针致盲修复:`stats().gpuErrors`(uncapturederror 计数)进入探针断言,
  "每帧抛错黑屏"从此无法骗过验证;首条错误消息直通结果 JSON
- 探针矩阵升级为选项叉积(着色 × 算法 × 规模),8 页 41 项全绿

## [0.9.11] — 2026-08-29

### Fixed
- **grid 模式力归属语义错误(用户实测抓到:同参数下 grid 无结构、tiled 正常)**:
  (粒子×格子) 两趟力核中,线程以"排序槽位 i"定位粒子,力却写给"物理粒子 i"——
  力张冠李戴,结构被噪声破坏。修复:force_cell 以物理粒子 i 为中心(格子定位用
  原数组 posIn[i],邻居遍历仍走排序数组,合并访问保留);格子查询与 CELL_OF 统一浮点序列
- maxNeighbors 默认 4096 → 32768(保险丝只作极端抱团兜底,正常密度永不触发——
  按格子顺序截断会引入方向偏差伪影)
- 同一 compute pass 内多 dispatch 的 partial 竞态 → 各段独立 pass 提交

### Added
- `debugGrid()` 调试访问器 + grid 形态等价性常驻回归页(同种子 300 帧,
  grid vs tiled 结构统计对比,阈值 25%/35%)

### Bench
- 形态等价:最近邻偏差 1.6%、邻居数偏差 6.8%(混沌分岔范围内)
- 逐格部分力 GPU vs CPU 精确一致;总力 9.3824,4.1200 双方一致

## [0.9.8] — 2026-08-29

### Changed
- grid 力核拆为两趟:(粒子 × 3×3 格) 部分力 + 汇总积分——消除抱团时的负载不均
- scatter 顺带写出按格子序重排的 pos/species 副本,力核顺序读取(合并访问)
- 世界自适应:面积随粒子数等比扩大(16k 密度恒定),相机缩放跟随——大规模下物理与 16k 版逐位一致

### Bench
- **干净基线重测(此前数字被用户运行的游戏污染,全部作废)**:
  grid@16k 2.53ms、@66k 2.57ms、@131k 2.57ms、@200k 3.52ms(近乎平坦);
  grid 对 tiled 66k 时 **8.5×**;候选上限零成本;全程 GPU 47°C 干净状态

### Fixed
- 大世界下出生点仍撒在旧范围(局部密度超标 20 倍)→ 铺满全世界
- 世界自适应引入的 TDZ 错误

## [0.9.6] — 2026-08-29

### Fixed
- **真浏览器黑屏(重要)**:grid 力核 9 个 storage buffer 超过默认每阶段上限 8,
  有头环境直接判管线无效。`GpuContext` 现按适配器能力申请
  `maxStorageBuffersPerShaderStage` 等上限;管线创建包 `pushErrorScope`,
  此类错误显式抛出而非静默黑屏
- harness:支持绝对 URL;新增 `Log.enable` 浏览器日志捕获与 `location.href` 超时诊断;
  新增 `scripts/diag-dev.mjs` 诊断工具

详见 [validation/11](docs/validation/11-s12-headless-incident.md)。

## [0.9.0] — 公测就绪

### Added
- `wgpu-kit/three` 互通:快照式 `threePoints(sim, THREE)`(零依赖,任何渲染器可用;零拷贝 TSL 路径列入后续)
- 环境检测页 `detect.html`:WebGPU 逐级诊断 + 人话修复建议
- 库构建:`npm run build` 产出三入口 ESM + 声明文件,自动核对体积预算

### Bench
- core gzip **5.34 kB**(预算 <8);core+particles **10.27 kB**(预算 <15)

## [0.4.0] — 2026-08-29

### Added
- **grid 模式(计数排序 spatial hash)**:counts → 单 workgroup 分块前缀和 → scatter → 3×3 邻域力计算,每帧同一 encoder 四遍
- 基准页 `tests/gpu/bench.html` 与 [benchmarks.md](docs/benchmarks.md)
- `sim.stats()` 运行统计

### Changed
- **默认 mode 由 tiled 改为 grid**(数据驱动)

### Fixed
- WGSL:i32/u32 clamp 混型;u32×i32 散列乘法
- 基准方法学:tick 为 fire-and-forget,必须每帧 `queue.onSubmittedWorkDone()` 同步(否则测到的是 CPU 编码时间)

### Bench
- grid@16k **0.54ms** vs tiled 3.62ms(6.7×);grid@131k **0.89ms/帧**;grid@262k 0.77ms;rMax=0.05
- tiled O(N²) 墙实测:66k 时 28.14ms/帧

## [0.3.0] — 2026-08-28

### Added
- `particles(config)` 领域包:4 预设 + random 力矩阵(种子可复现)、species/velocity 着色、wrap/clamp 边界、`setForces`/`setParams` 热更新、`snapshot()` 序列化
- playground:参数面板 + URL 双向同步 + `?verify=N` 探针模式(demo 即验证)
- tiled 模式(workgroup 共享内存分块 + 距离平方 early-out)

### Fixed
- workgroupBarrier uniform control flow:越界线程必须参与 barrier 循环,只在写入处 guard
- harness 僵尸进程事故:Edge 启动器早退 + fire-and-forget 清扫 → 178 个僵尸渲染进程抢 GPU;三保险清理

### Bench
- playground 16k tiled 52.6fps(热节流会话;清凉会话 128fps)

## [0.2.0] — 2026-08-28

### Added
- **elementKernel**:descriptor 式声明(state/inputs/uniforms),uniform 自动对齐打包、count 注入与越界保护、bind group 缓存、编译错误行号映射回用户代码
- `Buffer`(内置 staging 读回)/ 泛型 `PingPong` / `rawKernel` 逃生舱 / `GpuContext` 单例
- 单元测试 20 项(codegen 为纯函数);GPU 冒烟页 8 探针

### Changed
- 用户函数固定命名 `userFn`(冒烟测试踩中 `name+'Fn'` 拼接的脆弱性)

### Fixed
- Dawn/Edge 的 `getCompilationInfo().lineNum` 实测为 1-based

### Bench
- 同等任务样板消失率:裸写 ~180 行 → 用库 ~30 行
- GPU 冒烟 8/8 @ nvidia/lovelace;库 gzip 体积预算核对通过

## [0.1.0] — 2026-08-28

### Added
- Phase 0 裸 WebGPU spike:粒子生命(零抽象,311 行中 87% 为仪式代码——库的设计靶子)
- 验证设施 `scripts/verify.mjs`:零依赖 mini-CDP(puppeteer-core 与 Edge 151 不兼容,已移除)+ stderr 退化路径 + 截图 + 超时诊断
- 立项文档体系:章程/调研/架构(ADR)/API 设计/路线图/版本约定

### Bench
- spike:n² @8192 = 132fps(基线会话,RTX 4060,真 GPU 无头验证)

## [0.0.1] — 2026-08-28

- 立项文档基线:使命、非目标、成功指标、竞品调研、路线图、版本阶梯
