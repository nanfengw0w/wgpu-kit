import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { CompileError } from '../../core/errors.ts';

/**
 * NeighborGrid —— 通用空间邻域加速(计数排序 spatial hash)。
 *
 * 从粒子包的 grid 实现中提取的通用能力:任意"每帧需要查邻居"的模拟
 * (流体 SPH / boids / 碰撞 / 聚类)都能用,实测 8.5× 于暴力解、近似 O(N)。
 *
 * 用法:
 *   const grid = await NeighborGrid.create({ count, worldHalf, cellSize });
 *   // 每帧:先 update(按位置建格),再让你的力 kernel 读 cellStart/cellFill/order
 *   grid.update(posBuffer);
 *   // 你的 kernel 通过 order[k] 解引用邻居(或直接用 grid.sortedPos 若启用了 payload)
 *
 * 设计说明:三个 build pass 在同一个 encoder 内提交(实测 pass 边界保证可见性);
 * 粒子包保留其含 payload 排序的专用高性能变体,本包是无 payload 的通用版。
 */
export interface NeighborGridConfig {
  /** 粒子/实体数量 */
  count: number;
  /** 世界半宽(世界 = [-worldHalf, worldHalf]) */
  worldHalf: number;
  /** 格子边长(通常 = 交互半径,使邻域恰为 3×3 格) */
  cellSize: number;
  workgroupSize?: number;
}

export interface NeighborGrid {
  readonly gridSize: number;
  readonly cells: number;
  /** 格内首个有序槽位 */
  cellStart: Buffer;
  /** 格内结束槽位(原子填充) */
  cellFill: Buffer;
  /** 按格子序排列的实体下标(order[slot] = 实体 i) */
  order: Buffer;
  /** 建格:counts → scan → scatter(三 pass,一 encoder,内部提交) */
  update(pos: Buffer): void;
  destroy(): void;
}

const WG = 64;
const SCAN = 256;
const USIZE = 32;

export async function createNeighborGrid(config: NeighborGridConfig): Promise<NeighborGrid> {
  const { count, worldHalf, cellSize, workgroupSize = WG } = config;
  if (!Number.isInteger(count) || count <= 0) throw new Error(`count 必须是正整数,收到 ${String(count)}`);
  if (!(cellSize > 0)) throw new Error(`cellSize 必须为正,收到 ${String(cellSize)}`);

  const gridSize = Math.max(1, Math.ceil((2 * worldHalf) / cellSize));
  const cells = gridSize * gridSize;

  const ctx = await GpuContext.get();
  const device = ctx.device;

  const uniform = device.createBuffer({ size: USIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ngrid-params' });
  const writeUniform = () => {
    const b = new ArrayBuffer(USIZE);
    const v = new DataView(b);
    v.setUint32(0, count, true);
    v.setUint32(4, 0, true);
    v.setFloat32(8, worldHalf, true);
    v.setUint32(12, gridSize, true);
    v.setUint32(16, cells, true);
    v.setUint32(20, 0, true);
    v.setUint32(24, 0, true);
    v.setUint32(28, 0, true);
    device.queue.writeBuffer(uniform, 0, b);
  };
  writeUniform();

  const cellCount = await Buffer.create('u32', cells);
  const cellStart = await Buffer.create('u32', cells);
  const cellFill = await Buffer.create('u32', cells);
  const order = await Buffer.create('u32', count);
  cellCount.write(new Uint32Array(cells));

  const module = device.createShaderModule({ code: gridWgsl(), label: 'ngrid' });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) throw new CompileError('ngrid', errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);

  const pCounts = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_counts' } });
  const pScan = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_scan' } });
  const pScatter = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_scatter' } });

  const bgCounts = (pos: Buffer) => device.createBindGroup({
    layout: pCounts.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: pos.gpuBuffer } },
      { binding: 2, resource: { buffer: cellCount.gpuBuffer } },
    ],
  });
  const bgScan = device.createBindGroup({
    layout: pScan.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: cellCount.gpuBuffer } },
      { binding: 2, resource: { buffer: cellStart.gpuBuffer } },
      { binding: 3, resource: { buffer: cellFill.gpuBuffer } },
    ],
  });
  const bgScatter = (pos: Buffer) => device.createBindGroup({
    layout: pScatter.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: pos.gpuBuffer } },
      { binding: 2, resource: { buffer: cellFill.gpuBuffer } },
      { binding: 3, resource: { buffer: order.gpuBuffer } },
    ],
  });

  return {
    gridSize,
    cells,
    cellStart,
    cellFill,
    order,

    update(pos: Buffer): void {
      writeUniform();
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      // 独立 pass:实测同 pass 连续 dispatch 存在旧数据可见性问题(Dawn/Windows)
      pass.setPipeline(pCounts);
      pass.setBindGroup(0, bgCounts(pos));
      pass.dispatchWorkgroups(Math.ceil(count / WG));
      pass.end();

      const pass2 = enc.beginComputePass();
      pass2.setPipeline(pScan);
      pass2.setBindGroup(0, bgScan);
      pass2.dispatchWorkgroups(1);
      pass2.end();

      const pass3 = enc.beginComputePass();
      pass3.setPipeline(pScatter);
      pass3.setBindGroup(0, bgScatter(pos));
      pass3.dispatchWorkgroups(Math.ceil(count / WG));
      pass3.end();

      device.queue.submit([enc.finish()]);
    },

    destroy(): void {
      cellCount.destroy(); cellStart.destroy(); cellFill.destroy(); order.destroy(); uniform.destroy();
    },
  };
}

