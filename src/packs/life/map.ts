import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { CompileError } from '../../core/errors.ts';

/**
 * MapRenderer:把一张 f32 浓度图(storage buffer,W×H)画到全屏。
 * life 包三个模拟(图灵/粘菌/流场)共用的"浓度图上屏"组件。
 * colormap 在 wgsl 里按名字生成;maxV 做线性归一,gamma 提对比。
 */
export type Colormap = 'amber' | 'ice' | 'duotone' | 'mono';

const COLORMAPS: Record<Colormap, string> = {
  mono: 'vec3f(v)',
  amber: `vec3f(
    1.35 * v * v,
    0.9 * v * v * v + 0.25 * v * (1.0 - v),
    0.15 * v * v * v
  )`,
  ice: `vec3f(0.15 * v * v, 0.55 * v * v + 0.2 * v, 1.1 * v)`,
  duotone: `mix(vec3f(0.02, 0.03, 0.08), vec3f(0.42, 0.78, 1.0), v) + vec3f(0.9, 0.6, 0.25) * v * v * v * 0.6`,
};

export function mapFragment(colormap: Colormap): string {
  return /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@group(0) @binding(0) var<uniform> vp: vec4f; // w, h, maxV, gamma
@group(0) @binding(1) var<storage, read> map: array<f32>;

@vertex
fn vs(@builtin(vertex_index) v: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VsOut;
  out.pos = vec4f(p[v], 0.0, 1.0);
  out.uv = (p[v] + vec2f(1.0)) * 0.5;
  out.uv = vec2f(out.uv.x, 1.0 - out.uv.y); // buffer 行 0 = 画面顶部
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let w = u32(vp.x);
  let x = min(u32(in.uv.x * vp.x), w - 1u);
  let y = min(u32(in.uv.y * vp.y), u32(vp.y) - 1u);
  let v = pow(clamp(abs(map[y * w + x]) * vp.z, 0.0, 1.0), vp.w);
  let c = ${COLORMAPS[colormap]};
  return vec4f(c, 1.0);
}
`;
}

export class MapRenderer {
  #ctx: GpuContext;
  #gpuCtx: GPUCanvasContext;
  #pipeline: GPURenderPipeline;
  #uniform: GPUBuffer;
  #bgCache = new Map<number, GPUBindGroup>();
  #ids = new WeakMap<GPUBuffer, number>();

  private constructor(ctx: GpuContext, gpuCtx: GPUCanvasContext, pipeline: GPURenderPipeline, uniform: GPUBuffer) {
    this.#ctx = ctx; this.#gpuCtx = gpuCtx; this.#pipeline = pipeline; this.#uniform = uniform;
  }

  static async create(
    canvas: HTMLCanvasElement,
    opts: { width: number; height: number; maxV: number; gamma?: number; colormap: Colormap },
  ): Promise<MapRenderer> {
    const ctx = await GpuContext.get();
    const gpuCtx = canvas.getContext('webgpu');
    if (!gpuCtx) throw new Error('canvas.getContext("webgpu") 返回空');
    const format = navigator.gpu.getPreferredCanvasFormat();
    gpuCtx.configure({ device: ctx.device, format, alphaMode: 'opaque' });

    const module = ctx.device.createShaderModule({ code: mapFragment(opts.colormap), label: 'life-map-render' });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) throw new CompileError('life-map-render', errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);

    const pipeline = ctx.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const uniform = ctx.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([opts.width, opts.height, opts.maxV, opts.gamma ?? 1.0]));
    return new MapRenderer(ctx, gpuCtx, pipeline, uniform);
  }

  render(map: Buffer): void {
    let id = this.#ids.get(map.gpuBuffer);
    if (id === undefined) { id = this.#bgCache.size + 1; this.#ids.set(map.gpuBuffer, id); }
    let bg = this.#bgCache.get(id);
    if (!bg) {
      bg = this.#ctx.device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#uniform } },
          { binding: 1, resource: { buffer: map.gpuBuffer } },
        ],
      });
      this.#bgCache.set(id, bg);
    }
    const enc = this.#ctx.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.#gpuCtx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    this.#ctx.device.queue.submit([enc.finish()]);
  }
}
