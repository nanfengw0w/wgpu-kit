import { GpuContext } from '../core/context.ts';
import { Buffer } from '../core/buffer.ts';
import { UsageError, ERR } from '../core/errors.ts';

/**
 * scan —— u32 前缀和原语(v2.0 core 原语层第一个成员)。
 *
 * 双档实现,按 count 自动选择:
 *   单档(默认,N ≤ 65536):单 workgroup 分块循环 + workgroup 级 carry,
 *     dispatch(1)。barrier 在单 workgroup 内是合法同步,正确性不依赖时序。
 *   多档(N > 65536):三级,全部以独立 pass 写入调用方 encoder —— 铁律:
 *     同一 dispatch 内跨 workgroup 无内存可见性保证,必须 pass 边界。
 *     ① scan_block :各 workgroup 扫自己的 8192 元素段(strided 局部和 +
 *        Hillis-Steele),写段内排他前缀与 blockSums[wid] 段总和
 *     ② scan_bases :单 workgroup 分块循环扫 blockSums(排他,原地)
 *     ③ add_bases  :各 workgroup 给段内元素加基址(含前缀语义时并回 src 元素)
 *
 * 语义:exclusive: dst[i] = Σ src[0..i);inclusive: dst[i] = Σ src[0..i]。
 * u32 回绕算术,与 CPU 位一致(探针验证)。
 *
 * 历史注记:scan 在 grid/particles 各手写过一遍,4 条相关提交中 3 条是修复
 * (多 workgroup 可见性、cellFill 游标语义、dispatch 截断)。本原语是那些
 * 教训的制度化。
 */

const WG = 256;
const ITEMS = 32;
const SEGMENT = WG * ITEMS; // 多档段大小 8192
const TIER1_CAP = WG * WG; // 单档上限 65536

const WGSL = /* wgsl */ `
struct Params {
  count: u32, exclusive: u32, blockCount: u32, _p0: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read_write> blockSums: array<u32>;

var<workgroup> partial: array<u32, ${WG}>;
var<workgroup> carry: u32;

// —— 单档:单 workgroup 分块循环(carry 串接),dispatch(1) ——
@compute @workgroup_size(${WG})
fn scan_single(@builtin(local_invocation_id) lid: vec3u) {
  let tid = lid.x;
  let wg = ${WG}u;
  let count = params.count;
  let numChunks = (count + wg - 1u) / wg;
  if (tid == 0u) { carry = 0u; }
  workgroupBarrier();
  for (var ch = 0u; ch < numChunks; ch = ch + 1u) {
    let i = ch * wg + tid;
    let inRange = i < count;
    let v = select(0u, src[i], inRange);
    partial[tid] = v;
    workgroupBarrier();
    var offset = 1u;
    loop {
      if (offset >= wg) { break; }
      var x = 0u;
      if (tid >= offset) { x = partial[tid - offset]; }
      workgroupBarrier();
      if (tid >= offset) { partial[tid] = partial[tid] + x; }
      workgroupBarrier();
      offset = offset << 1u;
    }
    if (inRange) {
      let incl = partial[tid];
      dst[i] = select(carry + incl, carry + incl - v, params.exclusive == 1u);
    }
    workgroupBarrier();
    if (tid == wg - 1u) { carry = carry + partial[wg - 1u]; }
    workgroupBarrier();
  }
}

// —— 多档①:各 workgroup 扫自己的 8192 元素段 ——
@compute @workgroup_size(${WG})
fn scan_block(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let tid = lid.x;
  let segBase = wid.x * ${SEGMENT}u;
  // 每线程持连续 ${ITEMS} 项(线性顺序)——scan 的前缀必须跟随线性索引,
  // strided 分治只对 order-independent 的 reduce 成立
  var local = 0u;
  for (var j = 0u; j < ${ITEMS}u; j = j + 1u) {
    let i = segBase + tid * ${ITEMS}u + j;
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
  // 段内排他前缀(全局基址由 pass③ 加)
  var run = 0u;
  if (tid > 0u) { run = partial[tid - 1u]; }
  for (var j = 0u; j < ${ITEMS}u; j = j + 1u) {
    let i = segBase + tid * ${ITEMS}u + j;
    if (i < params.count) { dst[i] = run; run = run + src[i]; }
  }
  if (tid == ${WG - 1}u) { blockSums[wid.x] = partial[${WG - 1}u]; }
}

// —— 多档②:单 workgroup 分块扫块和(排他,原地;块数 ≤ ${TIER1_CAP}) ——
@compute @workgroup_size(${WG})
fn scan_bases(@builtin(local_invocation_id) lid: vec3u) {
  let tid = lid.x;
  let wg = ${WG}u;
  let count = params.count; // paramsB.count = 块数(约定)
  let numChunks = (count + wg - 1u) / wg;
  if (tid == 0u) { carry = 0u; }
  workgroupBarrier();
  for (var ch = 0u; ch < numChunks; ch = ch + 1u) {
    let i = ch * wg + tid;
    let inRange = i < count;
    let v = select(0u, blockSums[i], inRange);
    partial[tid] = v;
    workgroupBarrier();
    var offset = 1u;
    loop {
      if (offset >= wg) { break; }
      var x = 0u;
      if (tid >= offset) { x = partial[tid - offset]; }
      workgroupBarrier();
      if (tid >= offset) { partial[tid] = partial[tid] + x; }
      workgroupBarrier();
      offset = offset << 1u;
    }
    if (inRange) {
      blockSums[i] = carry + partial[tid] - v; // 排他
    }
    workgroupBarrier();
    if (tid == wg - 1u) { carry = carry + partial[wg - 1u]; }
    workgroupBarrier();
  }
}

// —— 多档③:加基址(排他:+base;含:+base+src) ——
@compute @workgroup_size(${WG})
fn add_bases(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let tid = lid.x;
  let base = blockSums[wid.x];
  let segBase = wid.x * ${SEGMENT}u;
  for (var j = 0u; j < ${ITEMS}u; j = j + 1u) {
    let i = segBase + j * ${WG}u + tid;
    if (i < params.count) {
      let v = select(0u, src[i], params.exclusive == 0u);
      dst[i] = dst[i] + base + v;
    }
  }
}
`;

