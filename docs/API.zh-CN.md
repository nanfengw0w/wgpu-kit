[打开在线演示](https://nanfengw0w.github.io/wgpu-kit/)

# wgpu-kit API 参考

> 面向 TypeScript 的 WebGPU 计算工具，需要支持 WebGPU 的浏览器。计算核心无运行时依赖。
> 版本:v2.0 · [English reference](API.md)

**入口总览**

| 入口 | 内容 |
| --- | --- |
| [wgpu-kit](#wgpu-kit--kernel-核心) | GpuContext(含 adopt)· Buffer · elementKernel · PingPong · rawKernel · defineSchema · definePack · createScan · createReduce · 错误类 |
| [wgpu-kit/particles](#wgpu-kitparticles--particles) | 粒子生命模拟 |
| [wgpu-kit/grid](#wgpu-kitgrid--通用空间邻域) | 通用空间邻域(计数排序哈希;v2.0 编码合同) |
| [wgpu-kit/react](#wgpu-kitreact--particlecanvas) | `<ParticleCanvas />` |
| [wgpu-kit/three](#wgpu-kitthree--threepoints) | three.js 互通 |
| [wgpu-kit/media](#wgpu-kitmedia--canvasrecorder) | 画布录制 |
| [wgpu-kit/vite](#wgpu-kitvite--kernel-热重载) | kernel 热重载插件 |
| [wgpu-kit/observe](#wgpu-kitobserve--可观测性) | 计时、设备回调和画布助手 |

---

# wgpu-kit · kernel 核心

## GpuContext

全库共享的 GPU 设备上下文。惰性申请 adapter/device,自动按适配器能力申请存储缓冲上限。

### 静态方法

##### GpuContext.get ( ) : Promise\<GpuContext\>

获取(或创建)全局唯一上下文。失败时缓存被清除,修复环境后可重试。

##### GpuContext.adopt ( device : GPUDevice ) : GpuContext —— v2.0

接入调用方**自有**的 GPUDevice(TypeGPU 互操作桥:把 `tgpu.init()` 的设备
递进来),此后全库单例与 `Buffer.create` 都运行于该设备。必须在首次
`get()` **之前**调用——运行中 adopt 会抛错。

##### 实例属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| .device | GPUDevice (readonly) | 原生 GPUDevice(逃生舱:可直接创建自定义资源) |
| .adapterInfo | string (readonly) | 适配器描述,如 `nvidia / lovelace` |

##### 实例方法

##### .sync ( ) : Promise\<void\>

等待队列中全部已提交的 GPU 工作完成。测试或读回数据前使用。

##### .lost : Promise\<GPUDeviceLostInfo\> (readonly)

设备丢失时以原生设备丢失信息完成，可 await 后处理清理与重建。

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
  fn userFn(idx: u32, dt: f32, friction: f32) {
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
| uniforms | Record\<string, ScalarKind\> | uniform 字段类型(声明 ScalarKind;值支持 vec2/3/4 向量) | `{}` |
| workgroupSize | number | workgroup 大小,1..512 | `64` |
| code | string | 用户 WGSL 函数,**必须命名 `userFn`** | 必填 |

**code 契约(重要):**

1. 函数必须命名为 **`userFn`**(这是唯一约定,库按此生成调用);
2. 第一个参数固定 `idx: u32`;
3. 其后参数按 `uniforms` 声明顺序自动注入;
4. `state`/`inputs` 字段名在函数体内即数组,直接 `name[idx]` 访问;
5. `count` 是保留名(uniform 由库自动注入并做越界保护);
6. state 与 inputs 的字段名不能重复。

**词法分析边界(已知限制)**:资源使用检测会先剥离注释、`struct` 声明体、
成员访问(`.字段`)与不可达 helper;但**遮蔽**资源名的局部变量
(`let ghost = 2.0;` 同时声明了 ghost 缓冲)仍会计为"已使用"——该缓冲会
进 bind group,dispatch 可能被拒绝。规避方式:重命名局部变量(真正的
WGSL 解析器不在承诺范围内,见 defineSchema 的诚实边界)。

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

执行一次：准备管线、编码并提交。返回的 Promise 不等待 GPU 完成；
CPU 需要完成结果时，使用数据读回或 `GpuContext.sync()`。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| resources | Record\<string, Buffer\> | state/inputs 全部字段 → Buffer 映射 |
| uniforms | Record\<string, UniformValue\> | uniform 值(标量或 {x,y,z?,w?} 向量,须与声明一致;v2.0 起支持向量) |

抛出:`UsageError`(缺资源/类型不匹配/长度不一致)、`CompileError`(WGSL 编译失败,**行号映射回你的 code**)。

##### .prepare ( ) : Promise\<void\> —— v2.0

幂等异步准备:解析上下文、编译管线、分配内部资源。必须在 `encode` 前完成。

##### .encode ( encoder : GPUCommandEncoder, resources, uniforms? ) : void —— v2.0

同步编码:把 dispatch 写入**你的** encoder(不提交)。多个 kernel 可组成同
一条计算链。**encode-once-per-submit 合同**:同一实例的共享 uniform 快照
在一次提交前只能 encode 一次,重复会抛 `UsageError`;自定义 submit 后调用
`.endSubmit()` 重置(`.resetEncodeGuard()` 可整体解除)。

##### .endSubmit ( ) : void —— v2.0

自定义 submit 流程完成后调用:重置 encode-once 检测。

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
`run()` 负责准备、编码与提交，不等待 GPU 完成。

##### .prepare ( ) : Promise\<void\>

编译管线，完成后才能同步编码。

##### .encode ( encoder : GPUCommandEncoder, entries : GPUBindGroupEntry[], workgroups : number ) : void

向调用方的 encoder 添加计算 pass，不提交。请在没有打开 pass 时调用；
资源声明与工作组数量由调用方控制。

##### .destroy ( ) : void

释放缓存的管线引用，调用方的缓冲由调用方管理。

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

# wgpu-kit · defineSchema

类型化 schema 层:字段表声明一次,同时得到编译期 TS 行类型、生成的 WGSL
struct 代码和逐字段类型化 GPU 缓冲——消灭 JS/WGSL schema 漂移与无类型的
buffer 读写。诚实边界:WGSL 函数体内部的错误仍由 WGSL 编译器报错(带你的
行号映射);完整 WGSL 类型检查不在承诺范围。

## defineSchema ( fields ) : Schema

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| fields | `Record<string, ScalarKind>`(const 对象) | 字段名与类型,声明顺序即成员顺序 |

`ScalarKind`:`'f32' | 'i32' | 'u32' | 'vec2f' | 'vec2i' | 'vec2u' | 'vec3f' | 'vec4f'`。

### 成员

##### .fields : F

原始声明——直接喂 `elementKernel` 的 `state`(名称/顺序同源)。

##### .wgslStruct ( name : string, addressSpace? : 'storage' | 'uniform' ) : string

生成 `struct <name> { … }`。`'storage'` 语义下 `vec3f` 成员补 `@size(16)`
(WGSL 数组元素步长规则),GPU/CPU 布局永不漂移。

##### .buffers ( count ) : Promise\<SchemaBuffers\>

每字段一个类型化缓冲(与 elementKernel 的绑定模型一致)。

### SchemaBuffers

| 成员 | 说明 |
| --- | --- |
| `.<字段名>` | `TypedBuffer<K>` — `write(rows)` / `read(): Promise<rows>` 收发行对象(`vec2f` 即 `{x, y}`);`.raw` 是普通 `Buffer`(逃生舱) |
| `.raws()` | `{ [字段]: Buffer }` — 直接传给 `elementKernel.run()` |
| `.destroy()` | 销毁全部字段缓冲 |

### 代码示例

```ts
import { defineSchema, elementKernel, type SchemaInfer } from 'wgpu-kit';

const Boid = defineSchema({ pos: 'vec2f', vel: 'vec2f', species: 'u32' });
type BoidRow = SchemaInfer<typeof Boid.fields>; // { pos: {x,y}, vel: {x,y}, species: number }

const count = 1;
const bufs = await Boid.buffers(count);
bufs.pos.write([{ x: 1, y: 2 }]);               // 字段或分量拼写错误会被类型检查发现。
bufs.vel.write([{ x: 0.5, y: 0 }]);
const k = elementKernel({
  state: Boid.fields,
  code: 'fn userFn(idx: u32) { pos[idx] = pos[idx] + vel[idx]; }',
});
await k.run(bufs.raws());
const rows = await bufs.pos.read();             // 类型化行对象。
k.destroy();
bufs.destroy();
```

---

# wgpu-kit · definePack / registerPack

Pack 注册描述模拟的生命周期以及可选统计或诊断接口。`definePack` 检查名称和
创建函数，具体资源管理与正确性由 pack 实现负责。

## PackSim

| 成员 | 必需 | 说明 |
| --- | --- | --- |
| `attach?(canvas)` | 否 | 需要 canvas 的包在此建渲染器 |
| `tick()` | 是 | 推进一帧(计算 + 可选渲染) |
| `stats?()` | 否 | 轻量运行统计(`{ fps }` 等) |
| `probe?()` | 否 | 应用自定义的可选诊断，由调用方显式执行 |
| `destroy()` | 是 | 释放全部 GPU 资源 |

## definePack ( pack ) : WgpuKitPack

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| pack.name | string | 小写标识符;注册表命名空间 |
| pack.description? | string | `listPacks()` 展示用 |
| pack.create(config?) | function | 返回 `Promise<PackSim>` |

## registerPack ( pack ) / getPack ( name ) / listPacks ()

注册表操作。同名重复注册抛 `UsageError`——内置包不可被覆盖。

### 代码示例

```ts
import { definePack, registerPack, listPacks } from 'wgpu-kit';

const orbit = definePack({
  name: 'orbit',
  create: async (config) => ({
    tick() { /* … */ },
    destroy() { /* … */ },
  }),
});
registerPack(orbit);
listPacks(); // 包含 'particles'、'orbit'
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
| mode | 'grid' \| 'tiled' \| 'n2' | 邻域算法：计数排序空间网格、分块暴力或全量暴力 | `'grid'` |
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

**自适应世界**：世界大小随 `count` 调整，使初始平均密度保持可比。
实际邻居数量与查询成本取决于粒子分布、交互半径和格子占用情况。

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
注意：`rMax` 变化在 grid 模式下会触发网格重建。

##### .snapshot ( ) : string

返回配置 JSON，用于保存或分享。URL 格式由应用定义，并显式转换为配置。

##### .stats ( ) : { fps : number; gpuErrors : number }

运行统计。`fps` 按滚动时间窗口内的 `tick()` 调用计数计算，不表示 GPU 完成或
画面呈现速率。`gpuErrors` 非 0 表示发生了 GPU 校验错误。

##### .buffers ( ) : { pos, vel, species }

当前帧数据缓冲(`Buffer` 实例,可 `read()`/接 three.js)。

##### .destroy ( ) : void

释放全部资源。此后 sim 不可用。

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

快照模式会将位置读回 CPU，再更新 three.js 属性。请按应用需求选择更新频率。

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

Vite 插件和客户端助手：保存 WGSL 文件后调用 `kernel.replace()`，编译失败保留旧版。

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
| `WebGPUUnavailableError` | 无 WebGPU / 无适配器 | 处理初始化失败，并向用户说明 WebGPU 要求 |
| `CompileError` | WGSL 编译失败 | 消息含**你的代码行号**与原始编译信息 |
| `UsageError` | 参数不匹配(类型/长度/缺字段) | 按消息修正调用 |

粒子模拟的运行期校验错误会计入 `sim.stats().gpuErrors`。检查该计数和浏览器控制台，
定位计算或渲染中的 GPU 校验错误。

---

# wgpu-kit/grid · 通用空间邻域

面向二维位置的计数排序空间网格。格子范围与实体下标保留在 GPU 缓冲中，
供后续邻域内核使用。查询成本取决于格子占用情况和交互半径。

## 构造

##### createNeighborGrid ( config : NeighborGridConfig ) : Promise<NeighborGrid>

| config 属性 | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| count | number | 实体数量 | 必填 |
| worldHalf | number | 世界半宽 | 必填 |
| cellSize | number | 格子边长(通常 = 交互半径) | 必填 |
| workgroupSize | number | workgroup 大小 | `64` |

### 属性与方法

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| .gridSize | number (readonly) | 网格边长(格数) |
| .cells | number (readonly) | 总格数 |
| .cellStart | Buffer (readonly) | 各格起始槽位 |
| .cellFill | Buffer (readonly) | 各格结束槽位 |
| .order | Buffer (readonly) | 按格子序排列的实体下标 |
| .prepare ( ) : Promise\<void\> —— v2.0 | 幂等准备(解析内部 scan 原语) |
| .encode ( encoder : GPUCommandEncoder, pos : Buffer ) : void —— v2.0 | counts → scan → post → scatter 写入**你的** encoder(不提交;可与力 kernel 组成计算链) |
| .update ( pos : Buffer ) : void | 便捷路径 = 内部 encoder + 提交 |
| .endSubmit ( ) : void —— v2.0 | 自定义 submit 后重置内部 scan 的 encode-once 闸 |
| .destroy ( ) : void | 释放 |

### 代码示例

```ts
import { createNeighborGrid } from 'wgpu-kit/grid';

const grid = await createNeighborGrid({ count: 100_000, worldHalf: 1.0, cellSize: 0.12 });
// 每帧:先建格,再在你的力 kernel 里读 cellStart/cellFill/order
grid.update(posBuffer);
```

---

# wgpu-kit/observe · 可观测性

GPU 计时 / 设备诊断 / 画布助手。

## timeGpu

##### timeGpu ( fn : (ctx) => void | Promise<void> ) : Promise<number>

通过时间戳测量 `fn` 提交工作前后的 GPU 时间区间，包含提交之间的空隙，
不是各个计算 pass 的耗时总和。设备缺少 `timestamp-query` 时抛 `UsageError`。

```ts
import { timeGpu } from 'wgpu-kit/observe';
const ms = await timeGpu(() => sim.tick());
console.log(`GPU: ${ms.toFixed(2)} ms/frame`);
```

## watchDevice

##### watchDevice ( opts : { onError?, onRebuild? } ) : void

注册共享设备的错误与丢失回调。设备丢失后尝试获取新上下文，成功时调用
`onRebuild`。应用需要为新设备重新创建自己的缓冲、内核与渲染器。

## 画布助手

##### preferredCanvasFormat ( ) : GPUTextureFormat

返回当前浏览器推荐格式。

##### resizeCanvas ( canvas, dprCap? = 2 ) : boolean

按 DPR 上限调整画布尺寸;返回是否实际改变。

---

# wgpu-kit · createScan / createReduce

u32 前缀和 `scan` 在不超过 65536 个元素时使用单 workgroup 路径，更大输入使用
三个 pass。u32 归约 `reduce` 的 `sumInto` 将结果保留在 GPU 上，`sum` 提供
CPU 读回。两者与 kernel 一致：每个实例在一次提交前编码一次，提交后调用
`endSubmit()` 重置。

### 方法

| 方法 | 行为 |
| --- | --- |
| `scan.prepare()` / `reduce.prepare()` | 异步准备管线，编码前等待完成 |
| `scan.encode(encoder, src, dst, count, exclusive = true)` | 将 u32 前缀和写入 GPUBuffer `dst` |
| `scan.run(src, dst, count, exclusive = true)` | 使用 Buffer 的便捷路径，内部提交 |
| `reduce.sumInto(encoder, src, count, dst)` | 将 u32 总和写入 GPUBuffer `dst`，无需读回 |
| `reduce.sum(src, count)` | 读回后返回 JavaScript number |
| `endSubmit()` | 调用方提交后，重置该实例的编码状态 |
| `destroy()` | 释放内部缓冲和缓存的管线引用 |

编码方法接收原生 GPUBuffer，`run` 和 `sum` 接收 wgpu-kit Buffer。
请在没有打开 pass 时调用编码方法；求和采用 u32 算术。

### GPU 常驻示例

```ts
import { Buffer, GpuContext, createScan, createReduce } from 'wgpu-kit';

const count = 1024;
const src = await Buffer.create('u32', count);
const prefix = await Buffer.create('u32', count);
const total = await Buffer.create('u32', 1);
src.write(Uint32Array.from({ length: count }, (_, i) => i));

const scan = createScan();
const reduce = createReduce();
await scan.prepare();
await reduce.prepare();
const { device } = await GpuContext.get();
const encoder = device.createCommandEncoder();

scan.encode(encoder, src.gpuBuffer, prefix.gpuBuffer, count, true);
reduce.sumInto(encoder, prefix.gpuBuffer, count, total.gpuBuffer);
device.queue.submit([encoder.finish()]);
scan.endSubmit();
reduce.endSubmit();

// 仅在最后将结果读回 CPU。
console.log(await total.read());
scan.destroy();
reduce.destroy();
src.destroy();
prefix.destroy();
total.destroy();
```

dispatch 上限遵循 WebGPU 规范,超限在入口即抛清晰 `UsageError`:
块数 ≤ 65535(`scan`,即 count ≤ 8192 × 65535)、count ≤ 8192 × 65535
(`reduce`)。

---
