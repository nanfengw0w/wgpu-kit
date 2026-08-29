# wgpu-kit API 参考

> 浏览器 GPGPU 中间层。本页是全部公开接口的参考文档,风格对齐 three.js docs。
> 版本:v0.9.10 · 需 WebGPU(Chrome/Edge 113+、Safari 18+)· 零运行时依赖

**入口总览**

| 入口 | 内容 |
| --- | --- |
| [wgpu-kit](#wgpu-kit--kernel-核心) | GpuContext · Buffer · elementKernel · PingPong · rawKernel · 错误类 |
| [wgpu-kit/particles](#wgpu-kitparticles--particles) | 粒子生命模拟 |
| [wgpu-kit/life](#wgpu-kitlife--人工生命) | 图灵斑图 · 粘菌 · Boids · 软体触手 |
| [wgpu-kit/fields](#wgpu-kitfields--flow) | 向量场平迹 |
| [wgpu-kit/image](#wgpu-kitimage--applyimage) | GPU 滤镜管线 |
| [wgpu-kit/react](#wgpu-kitreact--particlecanvas) | `<ParticleCanvas />` |
| [wgpu-kit/three](#wgpu-kitthree--threepoints) | three.js 互通 |
| [wgpu-kit/media](#wgpu-kitmedia--canvasrecorder) | 画布录制 |
| [wgpu-kit/vite](#wgpu-kitvite--wgpukithotreload) | kernel 热重载插件 |

---

# wgpu-kit · kernel 核心

## GpuContext

全库共享的 GPU 设备上下文。惰性申请 adapter/device,自动按适配器能力申请存储缓冲上限。

### 静态方法

##### GpuContext.get ( ) : Promise\<GpuContext\>

获取(或创建)全局唯一上下文。失败时缓存被清除,修复环境后可重试。

##### 实例属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| .device | GPUDevice (readonly) | 原生 GPUDevice(逃生舱:可直接创建自定义资源) |
| .adapterInfo | string (readonly) | 适配器描述,如 `nvidia / lovelace` |

##### 实例方法

##### .sync ( ) : Promise\<void\>

等待队列中全部已提交的 GPU 工作完成。测试或读回数据前使用。

##### .lost : Promise\<GPUDeviceLostInfo\> (readonly)

设备丢失时 reject,可 await 做清理。

---

## Buffer

显存数组的类型化封装。负责字节计算、usage 管理、写入校验与 staging 读回。

### 构造

不要直接 `new Buffer`,使用静态工厂:

##### Buffer.create ( kind : ScalarKind, length : number ) : Promise\<Buffer\>

创建显存数组。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| kind | ScalarKind | 元素类型,见下方类型表 |
| length | number | 元素数量(正整数) |

抛出:`UsageError`(长度/类型非法)。

**ScalarKind 类型表**

| kind | WGSL | 字节/元素 | 对应 TypedArray |
| --- | --- | --- | --- |
| `f32` | f32 | 4 | Float32Array |
| `i32` | i32 | 4 | Int32Array |
| `u32` | u32 | 4 | Uint32Array |
| `vec2f` | vec2\<f32\> | 8 | Float32Array |
| `vec2i` | vec2\<i32\> | 8 | Int32Array |
| `vec2u` | vec2\<u32\> | 8 | Uint32Array |
| `vec3f` | vec3\<f32\> | 12(对齐 16) | Float32Array |
| `vec4f` | vec4\<f32\> | 16 | Float32Array |

### 属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| .kind | ScalarKind (readonly) | 元素类型 |
| .length | number (readonly) | 元素数量 |
| .gpuBuffer | GPUBuffer (readonly) | 原生句柄(逃生舱:可交给任何引擎/管线) |

### 方法

##### .write ( data : TypedArray ) : void

CPU → GPU 写入。类型或分量数不匹配抛 `UsageError`。

##### .read ( ) : Promise\<TypedArray\>

GPU → CPU 读回。内部 staging buffer + `mapAsync` 由库管理,调用方无需同步。

##### .destroy ( ) : void

释放显存。销毁后不得再使用。

### 代码示例

```ts
import { Buffer } from 'wgpu-kit';

const pos = await Buffer.create('vec2f', 100_000);
pos.write(new Float32Array(200_000));          // 100_000 × vec2
const back = await pos.read();                  // Float32Array(200_000)
console.log(pos.gpuBuffer);                     // 原生 GPUBuffer
```

---

## elementKernel

**本库的核心 API。** 声明式创建 compute kernel:你只写"单个元素如何演化"的 WGSL 函数,
workgroup/dispatch/双缓冲绑定/uniform 打包/count 越界保护全部由库生成。

### 代码示例

```ts
import { elementKernel, Buffer } from 'wgpu-kit';

const pos = await Buffer.create('vec2f', 100_000);
const vel = await Buffer.create('vec2f', 100_000);

const integrate = elementKernel({
  name: 'integrate',
  state:   { pos: 'vec2f' },
  inputs:  { vel: 'vec2f' },
  uniforms: { dt: 'f32', friction: 'f32' },
  code: `
    fn userFn(idx: u32, dt: f32, friction: f32) {
      pos[idx] = (pos[idx] + vel[idx] * dt) * friction;
    }
  `,
});

await integrate.run({ pos, vel }, { dt: 0.02, friction: 0.914 });

// 热重载:替换逻辑(编译失败自动保持旧版)
await integrate.replace(`
  fn userFn(idx: u32, dt: f32) {
    pos[idx] = pos[idx] * 2.0;
  }
`);
```

### 构造

##### elementKernel ( spec : ElementKernelSpec ) : ElementKernel

| spec 属性 | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| name | string | 调试名(错误信息中出现) | `'kernel'` |
| state | Record\<string, ScalarKind\> | **读写**缓冲字段 | `{}` |
| inputs | Record\<string, ScalarKind\> | **只读**缓冲字段 | `{}` |
| uniforms | Record\<string, ScalarKind\> | uniform 标量(仅 f32/i32/u32) | `{}` |
| workgroupSize | number | workgroup 大小,1..512 | `64` |
| code | string | 用户 WGSL 函数,**必须命名 `userFn`** | 必填 |

**code 契约(重要):**

1. 函数必须命名为 **`userFn`**(这是唯一约定,库按此生成调用);
2. 第一个参数固定 `idx: u32`;
3. 其后参数按 `uniforms` 声明顺序自动注入;
4. `state`/`inputs` 字段名在函数体内即数组,直接 `name[idx]` 访问;
5. `count` 是保留名(uniform 由库自动注入并做越界保护);
6. state 与 inputs 的字段名不能重复。

抛出:`UsageError`(描述非法/保留名/重复字段/非法 workgroupSize)。

### 属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| .name | string (readonly) | 调试名 |
| .source | string (readonly) | 生成的完整 WGSL(调试用) |
| .uniformLayout | UniformLayout (readonly) | uniform 布局(字段/偏移/总大小) |
| .workgroupSize | number (readonly) | 实际 workgroup 大小 |

### 方法

##### .run ( resources, uniforms? ) : Promise\<void\>

执行一次。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| resources | Record\<string, Buffer\> | state/inputs 全部字段 → Buffer 映射 |
| uniforms | Record\<string, number\> | uniform 标量值(须与声明一致) |

抛出:`UsageError`(缺资源/类型不匹配/长度不一致)、`CompileError`(WGSL 编译失败,**行号映射回你的 code**)。

##### .replace ( code : string ) : Promise\<void\>

热重载:替换 `code` 并重建管线。**先编译后切换**:编译失败抛 `CompileError`,内核保持旧版不受影响;成功则清空绑定缓存,下一次 `run` 即用新逻辑。

##### .destroy ( ) : void

释放管线与 uniform 缓冲(不影响传入的 Buffer)。

---

## PingPong

迭代式模拟的双缓冲管理。读"当前侧"、写"另一侧",帧末 `swap()` 翻转,
避免读写冲突——粒子/流体/元胞自动机类模拟的刚需抽象。

### 构造

##### PingPong.create ( kinds : Record\<string, ScalarKind\>, length : number ) : Promise\<PingPong\>

创建 A/B 两组同构缓冲。

```ts
const pp = await PingPong.create({ pos: 'vec2f', vel: 'vec2f' }, 100_000);
```

### 属性与方法

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| .current | Record\<K, Buffer\> (readonly) | 当前帧数据侧(渲染/读回用) |
| .other | Record\<K, Buffer\> (readonly) | 另一侧(kernel 写入目标) |
| .swap ( ) | void | 翻转当前侧 |
| .runWith ( fn ) | Promise\<void\> | 以 (写侧, 读侧) 调用 fn 后自动 swap |
| .destroy ( ) | void | 销毁全部缓冲 |

### 代码示例

```ts
const pp = await PingPong.create({ pos: 'vec2f' }, 1000);

await pp.runWith(async (write, read) => {
  await integrate.run({ out: write.pos, src: read.pos });
});
// 此后 pp.current 即最新数据
```

---

## rawKernel

完整 WGSL 逃生舱: yourself 写全部 WGSL(含 binding 声明与入口),
库只负责管线创建与提交。适合 elementKernel 表达不了的场景。

### 构造

##### rawKernel ( code : string, entryPoint? : string, label? : string ) : RawKernel

| 参数 | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| code | string | 完整 WGSL | 必填 |
| entryPoint | string | 入口函数名 | `'main'` |
| label | string | 调试标签 | `'rawKernel'` |

##### .run ( entries : GPUBindGroupEntry[], workgroups : number ) : Promise\<void\>

`entries` 完全由你声明(缓冲/采样器等);`workgroups` 为 X 维工作组数。

### 代码示例

```ts
const double = rawKernel(`
  @group(0) @binding(0) var<storage, read_write> data: array<u32>;
  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= arrayLength(&data)) { return; }
    data[gid.x] = data[gid.x] * 2u;
  }
`);
await double.run([{ binding: 0, resource: { buffer: myBuffer.gpuBuffer } }], 16);
```

---

# wgpu-kit/particles · particles

粒子生命模拟(Particle Life):4 物种力矩阵驱动,支持三种邻域算法、
双着色模式、热更新与快照分享。内置 GPU 渲染,开箱即用。

## 代码示例

```ts
import { particles } from 'wgpu-kit/particles';

const sim = await particles({ count: 100_000, forces: 'cells' });
await sim.attach(document.querySelector('canvas'));

function frame() {
  sim.tick();
  requestAnimationFrame(frame);
}
frame();
```

## 构造

##### particles ( config? : ParticlesConfig ) : Promise\<ParticlesSim\>

### ParticlesConfig

| 属性 | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| count | number | 粒子数(1..1,000,000) | `8192` |
| forces | 'cells' \| 'snakes' \| 'orbitals' \| 'viruses' \| 'random' \| ForceMatrix | 力矩阵预设或自定义 16 元数组(行=施加者,列=承受者,正=吸引) | `'cells'` |
| mode | 'grid' \| 'tiled' \| 'n2' | 邻域算法。grid = 计数排序空间哈希(推荐,近似 O(N));tiled = 分块暴力; n2 = 全量暴力(≤3 万) | `'grid'` |
| color | 'species' \| 'velocity' | 着色:按物种 / 按速度 | `'species'` |
| bounds | 'wrap' \| 'clamp' | 边界:环绕 / 夹紧 | `'wrap'` |
| seed | string \| number | 随机种子(初始分布 + random 矩阵),可复现 | `'wgpu-kit'` |
| rMax | number | 交互半径(世界单位),默认 0.12 | `0.12` |
| beta | number | 力函数近程/远程分界(0..1) | `0.3` |
| forceFactor | number | 力强度倍率 | `10` |
| frictionHalfLife | number | 摩擦半衰期(秒) | `0.04` |
| dt | number | 时间步长(秒) | `0.02` |
| pointSize | number | 点尺寸(裁剪空间比例) | `0.004` |
| maxNeighbors | number | 每粒子候选上限(极端抱团保险丝) | `32768` |

**ForceMatrix**:长度 16 的数组,`m[i*4+j]` = 物种 i 对物种 j 的作用力(−1..1)。
预设:`cells`(经典细胞)、`snakes`(蛇群)、`orbitals`(轨道)、`viruses`(捕食)、
`random`(由 seed 生成)。

**世界与缩放**:世界大小随 `count` 自适应(面积 ∝ count,密度恒定),
相机自动拉远——任意规模下每粒子的邻居数与受力一致,大规模不改变物理。

## 属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| .config | ResolvedConfig (readonly) | 解析后的完整配置(含有效物理参数) |

## 方法

##### .attach ( canvas : HTMLCanvasElement ) : Promise\<void\>

绑定渲染目标并创建渲染管线。只需调用一次。

##### .tick ( dtMultiplier? : number ) : void

推进一帧(计算 + 渲染)。`dtMultiplier` 支持 0(暂停)、<1 慢放、>1 快放。

##### .setForces ( forces ) : void

热更新力矩阵(预设名或自定义数组),立即生效,无需重建。

##### .setParams ( params ) : void

热更新物理参数 `{ rMax?, beta?, forceFactor?, frictionHalfLife?, dt? }`。
注意:`rMax` 变化在 grid 模式下会触发网格重建(约百毫秒)。

##### .snapshot ( ) : string

返回可序列化的配置 JSON——与 `?p=…&m=…&s=…` URL 参数互通,用于分享。

##### .stats ( ) : { fps : number; gpuErrors : number }

运行统计。`gpuErrors` 非 0 表示存在 GPU 校验错误(黑屏/异常先查这里)。

##### .buffers ( ) : { pos, vel, species }

当前帧数据缓冲(`Buffer` 实例,可 `read()`/接 three.js)。

##### .destroy ( ) : void

释放全部资源。此后 sim 不可用。

---

# wgpu-kit/life · 人工生命

四个独立的涌现模拟,接口同构:`attach(canvas)` / `tick()` / `stats()` / `destroy()`。
以下仅列差异部分,通用方法同 particles。

## turing ( config? ) : Promise\<TuringSim\>

Gray-Scott 反应扩散:两种化学物质自发长出珊瑚/细胞/斑纹。

| config | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| size | number | 网格边长(正方形) | `512` |
| preset | 'coral' \| 'mitosis' \| 'spots' \| 'waves' \| 'custom' | 参数预设 | `'coral'` |
| feed / kill | number | 自定义 f/k(preset 为 custom 时生效) | 随预设 |
| steps | number | 每帧迭代步数 | `12` |
| colormap | string | 'duotone'(默认)\| 'amber' \| 'ice' \| 'mono' | — |
| seed | string \| number | 初始扰动种子 | `'life'` |

| 额外方法 | 说明 |
| --- | --- |
| .sprinkle ( count? = 6 ) | 在随机位置撒扰动(救场/交互) |
| .sampleB ( ) : Promise\<Float32Array\> | 读回 B 物质浓度场 |

预设参数表:`coral` f=0.0545 k=0.062 · `mitosis` f=0.0367 k=0.0649 · `spots` f=0.03 k=0.062 · `waves` f=0.014 k=0.045。

## physarum ( config? ) : Promise\<PhysarumSim\>

粘菌:三触须感知信息素 → 转向 → 前进 → 沉积;信息素扩散衰减,菌丝网络自会长出。

| config | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| agents | number | 智能体数 | `100_000` |
| mapSize | number | 信息素图边长 | `1024` |
| sensorAngle / sensorDist / turnAngle / step | number | 感知与运动参数 | 0.5 / 0.012 / 0.45 / 0.003 |
| decay | number | 每帧衰减比例 | `0.06` |
| colormap | string | 默认 'amber' | — |

额外方法:`sampleTrail()` 读回信息素图。

## boids ( config? ) : Promise\<BoidsSim\>

Boids 鸟群:分离/对齐/聚集三规则,grid 邻域加速。

| config | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| count | number | 个体数 | `3000` |
| perception | number | 感知半径 | `0.05` |
| maxSpeed | number | 最大速度 | `0.012` |
| wSep / wAli / wCoh | number | 分离/对齐/聚集权重 | 1.6 / 1.0 / 0.8 |
| size | number | 三角尺寸 | `0.009` |

额外方法:`buffers(): { pos, vel }`。

## tentacles ( config? ) : Promise\<TentaclesSim\>

软体触手:Verlet 链 + 黄金角排布的游动锚点,重力与阻尼产生水母般漂移。

| config | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| chains / segments | number | 触手数 / 每条节数 | 48 / 64 |
| segLen / gravity / damping | number | 节间距 / 重力 / 阻尼 | 0.018 / 0.00035 / 0.985 |
| iterations | number | 每帧约束松弛次数 | `10` |
| thickness / colorCycle | number | 点尺寸基数 / 色相循环速度 | 0.006 / 0.35 |

---

# wgpu-kit/fields · flow

向量场平迹:粒子被解析向量场平流并沉积,流线自会浮现——风场/流场可视化的底图。

## 构造

##### flow ( config? : FlowConfig ) : Promise\<FlowSim\>

| config | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| count | number | 平流粒子数 | `131_072` |
| mapSize | number | 轨迹图边长 | `1024` |
| field | 'vortex' \| 'curl' \| 'twin' | 场类型:漩涡 / 湍流噪声 / 双涡 | `'curl'` |
| speed | number | 每帧移动距离 | `0.004` |
| decay | number | 每帧衰减 | `0.045` |
| deposit | number | 沉积量 | `1.0` |
| colormap | string | 'ice'(默认)\| 'amber' \| 'duotone' \| 'mono' | — |
| seed | string \| number | 种子 | `'flow'` |

### 方法

同构接口:`attach / tick / stats / sampleTrail / destroy`。

---

# wgpu-kit/image · applyImage

GPU 图像滤镜管线:source → 逐算子 ping-pong → target canvas。

## 构造

##### applyImage ( source, target, ops ) : Promise\<ApplyImageResult\>

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| source | HTMLCanvasElement \| HTMLImageElement \| ImageBitmap | 输入图像 |
| target | HTMLCanvasElement | 输出画布(WebGPU 后端) |
| ops | ImageOp[] | 算子流水线(按序执行) |

返回:`{ width, height, passes, readback(): Promise<Uint8Array> }`——
`readback()` 为 GPU 直读像素(RGBA,行按 256B 对齐),可用于断言与测试。

### ImageOp 算子表

| 算子 | 参数 | 说明 |
| --- | --- | --- |
| { op: 'grayscale' } | — | 灰度(Rec.709 亮度) |
| { op: 'invert' } | — | 反色 |
| { op: 'edge', amount? } | amount 默认 1 | Sobel 边缘 |
| { op: 'blur', radius? } | radius 1..4,默认 1 | 盒式模糊 |
| { op: 'sharpen', amount? } | amount 默认 1 | 3×3 锐化 |
| { op: 'brightness', value } | −1..1 | 亮度 |
| { op: 'contrast', value } | 0..2,1=不变 | 对比度 |

### 代码示例

```ts
const r = await applyImage(srcCanvas, outCanvas, [
  { op: 'blur', radius: 2 },
  { op: 'edge', amount: 1 },
]);
const px = await r.readback();   // Uint8Array
```

---

# wgpu-kit/react · ParticleCanvas

particles 包的 React 绑定。挂载即创建模拟 + rAF 循环,卸载即销毁(StrictMode 安全)。

## 属性(Props)

`ParticleCanvasProps` 继承 `ParticlesConfig` 全部字段(count/forces/mode/seed/…),
另加:

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| className | string | 透传给 canvas |
| style | CSSProperties | 透传给 canvas(默认 width/height 100%) |
| onReady | (sim: ParticlesSim) => void | 模拟就绪回调;命令式操作(setForces/录制)从这里拿 sim |

### 代码示例

```tsx
<ParticleCanvas key="u1" count={66_000} forces="cells" onReady={(s) => console.log(s.stats())} />
```

**约定**:config 变化请改 `key` 重建(声明式);命令式操作走 `onReady`。

---

# wgpu-kit/three · threePoints

three.js 快照式互通:每帧把模拟位置读回并写入 `BufferAttribute`,
适配任何 three 渲染器(WebGL/WebGPU)。

## 构造

##### threePoints ( sim : ParticlesSim, THREE : ThreeAPI, opts? ) : ThreePointsHandle

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| sim | ParticlesSim | 已创建的粒子模拟 |
| THREE | ThreeAPI | 你传入的 three 模块(最小表面:Points/BufferGeometry/BufferAttribute/PointsMaterial) |
| opts.size | number | 点尺寸(默认 0.015) |
| opts.color | number | 材质颜色(默认 0x8fb4ff) |

### 属性与方法

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| .points | unknown (readonly) | 加入 scene 的 THREE.Points |
| .update ( ) | Promise\<void\> | 同步一帧位置快照(每帧渲染前调用) |
| .dispose ( ) | void | 释放(含 sim.destroy) |

零拷贝 TSL 直通路径在路线图上;当前快照模式每帧一次 readback(毫秒级),适合中小规模。

---

# wgpu-kit/media · CanvasRecorder

画布录制(MediaRecorder 封装):容器自动协商(mp4 优先、webm 兜底),
录制结果一键下载。让用户替你生产传播素材。

## 构造

##### new CanvasRecorder ( )

当前环境不支持 MediaRecorder 时抛错。

### 属性与方法

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| .recording | boolean (readonly) | 是否录制中 |
| .mimeType | string (readonly) | 实际使用的容器 |
| .start ( canvas, videoBitsPerSecond? = 12_000_000 ) | void | 开始录制 |
| .stop ( ) | Promise\<RecordingResult\> | 停止并返回 `{ blob, mimeType, seconds, bytes }`;产物为空时抛错 |

### 辅助函数

##### pickMime ( ) : string \| null

按优先级返回可用容器(`webm vp9` → `webm vp8` → `webm` → `mp4`)。

##### downloadBlob ( blob : Blob, filename : string ) : void

触发浏览器下载。

### 代码示例

```ts
const rec = new CanvasRecorder();
rec.start(canvas);
setTimeout(async () => {
  const r = await rec.stop();
  downloadBlob(r.blob, `universe.${r.mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
}, 5000);
```

---

# wgpu-kit/vite · kernel 热重载

Vite 插件 + 客户端助手:WGSL 文件保存 → `kernel.replace()` 毫秒级生效(编译失败保留旧版)。

## 构造

##### wgpuKitHotReload ( ) : VitePluginLike

Vite 插件。监听 `*.wgsl` 文件变化,推送新代码到页面。

##### hotKernel ( kernel : ElementKernel, hot : ImportMetaHot \| undefined, file : string ) : void

客户端助手:注册 kernel 到热重载通道。

### 代码示例

```ts
// vite.config.ts
import { wgpuKitHotReload } from 'wgpu-kit/vite';
export default { plugins: [wgpuKitHotReload()] };

// 业务代码
import simSrc from './sim.wgsl?raw';
const k = elementKernel({ state: { a: 'f32' }, code: simSrc });
hotKernel(k, import.meta.hot, './sim.wgsl');
```

---

# 错误处理

所有错误继承 `WgpuKitError`:

| 错误类 | 场景 | 处理建议 |
| --- | --- | --- |
| `WebGPUUnavailableError` | 无 WebGPU / 无适配器 | 引导用户升级浏览器或开启硬件加速;可部署 `detect.html` 诊断页 |
| `CompileError` | WGSL 编译失败 | 消息含**你的代码行号**与原始编译信息 |
| `UsageError` | 参数不匹配(类型/长度/缺字段) | 按消息修正调用 |

运行期校验错误(uncapturederror)通过 console 输出,并计入 `sim.stats().gpuErrors`——
**该计数非 0 即表示渲染异常**,排查"黑屏"先看这里。

---

# 性能与限制

| 项 | 数值 | 环境 |
| --- | --- | --- |
| 粒子端到端 | 200,000 @ 142fps | RTX 4060 Laptop,playground 实测 |
| 粒子计算(grid) | 131k @ 0.89ms/帧 | 同上,headless 基准 |
| 邻域算法 | grid 近似 O(N),66k 时比暴力快 8.5× | 同会话 A/B |
| 库体积 | core gzip 5.5kB;+particles 10.3kB | gzip |

完整数据:[benchmarks.md](benchmarks.md)。**大规模调参建议**:`count` 增大时
适当减小 `rMax`(世界密度恒定,半径决定邻域数)。
