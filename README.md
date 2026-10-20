[**Open the live demo →**](https://nanfengw0w.github.io/wgpu-kit/)

# wgpu-kit

[![npm](https://img.shields.io/npm/v/wgpu-kit)](https://www.npmjs.com/package/wgpu-kit) [![license MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**WebGPU compute for TypeScript: write the kernel, keep data on the GPU, compose the work.**

![wgpu-kit demo](docs/media/showcase.gif)

[API reference](docs/API.md) · [简体中文](README.cn.md)

wgpu-kit handles buffer allocation, binding declarations, uniform layouts, pipeline setup and readbacks. Your compute logic stays in WGSL. It requires a browser with WebGPU.

## What it gives you

- **Control over execution.** Prepare kernels once, encode several steps into your command encoder, then submit the chain. Use `run()` for a single-step convenience path.
- **GPU-resident building blocks.** Prefix scan, reduction and spatial grids expose GPU buffers that subsequent kernels can consume without an intermediate CPU readback.
- **One data declaration.** Schemas provide typed buffer I/O and WGSL struct generation; uniform layouts handle field offsets and alignment.
- **Useful diagnostics.** WGSL compile errors map back to your kernel lines, and buffer/type/length misuse produces descriptive errors.
- **Native access.** Use `Buffer.gpuBuffer`, `GpuContext.device` and full WGSL through `rawKernel`. Adopt an existing device before creating the shared context.

## Start with a compute kernel

```bash
npm install wgpu-kit
```

```ts
import { defineSchema, elementKernel } from 'wgpu-kit';

const Motion = defineSchema({ pos: 'vec2f', vel: 'vec2f' });
const data = await Motion.buffers(1024);
data.vel.write(Array.from({ length: 1024 }, () => ({ x: 1, y: 0 })));

const integrate = elementKernel({
  state: { pos: Motion.fields.pos },
  inputs: { vel: Motion.fields.vel },
  uniforms: { dt: 'f32' },
  code: `
    fn userFn(idx: u32, dt: f32) {
      pos[idx] = pos[idx] + vel[idx] * dt;
    }
  `,
});

await integrate.run(data.raws(), { dt: 0.02 });
```

The schema types the JavaScript data. WGSL function bodies are checked by the GPU shader compiler.

Version 2.1.0 adds independently sized read-only `auxInputs` and an optional dispatch `count` for processing a buffer prefix. See [dispatch options and auxiliary inputs](docs/API.md#dispatch-options-and-auxiliary-inputs) for the contract and a complete example.

## Compose a submission

Continue the example with a second kernel. Both steps use the same GPU buffers.

```ts
import { GpuContext } from 'wgpu-kit';

const damp = elementKernel({
  state: { vel: 'vec2f' },
  uniforms: { friction: 'f32' },
  code: `
    fn userFn(idx: u32, friction: f32) {
      vel[idx] = vel[idx] * friction;
    }
  `,
});

await integrate.prepare();
await damp.prepare();
const { device } = await GpuContext.get();
const encoder = device.createCommandEncoder();

integrate.encode(encoder, data.raws(), { dt: 0.02 });
damp.encode(encoder, { vel: data.vel.raw }, { friction: 0.99 });
device.queue.submit([encoder.finish()]);
integrate.endSubmit();
damp.endSubmit();

console.log(await data.pos.read()); // Read back only when the CPU needs the result.
integrate.destroy();
damp.destroy();
data.destroy();
```

On the native path without a batch, encode each `elementKernel`, scan or reduce instance once per submission, then call its `endSubmit()`. Encoding adds compute passes to the encoder; call it outside an open pass. `run()` submits work; readback or `GpuContext.sync()` waits for GPU completion.

## Repeat a typed kernel in one batch (2.1.0)

`createBatch` and `typedElementKernel` are new in 2.1.0. The typed
entry infers resource names, Buffer kinds and scalar/vector uniform values;
declared uniforms are required. The original `elementKernel` keeps its broad
`Record` calls. Both use the GPU compiler to check WGSL bodies.

```ts
import { Buffer, PingPong, createBatch, typedElementKernel } from 'wgpu-kit';

const state = await PingPong.create({ value: 'f32' }, 6);
const weights = await Buffer.create('f32', 3);
state.current.value.write(new Float32Array([1, 2, 3, 4, 0, 0]));
weights.write(new Float32Array([1, 2, 3]));

const step = typedElementKernel({
  state: { next: 'f32' },
  inputs: { previous: 'f32' },
  auxInputs: { weights: 'f32' },
  uniforms: { delta: 'f32' },
  code: `fn userFn(i: u32, delta: f32) {
    next[i] = previous[i] + weights[i % arrayLength(&weights)] * delta;
  }`,
});
await step.prepare();
const batch = await createBatch();
for (let iteration = 0; iteration < 20; iteration++) {
  step.encode(batch.encoder, {
    next: state.other.value,
    previous: state.current.value,
    weights,
  }, { delta: iteration + 1 }, { count: 4, batch });
  state.swap();
}
batch.submit();
console.log(Array.from(await state.current.value.read()));
// [211, 422, 633, 214, 0, 0]
step.destroy(); state.destroy(); weights.destroy();
```

Await preparation before encoding. Each `{ batch }` encode captures its own
uniforms, so the same kernel may run repeatedly without `endSubmit()`. The batch
owns its encoder: submit with `batch.submit()`, which returns before GPU
completion. An open batch may be cancelled; repeated cancellation is harmless,
while cancelling a submitted batch throws `UsageError`. Cancellation discards
commands and does not undo CPU writes or `PingPong.swap()`. Managed parameter
arenas and scratch use a bounded per-device pool and are reused after GPU
completion. See the [batch contract](docs/API.md#managed-batches-and-typed-kernels-210).

## Build on the core

| Import | Use |
| --- | --- |
| `wgpu-kit` | Kernels, buffers, schemas, scan/reduce and pack registration |
| `wgpu-kit/grid` | Spatial indexing with GPU-resident cell ranges and entity order |
| `wgpu-kit/particles` | Particle simulation and rendering built on the compute layer |
| `wgpu-kit/react` | `ParticleCanvas` |
| `wgpu-kit/three` | Snapshot readback into three.js points |
| `wgpu-kit/media` | Canvas recording |
| `wgpu-kit/observe` | Timing, device callbacks and canvas helpers |
| `wgpu-kit/vite` | WGSL kernel hot reload |

Use `createScan().encode()` and `createReduce().sumInto()` to keep intermediate results on the GPU. `createNeighborGrid()` groups positions by cell for your own neighbor kernels. See the [API reference](docs/API.md) for signatures, layouts and lifecycle details.

For an existing WebGPU application, call `GpuContext.adopt(device)` before any `GpuContext.get()` or `Buffer.create()`. Your resources and wgpu-kit then share that device.

## License

[MIT](LICENSE)
