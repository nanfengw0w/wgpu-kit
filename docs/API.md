# wgpu-kit API Reference

> Browser GPGPU middle layer. Works in any WebGPU browser (Chrome/Edge 113+, Safari 18+). Zero runtime dependencies.
> Version: v0.9.10 · 简体中文参考:[API.zh-CN.md](API.zh-CN.md)

**Entry points**

| Import | Contents |
| --- | --- |
| [wgpu-kit](#wgpu-kit--kernel-core) | GpuContext · Buffer · elementKernel · PingPong · rawKernel · errors |
| [wgpu-kit/particles](#wgpu-kitparticles--particles) | particle-life simulation with GPU rendering |
| [wgpu-kit/life](#wgpu-kitlife--artificial-life) | Turing patterns · Physarum · Boids · soft tentacles |
| [wgpu-kit/fields](#wgpu-kitfields--flow) | vector-field advection trails |
| [wgpu-kit/image](#wgpu-kitimage--applyimage) | GPU filter pipeline |
| [wgpu-kit/react](#wgpu-kitreact--particlecanvas) | `<ParticleCanvas />` |
| [wgpu-kit/three](#wgpu-kitthree--threepoints) | three.js interop |
| [wgpu-kit/media](#wgpu-kitmedia--canvasrecorder) | canvas recording |
| [wgpu-kit/vite](#wgpu-kitvite--kernel-hot-reload) | kernel hot-reload plugin |

---

# wgpu-kit · kernel core

## GpuContext

Shared GPU device context for the whole library. Lazily acquires the adapter/device
and requests the adapter's maximum storage-buffer limits automatically.

### Static method

##### GpuContext.get ( ) : Promise\<GpuContext\>

Returns the global singleton, creating it on first call. Failures clear the
cached promise so the environment can be retried after a fix.

### Properties

| Property | Type | Description |
| --- | --- | --- |
| .device | GPUDevice (readonly) | Native GPUDevice (escape hatch for custom resources) |
| .adapterInfo | string (readonly) | Adapter description, e.g. `nvidia / lovelace` |

### Methods

##### .sync ( ) : Promise\<void\>

Resolves when all submitted GPU work has completed. Useful before readbacks and tests.

##### .lost : Promise\<GPUDeviceLostInfo\> (readonly)

Rejects when the device is lost.

---

## Buffer

A typed GPU memory array. Handles byte sizing, usage flags, write validation
and staging readbacks.

### Constructor

##### Buffer.create ( kind : ScalarKind, length : number ) : Promise\<Buffer\>

| Parameter | Type | Description |
| --- | --- | --- |
| kind | ScalarKind | Element type, see table below |
| length | number | Element count (positive integer) |

Throws `UsageError` on invalid kind or length.

**ScalarKind table**

| kind | WGSL | bytes/elem | TypedArray |
| --- | --- | --- | --- |
| `f32` | f32 | 4 | Float32Array |
| `i32` | i32 | 4 | Int32Array |
| `u32` | u32 | 4 | Uint32Array |
| `vec2f` | vec2\<f32\> | 8 | Float32Array |
| `vec2i` | vec2\<i32\> | 8 | Int32Array |
| `vec2u` | vec2\<u32\> | 8 | Uint32Array |
| `vec3f` | vec3\<f32\> | 12 (align 16) | Float32Array |
| `vec4f` | vec4\<f32\> | 16 | Float32Array |

### Properties

| Property | Type | Description |
| --- | --- | --- |
| .kind | ScalarKind (readonly) | Element type |
| .length | number (readonly) | Element count |
| .gpuBuffer | GPUBuffer (readonly) | Native handle — escape hatch for any engine or pipeline |

### Methods

##### .write ( data : TypedArray ) : void

Upload CPU → GPU. Throws `UsageError` when the TypedArray type or component
count does not match the buffer declaration.

##### .read ( ) : Promise\<TypedArray\>

Download GPU → CPU. The staging buffer and `mapAsync` sequencing are managed
by the library.

##### .destroy ( ) : void

Frees the GPU memory. The buffer must not be used afterwards.

### Code Example

```ts
import { Buffer } from 'wgpu-kit';

const pos = await Buffer.create('vec2f', 100_000);
pos.write(new Float32Array(200_000));
const back = await pos.read();
```

---

## elementKernel

**The core API of this library.** Declarative compute kernels: you only write
the per-element WGSL function (`userFn`); workgroups, dispatch, double-buffer
bindings, uniform packing, count guarding and compile-error line mapping are
generated for you.

### Code Example

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

// hot reload: compile-then-swap; on compile failure the old kernel is kept
await integrate.replace(`
  fn userFn(idx: u32, dt: f32) {
    pos[idx] = pos[idx] * 2.0;
  }
`);
```

### Constructor

##### elementKernel ( spec : ElementKernelSpec ) : ElementKernel

| spec property | type | description | default |
| --- | --- | --- | --- |
| name | string | Debug label (appears in errors) | `'kernel'` |
| state | Record\<string, ScalarKind\> | Read-**write** buffers | `{}` |
| inputs | Record\<string, ScalarKind\> | **Read-only** buffers | `{}` |
| uniforms | Record\<string, ScalarKind\> | Uniform scalars (f32/i32/u32 only) | `{}` |
| workgroupSize | number | Workgroup size, range 1..512 | `64` |
| code | string | User WGSL function, **must be named `userFn`** | required |

**The `code` contract:**

1. The function must be named **`userFn`** (the only naming convention);
2. First parameter is always `idx: u32` — out-of-range threads are guarded by the library;
3. Following parameters receive `uniforms` values **in declaration order**;
4. `state`/`inputs` field names are arrays inside the function — index them directly;
5. `count` is a reserved name (injected automatically from the first resource);
6. Field names across state/inputs/uniforms must not repeat.

Throws `UsageError` on invalid descriptors, reserved names, duplicate fields
or out-of-range workgroupSize.

### Properties

| Property | Type | Description |
| --- | --- | --- |
| .name | string (readonly) | Debug name |
| .source | string (readonly) | The generated full WGSL (for debugging) |
| .uniformLayout | UniformLayout (readonly) | Uniform layout (fields / offsets / total size) |
| .workgroupSize | number (readonly) | Effective workgroup size |

### Methods

##### .run ( resources, uniforms? ) : Promise\<void\>

Dispatch one step.

| Parameter | Type | Description |
| --- | --- | --- |
| resources | Record\<string, Buffer\> | Every state/inputs field mapped to a Buffer |
| uniforms | Record\<string, number\> | Uniform values matching the declaration |

Throws `UsageError` (missing resource / type mismatch / length mismatch) or
`CompileError` (WGSL failure — **line numbers map back into your `code`**).

##### .replace ( code : string ) : Promise\<void\>

Hot reload: swap in new `code` and rebuild the pipeline. Compile-then-swap —
on failure the old kernel keeps running untouched; on success the bind-group
cache is cleared and the next `run` uses the new logic.

##### .destroy ( ) : void

Frees the pipeline and uniform buffer (does not touch passed-in Buffers).

---

## PingPong

Double buffering for iterative simulations: read the "current" side, write
the "other" side, `swap()` at end of frame. Essential for particle, fluid and
cellular simulations.

### Constructor

##### PingPong.create ( kinds : Record\<string, ScalarKind\>, length : number ) : Promise\<PingPong\>

```ts
const pp = await PingPong.create({ pos: 'vec2f', vel: 'vec2f' }, 100_000);
```

### Members

| Member | Type | Description |
| --- | --- | --- |
| .current | Record\<K, Buffer\> (readonly) | Current-frame side (render / readback) |
| .other | Record\<K, Buffer\> (readonly) | The write target for the kernel |
| .swap ( ) | void | Flip the sides |
| .runWith ( fn ) | Promise\<void\> | Calls fn(write, read) then swaps automatically |
| .destroy ( ) | void | Destroys all buffers |

---

## rawKernel

The full-WGSL escape hatch: you write all the WGSL (including binding
declarations and the entry point), the library only creates the pipeline and
submits.

### Constructor

##### rawKernel ( code : string, entryPoint? : string, label? : string ) : RawKernel

| Parameter | Type | Description | Default |
| --- | --- | --- | --- |
| code | string | Full WGSL | required |
| entryPoint | string | Entry function name | `'main'` |
| label | string | Debug label | `'rawKernel'` |

##### .run ( entries : GPUBindGroupEntry[], workgroups : number ) : Promise\<void\>

`entries` are declared entirely by you; `workgroups` is the X-dimension
workgroup count.

### Code Example

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

Particle Life: a 4-species force matrix with three neighborhood algorithms,
two color modes, live parameter updates and shareable snapshots. GPU rendering
included.

## Code Example

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

## Constructor

##### particles ( config? : ParticlesConfig ) : Promise\<ParticlesSim\>

### ParticlesConfig

| Property | Type | Description | Default |
| --- | --- | --- | --- |
| count | number | Particle count (1..1,000,000) | `8192` |
| forces | 'cells' \| 'snakes' \| 'orbitals' \| 'viruses' \| 'random' \| ForceMatrix | Force matrix preset or custom 16-number array (row = actor, col = target; positive = attract) | `'cells'` |
| mode | 'grid' \| 'tiled' \| 'n2' | Neighborhood algorithm. grid = counting-sort spatial hash (recommended, ~O(N)); tiled = tiled brute force; n2 = full brute force (≤30k) | `'grid'` |
| color | 'species' \| 'velocity' | Color by species or by speed | `'species'` |
| bounds | 'wrap' \| 'clamp' | Boundary handling | `'wrap'` |
| seed | string \| number | Random seed (spawn distribution + random matrix), reproducible | `'wgpu-kit'` |
| rMax | number | Interaction radius (world units) | `0.12` |
| beta | number | Near/far force split (0..1) | `0.3` |
| forceFactor | number | Force strength multiplier | `10` |
| frictionHalfLife | number | Velocity half-life (seconds) | `0.04` |
| dt | number | Time step (seconds) | `0.02` |
| pointSize | number | Point size (clip-space ratio) | `0.004` |
| maxNeighbors | number | Per-particle candidate cap (safety fuse for extreme clumps) | `32768` |

**ForceMatrix**: a length-16 array where `m[i*4+j]` is the force of species i
on species j (−1..1). Presets: `cells` (classic), `snakes`, `orbitals`,
`viruses` (predation), `random` (generated from the seed).

**World scaling**: the world area grows proportionally with `count` (density
locked to the 16k level) and the camera zooms out — any scale produces the
same per-particle physics.

## Properties

| Property | Type | Description |
| --- | --- | --- |
| .config | ResolvedConfig (readonly) | The fully resolved configuration |

## Methods

##### .attach ( canvas : HTMLCanvasElement ) : Promise\<void\>

Binds the render target and creates the render pipeline. Call once.

##### .tick ( dtMultiplier? : number ) : void

Steps one frame (compute + render). `dtMultiplier` supports 0 (pause), <1
(slow motion), >1 (fast forward).

##### .setForces ( forces ) : void

Hot-swaps the force matrix (preset name or custom array) — no rebuild.

##### .setParams ( params ) : void

Hot-updates physics `{ rMax?, beta?, forceFactor?, frictionHalfLife?, dt? }`.
Note: changing `rMax` in grid mode triggers a grid rebuild (~100ms).

##### .snapshot ( ) : string

Serializes the configuration as JSON — interoperates with the playground's
`?p=…&m=…&s=…` URL parameters for sharing.

##### .stats ( ) : { fps : number; gpuErrors : number }

Runtime stats. `gpuErrors > 0` means GPU validation errors occurred (check
this first when diagnosing a black canvas).

##### .buffers ( ) : { pos, vel, species }

Current-frame buffers (`Buffer` instances — read them or hand to three.js).

##### .destroy ( ) : void

Releases everything. The sim is unusable afterwards.

---

# wgpu-kit/life · artificial life

Four standalone emergence simulations with the same shape:
`attach(canvas)` / `tick()` / `stats()` / `destroy()`.

## turing ( config? ) : Promise\<TuringSim\>

Gray-Scott reaction-diffusion: two chemicals grow coral / cell / wave patterns.

| config | type | description | default |
| --- | --- | --- | --- |
| size | number | Grid edge (square) | `512` |
| preset | 'coral' \| 'mitosis' \| 'spots' \| 'waves' \| 'custom' | Parameter preset | `'coral'` |
| feed / kill | number | Custom f/k (when preset = custom) | per preset |
| steps | number | Iterations per frame | `12` |
| colormap | string | 'duotone' (default) \| 'amber' \| 'ice' \| 'mono' | — |
| seed | string \| number | Seed for initial spots | `'life'` |

| Extra method | description |
| --- | --- |
| .sprinkle ( count? = 6 ) | Sprinkle perturbation at random spots |
| .sampleB ( ) : Promise\<Float32Array\> | Read back the B concentration field |

Preset parameters: `coral` f=0.0545 k=0.062 · `mitosis` f=0.0367 k=0.0649 ·
`spots` f=0.03 k=0.062 · `waves` f=0.014 k=0.045.

## physarum ( config? ) : Promise\<PhysarumSim\>

Physarum slime mold: three-sensor agents sense, turn, move, deposit; the trail
diffuses and decays — networks emerge on their own.

| config | type | description | default |
| --- | --- | --- | --- |
| agents | number | Agent count | `100_000` |
| mapSize | number | Trail map edge | `1024` |
| sensorAngle / sensorDist / turnAngle / step | number | Sensing & motion | 0.5 / 0.012 / 0.45 / 0.003 |
| decay | number | Per-frame decay | `0.06` |
| colormap | string | default 'amber' | — |

Extra method: `sampleTrail()`.

## boids ( config? ) : Promise\<BoidsSim\>

Boids flocking: separation / alignment / cohesion over a counting-sort grid.

| config | type | description | default |
| --- | --- | --- | --- |
| count | number | Individuals | `3000` |
| perception | number | Perception radius | `0.05` |
| maxSpeed | number | Max speed | `0.012` |
| wSep / wAli / wCoh | number | Separation / alignment / cohesion weights | 1.6 / 1.0 / 0.8 |
| size | number | Triangle size | `0.009` |

Extra method: `buffers(): { pos, vel }`.

## tentacles ( config? ) : Promise\<TentaclesSim\>

Soft tentacles: Verlet chains anchored on golden-angle drifting anchors, with
gravity and damping for a jellyfish-like drift.

| config | type | description | default |
| --- | --- | --- | --- |
| chains / segments | number | Chains / nodes per chain | 48 / 64 |
| segLen / gravity / damping | number | Node spacing / gravity / damping | 0.018 / 0.00035 / 0.985 |
| iterations | number | Constraint relaxation passes per frame | `10` |
| thickness / colorCycle | number | Dot size base / hue cycle speed | 0.006 / 0.35 |

---

# wgpu-kit/fields · flow

Vector-field advection trails: particles are advected through an analytic
field and deposit a fading trail — a base layer for wind/flow visualization.

## Constructor

##### flow ( config? : FlowConfig ) : Promise\<FlowSim\>

| config | type | description | default |
| --- | --- | --- | --- |
| count | number | Advected particles | `131_072` |
| mapSize | number | Trail map edge | `1024` |
| field | 'vortex' \| 'curl' \| 'twin' | Field type: vortex / curl noise / twin vortices | `'curl'` |
| speed | number | Per-frame step | `0.004` |
| decay | number | Per-frame decay | `0.045` |
| deposit | number | Deposit amount | `1.0` |
| colormap | string | 'ice' (default) \| 'amber' \| 'duotone' \| 'mono' | — |
| seed | string \| number | Seed | `'flow'` |

### Methods

Same shape as the other sims: `attach / tick / stats / sampleTrail / destroy`.

---

# wgpu-kit/image · applyImage

GPU filter pipeline: source → per-op ping-pong passes → target canvas.

## Constructor

##### applyImage ( source, target, ops ) : Promise\<ApplyImageResult\>

| Parameter | type | description |
| --- | --- | --- |
| source | HTMLCanvasElement \| HTMLImageElement \| ImageBitmap | Input image |
| target | HTMLCanvasElement | Output canvas (WebGPU backend) |
| ops | ImageOp[] | Operator pipeline, executed in order |

Returns `{ width, height, passes, readback(): Promise<Uint8Array> }` —
`readback()` gives GPU-direct pixels (RGBA, rows aligned to 256B), usable in
headless tests.

### ImageOp table

| op | params | description |
| --- | --- | --- |
| { op: 'grayscale' } | — | Grayscale (Rec.709 luma) |
| { op: 'invert' } | — | Invert |
| { op: 'edge', amount? } | amount default 1 | Sobel edge detect |
| { op: 'blur', radius? } | radius 1..4, default 1 | Box blur |
| { op: 'sharpen', amount? } | amount default 1 | 3×3 sharpen |
| { op: 'brightness', value } | −1..1 | Brightness |
| { op: 'contrast', value } | 0..2, 1 = unchanged | Contrast |

### Code Example

```ts
const r = await applyImage(srcCanvas, outCanvas, [
  { op: 'blur', radius: 2 },
  { op: 'edge', amount: 1 },
]);
const px = await r.readback();
```

---

# wgpu-kit/react · ParticleCanvas

React binding for the particles pack. Mounting creates the simulation + rAF
loop; unmounting destroys everything (StrictMode safe).

## Props

`ParticleCanvasProps` extends `ParticlesConfig` (count/forces/mode/seed/…)
with:

| Property | type | description |
| --- | --- | --- |
| className | string | Passed to the canvas |
| style | CSSProperties | Passed to the canvas (defaults to 100% × 100%) |
| onReady | (sim: ParticlesSim) => void | Called when the sim is ready; grab it here for imperative control |

### Code Example

```tsx
<ParticleCanvas key="u1" count={66_000} forces="cells" onReady={(s) => console.log(s.stats())} />
```

**Convention**: change config by changing `key` (declarative); imperative
control goes through `onReady`.

---

# wgpu-kit/three · threePoints

Snapshot-based three.js interop: each frame the simulation positions are read
back into a `BufferAttribute`, working with any three renderer (WebGL or
WebGPU).

## Constructor

##### threePoints ( sim : ParticlesSim, THREE : ThreeAPI, opts? ) : ThreePointsHandle

| Parameter | type | description |
| --- | --- | --- |
| sim | ParticlesSim | A created particle simulation |
| THREE | ThreeAPI | Your three module (minimal surface: Points / BufferGeometry / BufferAttribute / PointsMaterial) |
| opts.size | number | Point size (default 0.015) |
| opts.color | number | Material color (default 0x8fb4ff) |

### Members

| member | type | description |
| --- | --- | --- |
| .points | unknown (readonly) | The THREE.Points to add to your scene |
| .update ( ) | Promise\<void\> | Sync one position snapshot (call before rendering) |
| .dispose ( ) | void | Release (also destroys the sim) |

Zero-copy TSL interop is on the roadmap; the snapshot mode costs one
readback per frame (millisecond-scale) — fine for small/medium counts.

---

# wgpu-kit/media · CanvasRecorder

Canvas recording (a MediaRecorder wrapper): container negotiated
automatically (mp4 preferred, webm fallback) with one-call download.

## Constructor

##### new CanvasRecorder ( )

Throws when the environment has no MediaRecorder support.

### Properties & Methods

| member | type | description |
| --- | --- | --- |
| .recording | boolean (readonly) | Whether a recording is in progress |
| .mimeType | string (readonly) | The negotiated container |
| .start ( canvas, videoBitsPerSecond? = 12_000_000 ) | void | Start recording |
| .stop ( ) | Promise\<RecordingResult\> | Stop and return `{ blob, mimeType, seconds, bytes }`; throws if the product is empty |

### Helpers

##### pickMime ( ) : string \| null

Returns the best available container (`webm vp9` → `webm vp8` → `webm` → `mp4`).

##### downloadBlob ( blob : Blob, filename : string ) : void

Triggers a browser download.

### Code Example

```ts
const rec = new CanvasRecorder();
rec.start(canvas);
setTimeout(async () => {
  const r = await rec.stop();
  downloadBlob(r.blob, `universe.${r.mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
}, 5000);
```

---

# wgpu-kit/vite · kernel hot reload

Vite plugin + client helper: saving a WGSL file triggers `kernel.replace()`
within milliseconds (compile failures keep the old kernel).

## Constructor

##### wgpuKitHotReload ( ) : VitePluginLike

The Vite plugin. Watches `*.wgsl` files and pushes new code to the page.

##### hotKernel ( kernel : ElementKernel, hot : ImportMetaHot \| undefined, file : string ) : void

Client helper: registers a kernel on the hot-reload channel.

### Code Example

```ts
// vite.config.ts
import { wgpuKitHotReload } from 'wgpu-kit/vite';
export default { plugins: [wgpuKitHotReload()] };

// app code
import simSrc from './sim.wgsl?raw';
const k = elementKernel({ state: { a: 'f32' }, code: simSrc });
hotKernel(k, import.meta.hot, './sim.wgsl');
```

---

# Errors

All errors extend `WgpuKitError`:

| error | thrown when | guidance |
| --- | --- | --- |
| `WebGPUUnavailableError` | No WebGPU / no adapter | Point users at the `detect.html` page |
| `CompileError` | WGSL compilation failed | Message contains **your code's line numbers**; hot reload keeps the old kernel |
| `UsageError` | Argument mismatch (type / length / missing field) | Fix the call per the message |

Runtime validation errors (uncapturederror) are logged to the console and
counted in `sim.stats().gpuErrors` — **when diagnosing a black canvas, check
this counter first**.

---

# Performance & limits

| item | value | environment |
| --- | --- | --- |
| particles end-to-end | 200,000 @ 142fps | RTX 4060 Laptop, playground |
| particle compute (grid) | 131k @ 0.89ms/frame | same, headless bench |
| neighborhood algorithms | grid ~O(N), 8.5× faster than brute force at 66k | same-session A/B |
| bundle size | core gzip 5.5kB; +particles 10.3kB | gzip |

Full data and repro commands: see the repository benchmarks page. **Scaling
tip**: as `count` grows, keep the world density constant (handled
automatically) and consider lowering `rMax` — the radius determines the
neighbor count, which dominates the cost.

---

# wgpu-kit/observe · observability

GPU timing, device diagnostics and canvas helpers — the runtime counterpart
of the published benchmark numbers.

## timeGpu

##### timeGpu ( fn : (ctx) => void | Promise<void> ) : Promise<number>

Measures real GPU milliseconds spent inside `fn` using timestamp queries
(Chrome/Edge). Rejects with `UsageError` when the device lacks the feature.

### Code Example

```ts
import { timeGpu } from 'wgpu-kit/observe';
const ms = await timeGpu(() => sim.tick());
console.log(`GPU: ${ms.toFixed(2)} ms/frame`);
```

---

# wgpu-kit/observe · watchDevice

##### watchDevice ( opts : { onError?, onRebuild? } ) : void

Registers error/loss callbacks on the shared device and **automatically
rebuilds the context** when the GPU device is lost — essential for
long-running pages (installations, dashboards). `onError(message, recoverable)`
fires for validation errors (recoverable) and device loss (not).

---

# wgpu-kit/observe · canvas helpers

##### preferredCanvasFormat ( ) : GPUTextureFormat

The preferred canvas format for this browser.

##### resizeCanvas ( canvas : HTMLCanvasElement, dprCap? = 2 ) : boolean

Sizes the canvas backing store to `clientSize x min(dpr, dprCap)`. Returns
whether the size actually changed (skip rebuilds when `false`).
