# wgpu-kit 交接文档（AI 接手必读）

> **交接日期：** 2026-09-30 · 基线：`main` @ `306a7a7`（v2.0 已合并推送）
> **阅读对象：** 接手本项目的 AI 助手。读完本文即可安全工作；文中所有"坑"都是真实发生过的，不是理论风险。

---

## 一、项目是什么

**wgpu-kit**：浏览器 WebGPU 计算运行时（TypeScript，零运行时依赖）。用户描述计算过程，库负责数据、执行、验证。

**定位（v2.0 已收窄）**：可验证的 GPU 计算原语与数据常驻运行时。不做 shader 语言层（TypeGPU 的仗）、不做 3D 引擎、不做 ML。

**旗舰**：`packs/particles`——200k 粒子生命模拟 @ 120fps（n2/tiled/grid 三算法，grid 为 O(N) 计数排序空间哈希）。

## 二、当前状态（接手时的地面实况）

| 项 | 状态 |
|---|---|
| `main` 分支 | `306a7a7`，v2.0 已合并**并已推送**，CI 双 job 全绿 |
| `v2` 分支 | 已合并，可删可留 |
| npm | **2.0.0 尚未发布**（发布时 npm 凭证过期，用户需重新 `npm login` + OTP）|
| gh-pages 网站 | 仍是 **v1.1.2 旧构建**（含 life.html 等已删演示页）——用户明确表示**演示页自己重做，AI 不要动**，统一展示站是 Phase F |
| 五轮外部审查 | 全部闭环，最终 PASS-with-notes，材料在 `v2-review/` |

## 三、代码地图（文件级作用）

### `src/core/`（1090+ 行基础设施，**最值钱的资产，禁止重写**）

| 文件 | 作用 | 关键点 |
|---|---|---|
| `context.ts` | GpuContext 单例；设备获取 | `adopt(device)` 接入外部设备（TypeGPU 互操作桥，必须先于首次 get()）；**必须持有 adapter 强引用**（否则被 GC 后异步操作随机 abort，无头环境必现）；requestDevice 请求 `timestamp-query` 特性 |
| `kernel.ts` | elementKernel：用户只写 `userFn` 单元素函数，库生成全部 WGSL 样板 | prepare/encode/run 三层合同；静态使用分析（剥注释→剥 struct→剥成员访问→userFn 可达性闭包→token 匹配）；encode-once-per-submit guard；错误行号映射回用户代码 |
| `buffer.ts` | Buffer 类型化封装 | staging readback、vec3 步长 padding、`.gpuBuffer` 逃生舱 |
| `pingpong.ts` | 双缓冲 | current/other + swap |
| `raw.ts` | rawKernel 逃生舱 | 用户写全 WGSL，库只管管线与提交；同样三层合同 |
| `schema.ts` | defineSchema 类型化层（**已冻结，不再与 TypeGPU 竞争**） | 编译期行类型 + WGSL struct 代码生成（属性在成员名**前**）+ 逐字段 TypedBuffer |
| `pack.ts` | pack 平台契约（**已冻结**） | definePack/registerPack/listUserPacks；内置名保留（reserveBuiltInName）；内置包由根入口静态合成（无顶层副作用） |
| `primitives/scan.ts` | u32 前缀和，双档 | N≤65536 单 workgroup 分块循环；之上三级流水（scan_block/scan_bases/add_bases），**跨 workgroup 必须独立 pass**；encode-once guard |
| `primitives/reduce.ts` | u32 求和 | sumInto（GPU 常驻一等公民）+ sum（私有 scratch 读回，并发安全）；dispatch 上限 65535 校验 |
| `layout.ts` | uniform 布局规划 | 标量+向量(vec2/3/4)打包；UniformValue 类型 |
| `shader.ts` | createShaderModuleChecked | 编译信息获取失败降级 + 模块去重（SwiftShader 缓存命中路径会抛 "Instance dropped"） |
| `errors.ts`/`codes.ts` | 错误类与错误码 | UsageError/CompileError/WebGPUUnavailableError |

### `src/primitives/` 与 `src/packs/`

| 路径 | 作用 |
|---|---|
| `src/primitives/` | core 原语层（scan/reduce）——所有需要排序、归约的算法的地基 |
| `src/packs/particles/` | 旗舰包：config（参数解析）、wgsl（tiled 力核）、grid.ts（counts/post/scatter/force 四 kernel + 邻域）、render.ts（实例化渲染）、presets.ts（力矩阵预设）、index.ts（编排） |
| `src/packs/grid/` | 通用 NeighborGrid 包（counts → scan原语 → post → scatter） |
| ~~`src/packs/life,fields,image`~~ | **已于 v2.0 删除**（演示负债），源码见 `v1.1.3` tag |

### 胶水层（保留）与测试

