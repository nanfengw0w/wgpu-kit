# Compute and render on an application-owned device

[简体中文](COMPUTE-RENDER.zh-CN.md) · [Complete runnable example](examples/shared-device.html)

The example requests a WebGPU adapter and device, adopts that device in wgpu-kit,
computes an animated color grid and renders it through native WebGPU. The compute
and render passes use the same storage buffer and command encoder. Rendering
does not read the data back to JavaScript.

## Run locally

In a source checkout, use Node.js 22 and build from the repository root:

```sh
npm ci
npm run build
```

Serve that root directory over HTTP on localhost. Any static server that serves
`.js` files as JavaScript works; for example, if Python is available:

```sh
python -m http.server 8000 --bind 127.0.0.1
```

Open [http://127.0.0.1:8000/docs/examples/shared-device.html](http://127.0.0.1:8000/docs/examples/shared-device.html)
in a WebGPU-enabled browser. Use HTTP localhost or HTTPS; opening the HTML as a
`file://` URL will not provide the required module-loading environment.

For an installed package that contains this example, serve the package root
instead, such as `node_modules/wgpu-kit`. The packaged `dist/` is already built;
there is no source build step inside that installed package. The HTML imports
`../../dist/index.js`, so the same relative layout works in both places. It uses
no CDN, bundler or external JavaScript dependencies. An installation made before
this example was included will need the source checkout instead.

## Follow the data

1. The application calls `requestAdapter()` and `requestDevice()` itself.
2. `GpuContext.adopt(device)` runs before `GpuBuffer.create()`, `prepare()` or
   `createBatch()`. Importing the library does not create a GPU context. Adoption
   after any operation that initialized the shared context is rejected.
3. `import { Buffer as GpuBuffer }` gives the kit buffer a local name that can
   coexist with Node's `Buffer`. `GpuBuffer.create('vec4f', 64 * 64)` allocates
   storage on the adopted device, and `await kernel.prepare()` compiles compute.
4. The native renderer binds `colors.gpuBuffer` as a read-only storage array.
   The kit's buffer is storage-backed; it is not allocated with the `VERTEX`
   usage flag. This example reads it in the fragment shader.
5. Each frame creates one batch, encodes compute, then appends a native render
   pass through `batch.encoder`. Pass order makes the computed colors available
   to rendering in that submission. `batch.submit()` owns finishing and submitting
   this encoder; do not finish or submit it separately.

`batch.submit()` returns after submission, without waiting for GPU completion.
The frame loop never calls `Buffer.read()`, `mapAsync()` or `GpuContext.sync()`.
The `data-frames` canvas attribute and `wgpu-kit-frame` event report submitted
frames for browser checks; they are not completed or presented frame counts.

The HTML includes error/device-loss reporting and a Stop button. Only one async
frame can be pending. If stopped while awaiting `createBatch()`, it cancels that
batch before encoding. The page destroys the device because the page created
and owns it. A component using another application's device should destroy only
its own resources, leaving the shared device alive.

## When the application owns a native encoder

Managed batching is optional. After the same setup, the corresponding frame can
use an application-owned encoder instead:

```js
const encoder = device.createCommandEncoder();
kernel.encode(encoder, { colors }, { size, time });

const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: context.getCurrentTexture().createView(),
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
    loadOp: 'clear', storeOp: 'store',
  }],
});
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindings);
pass.draw(3);
pass.end();

device.queue.submit([encoder.finish()]);
kernel.endSubmit();
```

Call `encode()` outside an open pass. Without `{ batch }`, each kernel instance
allows one nonzero encode before submission because it shares one uniform
snapshot. Call `endSubmit()` after the application's submission to re-arm it.
Use separate instances, separate submissions or a managed batch for repeats.

If the application abandons a native encoder after encoding, it must never
submit that encoder later. Once it is definitively discarded, explicitly call
`endSubmit()` on the kernel instances used only by that abandoned encoder before
retrying. This clears the guard; it does not submit work or undo resource writes
or `PingPong.swap()`. Do not re-arm an instance while another encoder that used
it is still pending. `resetEncodeGuard()` permanently disables the check; it is
not the routine recovery step. A managed batch needs no `endSubmit()`; cancel an
open batch with `batch.cancel()` and restore any caller-owned CPU state yourself.

This is native WebGPU interop. Sharing a device does not by itself create a
zero-copy integration with a higher-level renderer. `wgpu-kit/three` remains a
separate snapshot adapter that reads positions back to the CPU.
