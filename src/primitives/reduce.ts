import { GpuContext } from '../core/context.ts';
import { Buffer } from '../core/buffer.ts';
import { UsageError, ERR } from '../core/errors.ts';

/**
 * reduce —— u32 求和原语(v2.0 core 原语层)。
 *
 * 数据常驻原则:sumInto 是一等公民(结果留在 GPU 供后续 kernel 消费),
 * sum() 只是它的读回糖。
 * 实现:清零微 pass → 各 workgroup 跨步局部和 + shared 树形归约 →
 * thread 0 对 dst[0] atomicAdd。u32 回绕算术,与 CPU 位一致(探针验证)。
 */

const WG = 256;
const ITEMS = 32;

const WGSL = /* wgsl */ `
struct Params {
  count: u32, _p0: u32, _p1: u32, _p2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<atomic<u32>>;

var<workgroup> partial: array<u32, ${WG}>;

@compute @workgroup_size(1)
fn clear() {
  atomicStore(&dst[0], 0u);
}

@compute @workgroup_size(${WG})
fn reduce(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let tid = lid.x;
  let segBase = wid.x * ${WG * ITEMS}u;
  var local = 0u;
  for (var j = 0u; j < ${ITEMS}u; j = j + 1u) {
    let i = segBase + j * ${WG}u + tid;
    if (i < params.count) { local = local + src[i]; }
  }
  partial[tid] = local;
  workgroupBarrier();
  var offset = 1u;
  loop {
    if (offset >= ${WG}u) { break; }
    var x = 0u;
    if (tid >= offset) { x = partial[tid - offset]; }
    workgroupBarrier();
    if (tid >= offset) { partial[tid] = partial[tid] + x; }
    workgroupBarrier();
    offset = offset << 1u;
  }
  if (tid == ${WG - 1}u) { atomicAdd(&dst[0], partial[${WG - 1}u]); }
}
`;

const USIZE = 16;

export interface Reduce {
  /** 幂等准备。encode 前必须完成 */
  prepare(): Promise<void>;
  /**
   * 同步编码:dst[0] = Σ src[0..count)(覆盖语义;先清零后归约,两个 pass)。
   * dst 为含 atomic<u32> 用法的原生 GPUBuffer;count=0 时仅清零。
   */
  sumInto(encoder: GPUCommandEncoder, src: GPUBuffer, count: number, dst: GPUBuffer): void;
  /** 便捷读回:内部提交 + mapAsync,返回 Σ */
  sum(src: Buffer, count: number): Promise<number>;
  destroy(): void;
}

export function createReduce(): Reduce {
  let ctx: GpuContext | null = null;
  let pipelines: { pClear: GPUComputePipeline; pReduce: GPUComputePipeline } | null = null;
  let params: GPUBuffer | null = null;
  let dstBuf: GPUBuffer | null = null;
  let readBuf: GPUBuffer | null = null;

  return {
    async prepare(): Promise<void> {
      if (ctx && pipelines) return;
      ctx = await GpuContext.get();
      const device = ctx.device;
      const module = device.createShaderModule({ code: WGSL, label: 'primitives-reduce' });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length > 0) {
        throw new UsageError(ERR.COMPILE, `reduce primitive WGSL error: ${errors[0]!.message.slice(0, 160)}`);
      }
      pipelines = {
        pClear: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'clear' } }),
        pReduce: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'reduce' } }),
      };
      params = device.createBuffer({ size: USIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'reduce-params' });
      dstBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'reduce-dst' });
      readBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, label: 'reduce-read' });
    },

    sumInto(encoder: GPUCommandEncoder, src: GPUBuffer, count: number, dst: GPUBuffer): void {
      if (!ctx || !pipelines || !params) {
        throw new UsageError(ERR.USAGE, 'reduce.sumInto called before prepare() — await reduce.prepare() first');
      }
      if (!Number.isInteger(count) || count < 0) {
        throw new UsageError(ERR.USAGE, `reduce count must be a non-negative integer, got ${String(count)}`);
      }
      const device = ctx.device;
      const b = new ArrayBuffer(USIZE);
      const v = new DataView(b);
      v.setUint32(0, count, true);
      device.queue.writeBuffer(params, 0, b);

      const workgroups = Math.ceil(count / (WG * ITEMS));
      // pass① 清零(pass② 的 atomicAdd 需要从 0 起)
      const p0 = encoder.beginComputePass({ label: 'reduce-clear' });
      p0.setPipeline(pipelines.pClear);
      p0.setBindGroup(0, device.createBindGroup({
        layout: pipelines.pClear.getBindGroupLayout(0),
        entries: [{ binding: 2, resource: { buffer: dst } }],
      }));
      p0.dispatchWorkgroups(1);
      p0.end();
      // pass② 归约
      const p1 = encoder.beginComputePass({ label: 'reduce' });
      p1.setPipeline(pipelines.pReduce);
      p1.setBindGroup(0, device.createBindGroup({
        layout: pipelines.pReduce.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: dst } },
        ],
      }));
      p1.dispatchWorkgroups(workgroups);
      p1.end();
    },

    async sum(src: Buffer, count: number): Promise<number> {
      await this.prepare();
      const device = ctx!.device;
      const enc = device.createCommandEncoder();
      this.sumInto(enc, src.gpuBuffer, count, dstBuf!);
      enc.copyBufferToBuffer(dstBuf!, 0, readBuf!, 0, 4);
      device.queue.submit([enc.finish()]);
      await readBuf!.mapAsync(GPUMapMode.READ);
      const v = new DataView(readBuf!.getMappedRange().slice(0)).getUint32(0, true);
      readBuf!.unmap();
      return v;
    },

    destroy(): void {
      params?.destroy();
      dstBuf?.destroy();
      readBuf?.destroy();
      params = dstBuf = readBuf = null;
      pipelines = null;
    },
  };
}