function gridWgsl(): string {
  return /* wgsl */ `
struct Params {
  count: u32, _pad0: u32,
  worldHalf: f32, gridSize: u32, cells: u32,
  _p0: u32, _p1: u32, _p2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> cellFill: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> order: array<u32>;

fn cellOf(p: vec2f) -> u32 {
  let g = i32(params.gridSize);
  let span = params.worldHalf * 2.0;
  let cx = clamp(i32(floor((p.x + params.worldHalf) / span * f32(g))), 0, g - 1);
  let cy = clamp(i32(floor((p.y + params.worldHalf) / span * f32(g))), 0, g - 1);
  return u32(cy) * u32(g) + u32(cx);
}

@compute @workgroup_size(${WG})
fn main_counts(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  atomicAdd(&cellCount[cellOf(posIn[i])], 1u);
}

var<workgroup> partial: array<u32, ${SCAN}>;
@compute @workgroup_size(${SCAN})
fn main_scan(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let tid = lid.x;
  let cells = params.cells;
  let wg = ${SCAN}u;
  let chunks = (cells + wg - 1u) / wg;

  // ① 本 workgroup 负责的 chunk 局部和
  var local = 0u;
  for (var c = 0u; c < chunks; c++) {
    let idx = c * wg + tid;
    if (idx < cells) { local = local + atomicLoad(&cellCount[idx]); }
  }
  partial[tid] = local;
  workgroupBarrier();

  // ② 局部和的含前缀扫描(Hillis-Steele)
  var offset = 1u;
  loop {
    if (offset >= wg) { break; }
    var v = 0u;
    if (tid >= offset) { v = partial[tid - offset]; }
    workgroupBarrier();
    if (tid >= offset) { partial[tid] = partial[tid] + v; }
    workgroupBarrier();
    offset = offset << 1u;
  }

  // ③ chunk 基址 → start/fill,顺带把 count 归零给下一帧
  var run = 0u;
  if (tid > 0u) { run = partial[tid - 1u]; }
  for (var c = 0u; c < chunks; c++) {
    let idx = c * wg + tid;
    if (idx < cells) {
      cellStart[idx] = run;
      atomicStore(&cellFill[idx], run);
      run = run + atomicLoad(&cellCount[idx]);
      atomicStore(&cellCount[idx], 0u);
    }
  }
}

@compute @workgroup_size(${WG})
fn main_scatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let slot = atomicAdd(&cellFill[cellOf(posIn[i])], 1u);
  order[slot] = i;
}
`;
}
