# Changelog

## 2.0.0 (unreleased — 本地提交,未发布)

主题:**可组合计算**。从"每个功能都能单独跑"升级为"功能能组成计算链,数据常驻 GPU,行为有验证背书"。

### 破坏性变更(Breaking)

- **删除演示包**:`wgpu-kit/life`、`wgpu-kit/fields`、`wgpu-kit/image` 不再存在(共 1767 行演示代码)。需要演示源码请 checkout `v1.1.3` tag。`react` / `three` / `media` / `observe` / `vite` 入口不受影响。
- **kernel 编码合同**:`ElementKernel` / `RawKernel` 新增 `prepare()` 与 `encode(encoder, …)`;`run()` 行为兼容 v1(= prepare + encode + 内部提交)。要把多个 kernel 组进同一条计算链,对每个 kernel `await prepare()` 后逐个 `encode(encoder, …)`,由你决定提交时机。未 prepare 就 encode 会抛 `UsageError`。
- **`NeighborGrid`**:新增 `prepare()` / `encode(encoder, pos)`;`update(pos)` 行为不变。
- **pack 注册表**:`pack.ts` 的 `listPacks`/`getPack` 更名 `listUserPacks`/`getUserPack`(只含用户注册);合并内置包的 `listPacks`/`getPack` 由根入口导出。顶层副作用清零,与 `"sideEffects": false` 不再冲突。
- **uniform 打包**:值类型扩展为 `number | {x, y, z?, w?}`(vec2/3/4);此前只支持标量。

### 新增(Added)

- **core 原语层**(`wgpu-kit` 根入口 `createScan` / `createReduce`):
  - `scan`:u32 前缀和,双档自动切换(N≤65536 单 workgroup 分块循环;之上三级流水,以 pass 边界保证跨 workgroup 可见性),exclusive/inclusive 双语义。8 类边界探针(空输入/非 2 幂/档位边界 65536±1/70000/全零/全一/重复执行)对 CPU **位一致**。
  - `reduce`:`sumInto`(结果常驻 GPU,可被后续 kernel 消费)+ `sum`(读回糖),位一致。
- **`GpuContext.adopt(device)`**:接入调用方自有 GPUDevice(TypeGPU 互操作桥:`tgpu.init()` 设备 → `unwrap` → adopt),全库单例随之运行于接入设备。
- **uniform 向量化**:`vec2f/vec2i/vec2u/vec3f/vec4f` 字段打包,值形如 `{x, y, z?, w?}`。
- **探针扩容**:smoke 增 adopt-device / vector-uniform / schema-struct-compiles / setparams-dt-effective / comment-field-ignored / gpu-texture-roundtrip;新增 primitives 页 27 项。

### 修复(Fixed)

- **渲染双缓冲相位**:`useAB ? pp.other : pp.current` 双翻转混用,奇数帧渲染上一帧状态(序列 1,1,3,3…)。恒渲染 swap 前的 `pp.other`。
- **wgslStruct 生成非法 WGSL**:成员属性后置(`home: @size(16) vec3f`)不合语法,改属性前置;生成的 struct 以 storage+uniform 双语义过真实 WGSL 编译器(探针)。
- **setParams({dt}) 死参数**:tick 读 `cfg.dt` 而 setParams 写 `phys.dt`,快照变了行为不变。dt 单一事实来源改为 `phys`。
- **timeGpu 计时失效**:双时间戳写在自己的 encoder、fn 夹在 await 中——队列顺序为 fn 先行、双时间戳背靠背,测得 Δ≈0。改三段提交。
- **sideEffects 冲突**:见上(破坏性变更第 4 条)。
- **adapter 被 GC**:GpuContext 持有 GPUAdapter 强引用——此前 adapter 被回收后设备异步操作随机 abort "A valid external Instance reference no longer exists"(无头 SwiftShader 重负载页面必现)。
- **getCompilationInfo 降级**:SwiftShader 在重负载页面对新模块抛 "Instance dropped",降级为跳过编译信息检查(错误仍由 uncapturederror 兜底),健康环境行为不变。
- **shader 模块去重**:同 code 模块复用,消除相同代码二次编译的缓存命中路径问题。
- **自动布局未用绑定**:声明未用的字段不再塞进 bind group(此前会校验失败且静默吞掉,核不生效);注释里提及字段名不再算"已使用"。

### 性能(Performance)

- scan 原语化迁移的实测代价:grid@200k 15.48 → 15.57 ms/frame(+0.6%,门限 3%),同分支同会话基线。
- bench 双口径(同步延迟 / 3 帧在途管线吞吐)重新生成。

### 校验(Verification)

- 全量探针:smoke 16/16 · primitives 27/27 · grid-debug 19/19 · bench 33/33 · vitest 27/27 · tsc 零错误。
- CI:verify + gpu-probes(SwiftShader)双 job 全绿。

## 1.1.3

- 渲染双缓冲相位 / setParams dt / 注释盲区使用分析 / wgslStruct 属性(同上,首次修复)+ 3 项行为级回归探针。
- CI gpu-probes(SwiftShader)上线;bench 双口径;grid-debug lite 模式。

## 1.1.2

- 四项外部评审修复:CI GPU 探针、双口径基准与文档、defineSchema 类型层、definePack 平台。
- 修复:adapter 强引用(Instance-dropped 根因)、shader 模块去重、getCompilationInfo 降级、自动布局未用绑定过滤、smoke 英文文案断言。

## 1.1.1

- **grid 扫描截断修复**:此前每帧只扫前 256 格,其余格粒子受力恒零(水平冻结带);扫描核重写为单 workgroup 分块循环。
- **cellFill 语义修复**:scan 写 fill=start+count 而 scatter 又原子 +1,力核区间翻倍并混入相邻格粒子(系统性力偏差)。改填充游标语义。
- gridSizeOf ceil→floor:格宽不再小于交互半径。
- 官网重新部署(此前线上一直是 v1.0.0 构建)。

## 1.1.0 / 1.1.1 之间

- CI gpu-probes(SwiftShader)、探针体系扩充、BENCHMARK 双口径、TypeGPU 竞品分析与文档重写启动。

## 1.0.x

- 首个稳定版:elementKernel / Buffer / PingPong / rawKernel / particles(n2/tiled/grid)/ react/three/media/observe/vite 入口。
