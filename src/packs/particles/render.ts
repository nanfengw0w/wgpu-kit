import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { CompileError } from '../../core/errors.ts';
import { renderWgsl } from './wgsl.ts';

let nextId = 0;
const ids = new WeakMap<GPUBuffer, number>();
const bufKey = (b: GPUBuffer): number => {
  let id = ids.get(b);
  if (id === undefined) { id = ++nextId; ids.set(b, id); }
  return id;
};

/**
 * 粒子渲染器:instanced quad + storage 只读直通(compute 产物零拷贝进 vertex 阶段)。
 * 属于粒子包内部实现(不进 core);等第二、第三个包出现同类需求再考虑上提。
 */
export class ParticlesRenderer {
  #ctx: GpuContext;
  #gpuCtx: GPUCanvasContext;
  #format: GPUTextureFormat;
  #pipeline: GPURenderPipeline;
  #quad: GPUBuffer;
  #idx: GPUBuffer;
  #species: Buffer;
  #vel: Buffer | null;
  #colorMode: 'species' | 'velocity';
  #rs: GPUBuffer;
  #bgCache = new Map<string, GPUBindGroup>();
  #count: number;

  private constructor(ctx: GpuContext, gpuCtx: GPUCanvasContext, format: GPUTextureFormat, pipeline: GPURenderPipeline, quad: GPUBuffer, idx: GPUBuffer, species: Buffer, count: number, rs: GPUBuffer, vel: Buffer | null, colorMode: 'species' | 'velocity') {
    this.#ctx = ctx; this.#gpuCtx = gpuCtx; this.#format = format;
    this.#pipeline = pipeline; this.#quad = quad; this.#idx = idx;
    this.#species = species; this.#count = count; this.#rs = rs; this.#vel = vel; this.#colorMode = colorMode;
  }

  static async create(canvas: HTMLCanvasElement, opts: { count: number; species: Buffer; vel?: Buffer; color: 'species' | 'velocity'; pointSize: number; worldHalf: number }): Promise<ParticlesRenderer> {
    const ctx = await GpuContext.get();
    const gpuCtx = canvas.getContext('webgpu');
    if (!gpuCtx) throw new Error('canvas.getContext("webgpu") 返回空:该 canvas 已被其他后端占用?');
    const format = navigator.gpu.getPreferredCanvasFormat();
    gpuCtx.configure({ device: ctx.device, format, alphaMode: 'opaque' });

    const module = ctx.device.createShaderModule({ code: renderWgsl(4, opts.color, opts.pointSize), label: 'particles-render' });
    const rsUniform = ctx.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    ctx.device.queue.writeBuffer(rsUniform, 0, new Float32Array([1 / opts.worldHalf, 0, 0, 0]));
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) throw new CompileError('particles-render', errors.map((m) => ({ line: m.lineNum + 1, msg: m.message })), 0);

    const pipeline = ctx.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const quad = ctx.device.createBuffer({ size: 8 * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    ctx.device.queue.writeBuffer(quad, 0, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    const idx = ctx.device.createBuffer({ size: 6 * 2, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    ctx.device.queue.writeBuffer(idx, 0, new Uint16Array([0, 1, 2, 2, 1, 3]));

    return new ParticlesRenderer(ctx, gpuCtx, format, pipeline, quad, idx, opts.species, opts.count, rsUniform, opts.vel ?? null, opts.color);
  }

  /** 渲染一帧(pos 来自 PingPong 当前侧;可传入覆盖数量) */
  render(pos: Buffer, vel: Buffer | null = null, count = this.#count): void {
    const key = `${bufKey(pos.gpuBuffer)}:${vel ? bufKey(vel.gpuBuffer) : 0}`;
    let bg = this.#bgCache.get(key);
    if (!bg) {
      bg = this.#ctx.device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: pos.gpuBuffer } },
          // 各 binding 按管线 layout 裁剪:velocity 模式的着色器不读 species,
          // 物种模式不读 vel——auto layout 会剔除未使用的绑定,bind group 必须同步
          ...(this.#colorMode === 'species' ? [{ binding: 1, resource: { buffer: this.#species.gpuBuffer } }] : []),
          ...(this.#colorMode === 'velocity' && this.#vel && vel ? [{ binding: 2, resource: { buffer: vel.gpuBuffer } }] : []),
          { binding: 3, resource: { buffer: this.#rs } },
        ],
      });
      this.#bgCache.set(key, bg);
    }
    const enc = this.#ctx.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.#gpuCtx.getCurrentTexture().createView(),
        clearValue: { r: 0.012, g: 0.014, b: 0.024, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this.#quad);
    pass.setIndexBuffer(this.#idx, 'uint16');
    pass.drawIndexed(6, count);
    pass.end();
    this.#ctx.device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    this.#quad.destroy();
    this.#idx.destroy();
    this.#bgCache.clear();
  }
}