const USIZE = 16;
const BLOCK_COUNT_CAP = TIER1_CAP; // scan_bases 单 workgroup 分块可扫至 65536 块 → N ≤ 536M

export interface Scan {
  /** 幂等准备:解析上下文与内部 uniform。encode 前必须完成 */
  prepare(): Promise<void>;
  /**
   * 同步编码:把前缀和命令写入调用方 encoder(多档时为 1~3 个独立 pass)。
   * src/dst 为 u32 storage 用法的原生 GPUBuffer(count=0 时为 no-op)。
   * encode-once-per-submit 合同(与 elementKernel 一致):paramsA 是实例共享的,
   * 一次提交前重复 encode 会覆盖参数快照——guard 拒绝之;自定义 submit 流程
   * 在提交后调用 endSubmit() 重置。
   */
  encode(encoder: GPUCommandEncoder, src: GPUBuffer, dst: GPUBuffer, count: number, exclusive?: boolean): void;
  /** [v2.0] 自定义 submit 流程完成后调用:重置 encode-once 检测 */
  endSubmit(): void;
  /** 高级:解除 encode-once 检测(自行承担参数覆盖语义) */
  resetEncodeGuard(): void;
  /** 便捷路径:内部 encoder + 提交 */
  run(src: Buffer, dst: Buffer, count: number, exclusive?: boolean): Promise<void>;
  destroy(): void;
}

