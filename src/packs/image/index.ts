import { GpuContext } from '../../core/context.ts';
import { CompileError } from '../../core/errors.ts';

/**
 * image 包:GPU 图像滤镜管线。source(WebGPU 纹理)→ 逐算子 ping-pong → 目标 canvas。
 * 当初 Phase 0 推迟的卷积 spike 在这里正式落地。
 */
export type ImageOp =
  | { op: 'grayscale' }
  | { op: 'invert' }
  | { op: 'edge'; amount?: number }
  | { op: 'blur'; radius?: number }
  | { op: 'sharpen'; amount?: number }
  | { op: 'brightness'; value: number }
  | { op: 'contrast'; value: number };

export interface ApplyImageResult {
  width: number;
  height: number;
  passes: number;
  /** GPU 直读结果像素(RGBA,每行按 256B 对齐;headless 里 drawImage 会拿到空帧,断言必须走这里) */
  readback(): Promise<Uint8Array>;
}

const OPS = ['grayscale', 'invert', 'edge', 'blur', 'sharpen', 'brightness', 'contrast'] as const;
const OP_IDS: Record<string, number> = { grayscale: 0, invert: 1, edge: 2, blur: 3, sharpen: 4, brightness: 5, contrast: 6 };

export async function applyImage(
  source: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  target: HTMLCanvasElement,
  ops: ImageOp[],
): Promise<ApplyImageResult> {
  if (ops.length === 0) throw new Error('applyImage 需要至少一个算子');
  const width = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const height = 'naturalHeight' in source ? source.naturalHeight : source.height;
  const ctx = await GpuContext.get();
  const device = ctx.device;

  // 源纹理
  const srcTex = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  // 上传走 2D getImageData + writeTexture(纯 CPU 路径):
  // 实测 headless 里 copyExternalImageToTexture 从 canvas 上传拿不到内容(合成器限制)
  const c2d = document.createElement('canvas');
  c2d.width = width; c2d.height = height;
  const sctx = c2d.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(source as CanvasImageSource, 0, 0);
  const imageData = sctx.getImageData(0, 0, width, height);
  device.queue.writeTexture({ texture: srcTex }, imageData.data, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);

  // 中间纹理池
  const pool: GPUTexture[] = [];
  const temp = () => {
    const t = pool.pop() ?? device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    return t;
  };

  const module = device.createShaderModule({ code: shader(), label: 'image-filters' });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) throw new CompileError('image-filters', errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });

  const makePass = (input: GPUTexture, output: GPUTexture | null, op: ImageOp): GPUCommandBuffer => {
    const p = op as { radius?: number; amount?: number; value?: number };
    const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const ub = new ArrayBuffer(32);
    const uv = new DataView(ub);
    uv.setUint32(0, OP_IDS[op.op] ?? 0, true);
    uv.setUint32(4, Math.max(1, Math.min(4, Math.round(p.radius ?? 1))), true);
    uv.setFloat32(8, width, true);
    uv.setFloat32(12, height, true);
    uv.setFloat32(16, p.amount ?? 1, true);
    uv.setFloat32(20, p.value ?? 0, true);
    device.queue.writeBuffer(uniform, 0, ub);
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: input.createView() },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: output
        ? [{ view: output.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }]
        : [],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    return enc.finish();
  };

  let cur = srcTex;
  let passes = 0;
  for (const op of ops) {
    const out = temp();
    device.queue.submit([makePass(cur, out, op)]);
    if (cur !== srcTex) pool.push(cur);
    cur = out;
    passes++;
  }

  // 最终结果上屏到目标 canvas
  const gpuCtx = target.getContext('webgpu');
  if (!gpuCtx) throw new Error('目标 canvas.getContext("webgpu") 返回空');
  const format = navigator.gpu.getPreferredCanvasFormat();
  gpuCtx.configure({ device, format, alphaMode: 'opaque' });
  const blit = device.createShaderModule({
    code: `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) v: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4f(p[v], 0.0, 1.0);
  o.uv = (p[v] + vec2f(1.0)) * 0.5;
  o.uv.y = 1.0 - o.uv.y;
  return o;
}
@fragment fn fs(i: VsOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, i.uv);
  return vec4f(c.rgb, 1.0);
}
`,
    label: 'image-blit',
  });
  const blitPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: blit, entryPoint: 'vs' },
    fragment: { module: blit, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: gpuCtx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
  });
  pass.setPipeline(blitPipeline);
  pass.setBindGroup(0, device.createBindGroup({
    layout: blitPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
      { binding: 1, resource: cur.createView() },
    ],
  }));
  pass.draw(3);
  pass.end();
  device.queue.submit([enc.finish()]);

  srcTex.destroy();
  for (const t of pool) t.destroy();

  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const staging = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  return {
    width,
    height,
    passes,
    async readback(): Promise<Uint8Array> {
      // cur = 最后一个输出纹理(不在销毁池里);按行 256B 对齐拷回
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: cur }, { buffer: staging, bytesPerRow, rowsPerImage: height }, [width, height]);
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const ab = staging.getMappedRange().slice(0);
      staging.unmap();
      staging.destroy();
      return new Uint8Array(ab);
    },
  };
}

