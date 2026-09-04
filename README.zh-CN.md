# wgpu-kit

> **Browser GPGPU middle layer. 132,000 particles at 142fps — in 5 lines of code.**
> 浏览器 GPGPU 中间层:WebGPU 计算的全套样板,打包成两层简单 API。

**状态:公测就绪(v0.9.5)· 演示:[playground](playground/index.html) · [生命合集](playground/life.html) · [画廊](playground/gallery.html)**
 · **[API 参考(中文)](docs/API.zh-CN.md)** · [API Reference (English)](docs/API.md)

## Quick start

```bash
npm i wgpu-kit   # 首次发布前:git clone + npm run build
```

**5 行,10 万粒子**(领域包,开箱即用):

```ts
import { particles } from 'wgpu-kit';

const sim = await particles({ count: 100_000, forces: 'cells' });
await sim.attach(canvas);
function frame() { sim.tick(); requestAnimationFrame(frame); }
frame();
```

**自定义 GPU 计算**(kernel 核心,写"单个元素怎么变"就行):

```ts
import { elementKernel, Buffer } from 'wgpu-kit';

const pos = await Buffer.create('vec2f', 100_000);
const vel = await Buffer.create('vec2f', 100_000);

const integrate = elementKernel({
  state: { pos: 'vec2f' },
  inputs: { vel: 'vec2f' },
  uniforms: { dt: 'f32' },
  code: `
    fn userFn(idx: u32, dt: f32) {
      pos[idx] = (pos[idx] + vel[idx] * dt) * 0.99;
    }
  `,
});
await integrate.run({ pos, vel }, { dt: 0.02 });
```

设备/缓冲/管线/绑定/dispatch/双缓冲/读回/错误行号映射——全部由库承担。

## 包家族

| 入口 | 一句话 |
| --- | --- |
| `wgpu-kit` | elementKernel 核心 + Buffer/PingPong/rawKernel |
| `wgpu-kit/particles` | 粒子生命:力矩阵预设/随机宇宙、grid 邻域、热更新、快照分享 |
| `wgpu-kit/life` | 人工生命:图灵斑图 / 粘菌 / Boids / 软体触手 |
| `wgpu-kit/fields` | 向量场平迹(数据可视化) |
| `wgpu-kit/image` | GPU 滤镜管线(blur/sharpen/edge/…) |
| `wgpu-kit/react` | `<ParticleCanvas />` |
| `wgpu-kit/three` | three.js 快照互通 |
| `wgpu-kit/media` | 画布录制(一键产视频素材) |
| `wgpu-kit/vite` | kernel 热重载插件(WGSL 改动毫秒级生效) |

## 数字(可复现,非营销)

| 指标 | 数值 | 环境 |
| --- | --- | --- |
| 粒子模拟(端到端) | **131,072 粒子 @ 142fps** | RTX 4060 Laptop,playground 实测 |
| 粒子计算(纯 GPU) | grid@131k = **0.89 ms/帧** | 同上,headless 基准 |
| 邻域算法对比 | grid 比 O(N²) tiling 快 **6.7×**@16k,近似 O(N) | 同会话基准 |
| 库体积 | core gzip **5.34 kB**;+particles **10.27 kB** | gzip -c |

完整基准数据与复现命令:[docs/benchmarks.md](docs/benchmarks.md)。

## 为什么

浏览器里用 GPU,今天只有四条路:纯 JS(慢)、裸写 WebGPU(~150 行仪式代码)、three.js TSL(锁引擎)、gpu.js(WebGL 时代,停滞)。"**简单 + 快 + 引擎无关**"的专用 WebGPU 计算库是空位。

## 三条设计铁律

1. **第二层 5 分钟出活,第一层不封顶**——`rawKernel` 与原生 `GPUBuffer` 逃生舱常开;
2. **错误说人话**——WGSL 编译失败精确映射回你的代码行;
3. **基准即文档**——所有宣传数字可复现,性能预算进 CI(`npm run build` 自动核对体积)。

## 支持矩阵

| 浏览器 | 状态 |
| --- | --- |
| Chrome / Edge 113+(含无头) | ✅ 本项目全部验证在此完成(RTX 4060,D3D 后端) |
| Safari 18+ | 🔶 WebGPU 可用即应工作;未在本项目环境实测,issue 欢迎 |
| Firefox | 🔶 同上 |
| WebGL2 / 无 WebGPU | ❌ 不做降级(ADR-1);打开 [detect 页](playground/detect.html)可诊断 |

## 项目方法论

这不是一个"写完就算"的仓库:**每个阶段完成后,由无头浏览器在真实 GPU 上运行结构化探针验证,验证日志、路径对比、事故复盘全部入档**。从裸 WebGPU spike 到 13 万粒子,共 6 个阶段、7 个版本标签、38 项自动化探针。

## 许可

[MIT](LICENSE)