export function createScan(): Scan {
  let ctx: GpuContext | null = null;
  let pipelines: {
    pSingle: GPUComputePipeline;
    pBlock: GPUComputePipeline;
    pBases: GPUComputePipeline;
    pAdd: GPUComputePipeline;
  } | null = null;
  let paramsA: GPUBuffer | null = null; // count/exclusive(pSingle/pBlock/pAdd)
  let paramsB: GPUBuffer | null = null; // blockCount(pBases)
  let blockSums: GPUBuffer | null = null;
  let blockSumsCap = 0;
  // encode-once-per-submit 合同(外部审查复审 P1-1):paramsA 共享,提交前
  // 重复 encode 会覆盖参数;guard 在校验后打开、run/endSubmit 关闭
  let guardArmed = true;
  let guardOpen = false;

  const writeParams = (buf: GPUBuffer, count: number, exclusive: boolean, blockCount: number) => {
    const b = new ArrayBuffer(USIZE);
    const v = new DataView(b);
    v.setUint32(0, count, true);
    v.setUint32(4, exclusive ? 1 : 0, true);
    v.setUint32(8, blockCount, true);
    v.setUint32(12, 0, true);
    ctx!.device.queue.writeBuffer(buf, 0, b);
  };

  return {
    async prepare(): Promise<void> {
      if (ctx && pipelines) return;
      ctx = await GpuContext.get();
      const device = ctx.device;
      const module = device.createShaderModule({ code: WGSL, label: 'primitives-scan' });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length > 0) {
        throw new UsageError(ERR.COMPILE, `scan primitive WGSL error: ${errors[0]!.message.slice(0, 160)}`);
      }
      const mk = (ep: string) =>
        device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: ep } });
      pipelines = {
        pSingle: mk('scan_single'),
        pBlock: mk('scan_block'),
        pBases: mk('scan_bases'),
        pAdd: mk('add_bases'),
      };
      paramsA = device.createBuffer({ size: USIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'scan-params-a' });
      paramsB = device.createBuffer({ size: USIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'scan-params-b' });
    },

    encode(encoder: GPUCommandEncoder, src: GPUBuffer, dst: GPUBuffer, count: number, exclusive = true): void {
      if (!ctx || !pipelines || !paramsA || !paramsB) {
        throw new UsageError(ERR.USAGE, 'scan.encode called before prepare() — await scan.prepare() first');
      }
      // encode-once guard 在参数校验**之后**打开(P2-1 教训:校验抛错不锁闸)
      if (guardArmed && guardOpen) {
        throw new UsageError(ERR.USAGE, 'scan.encode called twice before submit — shared params would be overwritten (encode-once-per-submit contract). Call endSubmit() after your submit, or use scan.run().');
      }
      if (!Number.isInteger(count) || count < 0) {
        throw new UsageError(ERR.USAGE, `scan count must be a non-negative integer, got ${String(count)}`);
      }
      if (count === 0) return; // 空输入 no-op(不打开 guard)
      if (count > SEGMENT * BLOCK_COUNT_CAP) {
        throw new UsageError(ERR.USAGE, `scan count ${count} exceeds supported cap ${SEGMENT * BLOCK_COUNT_CAP}`);
      }
      if (guardArmed) guardOpen = true;
      const device = ctx.device;

      if (count <= TIER1_CAP) {
        // —— 单档:dispatch(1) ——
        writeParams(paramsA, count, exclusive, 0);
        const bg = device.createBindGroup({
          layout: pipelines.pSingle.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: paramsA } },
            { binding: 1, resource: { buffer: src } },
            { binding: 2, resource: { buffer: dst } },
          ],
        });
        const pass = encoder.beginComputePass({ label: 'scan-single' });
        pass.setPipeline(pipelines.pSingle);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(1);
        pass.end();
        return;
      }

      // —— 多档:三级,独立 pass ——
      const blockCount = Math.ceil(count / SEGMENT);
      if (blockCount > blockSumsCap) {
        blockSums?.destroy();
        blockSums = device.createBuffer({
          size: blockCount * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          label: 'scan-blocksums',
        });
        blockSumsCap = blockCount;
      }
      writeParams(paramsA, count, exclusive, blockCount);
      writeParams(paramsB, blockCount, true, 0);

      const bgBlock = device.createBindGroup({
        layout: pipelines.pBlock.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsA } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: dst } },
          { binding: 3, resource: { buffer: blockSums! } },
        ],
      });
      const bgBases = device.createBindGroup({
        layout: pipelines.pBases.getBindGroupLayout(0),
        // scan_bases 只静态使用 params(0) 与 blockSums(3) —— 多给即校验失败
        entries: [
          { binding: 0, resource: { buffer: paramsB } },
          { binding: 3, resource: { buffer: blockSums! } },
        ],
      });
      const bgAdd = device.createBindGroup({
        layout: pipelines.pAdd.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsA } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: dst } },
          { binding: 3, resource: { buffer: blockSums! } },
        ],
      });

      // ① 段内扫 + 块和
      const pass1 = encoder.beginComputePass({ label: 'scan-block' });
      pass1.setPipeline(pipelines.pBlock);
      pass1.setBindGroup(0, bgBlock);
      pass1.dispatchWorkgroups(blockCount);
      pass1.end();
      // ② 扫块和(独立 pass:跨 workgroup 可见性以 pass 边界保证)
      const pass2 = encoder.beginComputePass({ label: 'scan-bases' });
      pass2.setPipeline(pipelines.pBases);
      pass2.setBindGroup(0, bgBases);
      pass2.dispatchWorkgroups(1);
      pass2.end();
      // ③ 加基址(独立 pass)
      const pass3 = encoder.beginComputePass({ label: 'scan-add' });
      pass3.setPipeline(pipelines.pAdd);
      pass3.setBindGroup(0, bgAdd);
      pass3.dispatchWorkgroups(blockCount);
      pass3.end();
    },

    async run(src: Buffer, dst: Buffer, count: number, exclusive = true): Promise<void> {
      await this.prepare();
      const enc = ctx!.device.createCommandEncoder();
      this.encode(enc, src.gpuBuffer, dst.gpuBuffer, count, exclusive);
      ctx!.device.queue.submit([enc.finish()]);
      guardOpen = false;
    },

    endSubmit(): void {
      guardOpen = false;
    },

    resetEncodeGuard(): void {
      guardArmed = false;
    },

    destroy(): void {
      blockSums?.destroy();
      blockSums = null;
      blockSumsCap = 0;
      paramsA?.destroy();
      paramsB?.destroy();
      paramsA = paramsB = null;
      pipelines = null;
    },
  };
}
