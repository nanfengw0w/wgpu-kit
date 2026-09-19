# wgpu-kit

[![CI](https://github.com/nanfengw0w/wgpu-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/nanfengw0w/wgpu-kit/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/wgpu-kit)](https://www.npmjs.com/package/wgpu-kit) [![license MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Creative-coding GPU toolkit for the browser. 200,000-particle physics at 120fps — in 5 lines of code.**
All the WebGPU boilerplate — device, buffers, pipelines, dispatch, double
buffering, readbacks, error line-mapping — wrapped into two simple API layers.

[**API Reference**](docs/API.md) · [中文文档](README.cn.md) · **[LIVE DEMO](https://nanfengw0w.github.io/wgpu-kit/)**

![wgpu-kit particle life](hero.gif)

## Quick start

```bash
npm i wgpu-kit
```

**100,000 particles in 5 lines:**

```ts
import { particles } from 'wgpu-kit';

const sim = await particles({ count: 100_000, forces: 'cells' });
await sim.attach(canvas);
function frame() { sim.tick(); requestAnimationFrame(frame); }
frame();
```

**Custom GPU compute** — you only write the per-element function:

```ts
import { elementKernel, Buffer } from 'wgpu-kit';

const pos = await Buffer.create('vec2f', 100_000);
const vel = await Buffer.create('vec2f', 100_000);

const integrate = elementKernel({
  state:   { pos: 'vec2f' },
  inputs:  { vel: 'vec2f' },
  uniforms: { dt: 'f32' },
  code: `
    fn userFn(idx: u32, dt: f32) {
      pos[idx] = (pos[idx] + vel[idx] * dt) * 0.99;
    }
  `,
});
await integrate.run({ pos, vel }, { dt: 0.02 });
```

Device management, buffer sizing, pipeline creation, double buffering,
dispatch, readbacks, error line-mapping — all handled by the library.

### The same thing, with raw WebGPU

For honesty: here is the **heavily condensed** native equivalent (full
version is ~150 lines; this excerpt omits error handling, resize, double
buffering, staging readbacks and the render pipeline):

```ts
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();

// buffers — sizes and usages hand-computed
const pos = device.createBuffer({ size: 100_000 * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
const vel = device.createBuffer({ size: 100_000 * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });

// hand-written WGSL, uniform struct aligned to 16 bytes by hand
const module = device.createShaderModule({ code: `...struct Params {...}...` });

const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [/* every binding, exact order */] });

function tick(dt) {
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(100_000 / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
}
// …plus: staging readbacks, device-lost handling, WGSL compile diagnostics,
// canvas resize — and a render pipeline before anything is visible.
```

With `wgpu-kit`, the kernel is the only code you write — and when WGSL fails
to compile, the error points at **your line**.

## Entry points

| import | purpose |
| --- | --- |
| `wgpu-kit` | elementKernel core + Buffer / PingPong / rawKernel + **typed schemas** + **pack platform** |
| `wgpu-kit/particles` | particle life: presets, adaptive world, live updates |
| `wgpu-kit/life` | Turing patterns / Physarum / Boids / Tentacles |
| `wgpu-kit/fields` | vector-field advection trails |
| `wgpu-kit/image` | GPU filter pipeline (blur/sharpen/edge/…) |
| `wgpu-kit/react` | `<ParticleCanvas />` |
| `wgpu-kit/three` | three.js snapshot interop |
| `wgpu-kit/media` | canvas recording (webm/mp4) |
| `wgpu-kit/observe` | GPU timing / device diagnostics / canvas helpers |
| `wgpu-kit/vite` | WGSL kernel hot reload |

![life quartet](life-quartet.png)

*The life pack: Turing patterns / Physarum / Boids / Tentacles — [open the demo](https://nanfengw0w.github.io/wgpu-kit/life.html).*

## Type-safe schemas

WGSL stays WGSL, but the *field table* stops being a string you can get wrong.
Declare once — TypeScript row types, WGSL struct code and GPU buffers all come
from the same declaration; a typo'd field is a red squiggle, not a runtime error:

```ts
import { defineSchema, elementKernel } from 'wgpu-kit';

const Boid = defineSchema({ pos: 'vec2f', vel: 'vec2f', species: 'u32' });
type Boid = SchemaInfer<typeof Boid.fields>;   // { pos: {x,y}, vel: {x,y}, species: number }

const bufs = await Boid.buffers(count);
bufs.pos.write([{ x: 1, y: 2 }, /* … */]);      // ❌ `{ z: 0 }` fails at compile time
const k = elementKernel({ state: Boid.fields, code: 'fn userFn(idx: u32) { … }' });
await k.run(bufs.raws());
const rows = await bufs.pos.read();             // typed rows back
```

Honest boundary: errors inside your WGSL function body are still caught by the
WGSL compiler (with your-line mapping). Full WGSL type-checking is a compiler
project; what this layer eliminates is JS/WGSL **schema drift** and untyped
buffer I/O.

## A platform, not a feature list

The built-in packs are not privileged. `definePack` is the same contract they
use — lifecycle, stats, a self-verification `probe()` and a registry:

```ts
import { definePack, registerPack, listPacks } from 'wgpu-kit';

const orbit = definePack({
  name: 'orbit',
  description: 'my N-body toy',
  create: async (config) => {
    // … build your sim from elementKernel / rawKernel …
    return {
      tick() { /* … */ },
      async probe() { return { energyDrift: 0.003 }; },  // verify harness collects this
      destroy() { /* … */ },
    };
  },
});
registerPack(orbit);
listPacks(); // [{ name: 'particles', … }, { name: 'fields', … }, { name: 'orbit', … }]
```

`probe()` is the platform deal: a third-party pack gets the same treatment in
the verification harness as the built-ins — correctness is part of the
contract, not a courtesy.

## Numbers (reproducible)

Two honest measurement conventions — both real, measuring different things. **Don't
mix them up** (see [docs/BENCHMARK.md](docs/BENCHMARK.md) for both, generated by
`npm run bench`):

- **Display fps** — what you actually see in the playground, paced by the
  browser (probe: append `?verify=10` to any playground URL — it self-reports
  fps and GPU errors).
- **Pipeline saturation** — bounded 3-frame-in-flight pump: `tick()` without
  waiting, drain every 3 frames. The GPU's sustained throughput ceiling.
- **Sync latency** — `tick()` then wait for GPU completion every frame. Upper
  bound on per-frame round-trip; used for same-session algorithm A/B.

| metric | value | convention | environment |
| --- | --- | --- | --- |
| particles end-to-end | 200,000 @ ~120fps · 66,000 @ ~144fps | display | RTX 4060 Laptop, playground probe |
| particle compute (grid), sync | 16k → 200k: 3.6 → 36 ms/frame | sync | `npm run bench` → docs/BENCHMARK.md |
| neighborhood algorithms | grid ~O(N), 8.5× faster than brute force at 66k | sync A/B | same-session |
| bundle size | core gzip ~15kB incl. typed schemas + pack platform (all entries share one context) | — | enforced by `npm run build` |

So yes: if you benchmark grid @200k with a per-frame `device.queue.onSubmittedWorkDone()`
you will see ~30ms — that is the sync-latency column, not a contradiction.

## Three design rules

1. **Level-2 works in 5 minutes, level-1 has no ceiling** — `rawKernel` and
   native `GPUBuffer` escape hatches stay open;
2. **Errors speak human** — WGSL compile failures map back to your line numbers;
3. **Benchmarks are documentation** — every published number is reproducible;
   gzip budgets are enforced by `npm run build`.

## Verification

41+ automated probes run on a real GPU via a headless Chromium harness
(included: `tests/` + `scripts/verify.mjs`) — including a **physics
equivalence regression** that fails the build if the neighborhood algorithms
(n2 / tiled / grid) ever produce divergent structures, plus scan-invariant and
frozen-band checks that catch partial-grid failures deterministically.

**In CI:** the correctness subset (smoke / packages / grid invariants) runs on
every push against Chrome's SwiftShader WebGPU — no GPU required — so the
physics cannot silently regress between machines. fps-class probes are
meaningless on a CPU adapter and stay on real hardware by design.

## Support matrix

| browser | status |
| --- | --- |
| Chrome / Edge 113+ (incl. headless) | ✅ all validation runs here (RTX 4060, D3D backend) |
| Safari 18+ / Firefox | 🔶 should work with WebGPU enabled; untested — issues welcome |
| WebGL2 / no WebGPU | ❌ no fallback (by design); `detect.html` can diagnose |

## License

[MIT](LICENSE)
