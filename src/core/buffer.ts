import { TYPES, type ScalarKind } from './layout.ts';
import { GpuContext } from './context.ts';
import { UsageError } from './errors.ts';

const TYPED_CTORS: Record<'Float32Array' | 'Int32Array' | 'Uint32Array', typeof Float32Array | typeof Int32Array | typeof Uint32Array> = {
  Float32Array, Int32Array, Uint32Array,
};

/** TS 5.7+ 的 TypedArray 泛型:显式钉在 ArrayBuffer 上,兼容 WebGPU 的 GPUAllowSharedBufferSource */
export type NumArray = Float32Array<ArrayBuffer> | Int32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;

/**
 * 显存数组的类型化封装。替用户做三件事:
 * ① 算字节数与 usage;② write() 校验长度;③ read() 内置 staging buffer(mapAsync 陷阱全包掉)。
 * `gpuBuffer` 原生句柄永远可取(章程原则 1:逃生舱常开)。
 */
export class Buffer<K extends ScalarKind = ScalarKind> {
  readonly kind: K;
  readonly length: number;
  readonly gpuBuffer: GPUBuffer;

  #ctx: GpuContext;
  #byteLength: number;
  #staging: GPUBuffer | null = null;

  private constructor(ctx: GpuContext, kind: K, length: number, gpuBuffer: GPUBuffer) {
    this.#ctx = ctx;
    this.kind = kind;
    this.length = length;
    this.gpuBuffer = gpuBuffer;
    this.#byteLength = length * TYPES[kind].size;
  }

  static async create<K extends ScalarKind>(kind: K, length: number): Promise<Buffer<K>> {
    if (!Number.isInteger(length) || length <= 0) {
      throw new UsageError(`Buffer 长度必须是正整数,收到: ${String(length)}`);
    }
    const def = TYPES[kind];
    if (!def) throw new UsageError(`未知类型 "${String(kind)}",可用: ${Object.keys(TYPES).join(', ')}`);
    const ctx = await GpuContext.get();
    const gpuBuffer = ctx.device.createBuffer({
      size: length * def.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      label: `wgpu-kit Buffer<${kind}>[${length}]`,
    });
    return new Buffer<K>(ctx, kind, length, gpuBuffer);
  }

  /** 校验并写入(CPU → GPU) */
  write(data: NumArray): void {
    const ctor = TYPED_CTORS[TYPES[this.kind].typed];
    if (!(data instanceof ctor)) {
      throw new UsageError(`Buffer<${this.kind}>.write 需要 ${TYPES[this.kind].typed},收到 ${data.constructor?.name ?? typeof data}`);
    }
    const expected = this.length * TYPES[this.kind].comps;
    if (data.length !== expected) {
      throw new UsageError(`Buffer<${this.kind}>[${this.length}].write 需要 ${expected} 个分量,收到 ${data.length}`);
    }
    this.#ctx.device.queue.writeBuffer(this.gpuBuffer, 0, data);
  }

  /** GPU → CPU:内部 staging buffer + mapAsync,mapAsync 的异步陷阱由库承担 */
  async read(): Promise<NumArray> {
    const def = TYPES[this.kind];
    if (!this.#staging) {
      this.#staging = this.#ctx.device.createBuffer({
        size: this.#byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        label: `wgpu-kit staging[${this.length}]`,
      });
    }
    const enc = this.#ctx.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.gpuBuffer, 0, this.#staging, 0, this.#byteLength);
    this.#ctx.device.queue.submit([enc.finish()]);
    await this.#staging.mapAsync(GPUMapMode.READ);
    const ab = this.#staging.getMappedRange().slice(0);
    this.#staging.unmap();
    if (def.typed === 'Float32Array') return new Float32Array(ab);
    if (def.typed === 'Int32Array') return new Int32Array(ab);
    return new Uint32Array(ab);
  }

  destroy(): void {
    if (this.#staging) { this.#staging.destroy(); this.#staging = null; }
    this.gpuBuffer.destroy();
  }
}