function shader(): string {
  return /* wgsl */ `
struct U {
  op: u32, radius: u32,
  w: f32, h: f32, amount: f32, value: f32,
  _p0: u32, _p1: u32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) v: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4f(p[v], 0.0, 1.0);
  o.uv = (p[v] + vec2f(1.0)) * 0.5;
  o.uv.y = 1.0 - o.uv.y;
  return o;
}

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs(i: VsOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, i.uv).rgb;
  let op = u.op;

  if (op == 0u) { // grayscale
    let g = vec3f(lum(c));
    return vec4f(g, 1.0);
  }
  if (op == 1u) { // invert
    return vec4f(1.0 - c, 1.0);
  }
  if (op == 2u) { // edge (sobel 幅值)
    let e = 1.0 / vec2f(u.w, u.h);
    let t00 = textureSample(tex, samp, i.uv + vec2f(-e.x, -e.y)).rgb;
    let t10 = textureSample(tex, samp, i.uv + vec2f(0.0, -e.y)).rgb;
    let t20 = textureSample(tex, samp, i.uv + vec2f(e.x, -e.y)).rgb;
    let t01 = textureSample(tex, samp, i.uv + vec2f(-e.x, 0.0)).rgb;
    let t21 = textureSample(tex, samp, i.uv + vec2f(e.x, 0.0)).rgb;
    let t02 = textureSample(tex, samp, i.uv + vec2f(-e.x, e.y)).rgb;
    let t12 = textureSample(tex, samp, i.uv + vec2f(0.0, e.y)).rgb;
    let t22 = textureSample(tex, samp, i.uv + vec2f(e.x, e.y)).rgb;
    let sx = (t22 + 2.0 * t21 + t02) - (t00 + 2.0 * t01 + t20);
    let sy = (t02 + 2.0 * t12 + t22) - (t00 + 2.0 * t10 + t20);
    let g = sqrt(vec3f(dot(sx, sx) / 3.0 + dot(sy, sy) / 3.0));
    return vec4f(clamp(g * u.amount, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  if (op == 3u) { // box blur,radius 折叠成步长采样
    let r = f32(u.radius);
    let e = vec2f(1.0) / vec2f(u.w, u.h) * r;
    var s = vec3f(0.0);
    var n = 0.0;
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        s = s + textureSample(tex, samp, i.uv + vec2f(f32(dx), f32(dy)) * e * 0.6).rgb;
        n = n + 1.0;
      }
    }
    return vec4f(s / n, 1.0);
  }
  if (op == 4u) { // sharpen(3x3 卷积)
    let e = vec2f(1.0) / vec2f(u.w, u.h);
    let c0 = textureSample(tex, samp, i.uv).rgb;
    let t00 = textureSample(tex, samp, i.uv + vec2f(-e.x, -e.y)).rgb;
    let t10 = textureSample(tex, samp, i.uv + vec2f(0.0, -e.y)).rgb;
    let t20 = textureSample(tex, samp, i.uv + vec2f(e.x, -e.y)).rgb;
    let t01 = textureSample(tex, samp, i.uv + vec2f(-e.x, 0.0)).rgb;
    let t21 = textureSample(tex, samp, i.uv + vec2f(e.x, 0.0)).rgb;
    let t02 = textureSample(tex, samp, i.uv + vec2f(-e.x, e.y)).rgb;
    let t12 = textureSample(tex, samp, i.uv + vec2f(0.0, e.y)).rgb;
    let t22 = textureSample(tex, samp, i.uv + vec2f(e.x, e.y)).rgb;
    let k = u.amount;
    let acc = t00 + t10 + t20 + t01 + t21 + t02 + t12 + t22;
    return vec4f(clamp(c0 * (1.0 + 8.0 * k) - acc * k, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  if (op == 5u) { // brightness
    return vec4f(clamp(c + vec3f(u.value), vec3f(0.0), vec3f(1.0)), 1.0);
  }
  // contrast
  let g = vec3f(0.5);
  return vec4f(clamp(g + (c - g) * u.value, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
}