| 路径 | 作用 |
|---|---|
| `src/react/` `src/interop/three.ts` `src/media.ts` `src/observe.ts` `src/vite.ts` | React 绑定 / three 快照互通 / 画布录制 / timeGpu+watchDevice / vite 热重载 |
| `tests/gpu/smoke.ts` 等 | 5 个 GPU 探针页（smoke 24 · primitives 31 · ngrid 6 · grid-debug 19 · bench），经 `scripts/verify.mjs` 驱动真机/headless 浏览器执行 |
| `tests/layout.test.ts` 等 | vitest CPU 单测（29 项） |

## 四、验证体系（本项目的护城河，改动必经）

```bash
npx tsc --noEmit          # 零错误
npx vitest run            # 29/29
npm run bundle:tests      # 重打探针 bundle（改 tests 后必须）
npm run build             # preservedModules 构建 + gzip 预算断言(<27)
node scripts/verify.mjs tests/gpu/smoke.html tests/gpu/primitives.html \
  tests/gpu/ngrid.html tests/gpu/grid-debug.html --timeout=180000
# 预期:24/24 · 31/31 · 6/6 · 19/19(需真机 Chrome/Edge)
```

- 探针全部对 **CPU 参考做位一致断言**，不是"看着像就对"
- 无头 CI 用 SwiftShader（配方在 ci.yml：`--enable-unsafe-webgpu --enable-unsafe-swiftshader --use-angle=swiftshader --enable-features=Vulkan`，失败自动换 `--use-angle=vulkan` 重试）
- 已知缺口（文档已声明，勿当新发现）：CI 上没跑过 timeGpu 真机数值、timestamp-query 需要 Dawn flag 部分环境不可用

## 五、血泪坑清单（每条都真实发生过，接手前背下来）

1. **同一 compute dispatch 内跨 workgroup 无内存可见性保证**——多 workgroup 协作算法（scan/归约）必须拆独立 pass。scan 因此返工三次。
2. **`layout:'auto'` 只含入口点静态使用的绑定**——bind group 多给一个 binding = 校验失败且**异步静默吞掉**（表现为核不生效、数据纹丝不动）。静态使用分析在 kernel.ts（剥注释/struct/成员访问 + 可达性闭包）；已知残余限制：局部 `let` 遮蔽资源名仍误判（已文档化，规避=改名）。
3. **同一模块内两个入口点不得重复声明同一 binding 号**——WGSL 校验直接报错。
4. **adapter 必须强引用**——被 GC 后设备异步操作随机 abort "A valid external Instance reference no longer exists"（无头 SwiftShader 重负载必现）。
5. **SwiftShader 的 getCompilationInfo 缓存命中路径会抛 "Instance dropped"**——shader.ts 已做降级 + 模块去重。
6. **写文件的 shell heredoc 会静默失败**（本机 Git Bash 实测多次）——凡脚本写文件，**落盘后必须 grep 复查**。同型事故至少三次。
7. **npm 凭证会过期 + publish 需要 OTP**——代理环境变量（HTTP_PROXY 等）残留也会导致 401/404，先清。
8. **性能口径**：同步延迟与 3 帧在途管线吞吐是两个数，别混（见 docs/BENCHMARK.md 头部说明）。
9. **encoder 在 pass 打开期间被锁定**——scan.encode 这类"自管 pass"的 API 不能包进另一个打开的 pass 里调用。
10. **strided 分治对 reduce 成立、对 scan 不成立**——前缀必须跟随线性索引（scan_block 用连续持有）。

## 六、待办事项（按优先级）

1. **发布 npm 2.0.0**（被凭证过期阻塞）：用户 `npm login` → `npm publish`（OTP）→ 发布后拉 tarball 做内容级核验（schema/pack/primitives/adapter 修复都在包里）
2. **Phase F · 统一展示站**：主页+文档+示例融合的暗色站点（风格参考 vgpu.sh，内容独属于本项目：200k 粒子实况 hero）。**演示页用户自己做，AI 只做基建**
3. **v2.x 备忘**（不承诺排期）：kernel DAG、indirect dispatch、声明式不变量、确定性契约、跨厂商性能矩阵（Apple M/Adreno/Intel）、per-pass 计时、邻域网格边界语义文档化
4. **用户侧遗留**：gh-pages 线上还是 v1.1.2 旧站（含已删演示页），随 Phase F 一并解决

## 七、工作纪律（用户明令）

- **推送远程 / 发布 npm 必须先经用户审核批准**
- 不新增演示 pack；不重写 core；不动 core 的既有探针
- 每个修复必须带**行为级回归探针**（对 CPU 参考位一致/断言行为，不是字符串比较）
- 凡发现"注释说修好了"的代码，先跑探针验证再说

## 附录 · 环境

- Windows 10 + Git Bash；Node 24 / npm 11；仓库 `D:\mynpm\wgpu-kit-release`
- 真机 GPU：RTX 4060 Laptop / Edge 153（无 timestamp-query 暴露）
- npm 代理残留：操作 npm 前清 `HTTP_PROXY/HTTPS_PROXY`
