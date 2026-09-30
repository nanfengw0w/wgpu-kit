import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { CompileError } from '../../core/errors.ts';
import { createShaderModuleChecked } from '../../core/shader.ts';
import { createScan, type Scan } from '../../primitives/scan.ts';

/**
 * NeighborGrid —— 通用空间邻域加速(计数排序 spatial hash)。
 *
 * 从粒子包的 grid 实现中提取的通用能力:任意"每帧需要查邻居"的模拟
 * (流体 SPH / 碰撞 / 聚类)都能用,实测 8.5× 于暴力解、近似 O(N)。
 *
 * 用法:
 *   const grid = await createNeighborGrid({ count, worldHalf, cellSize });
 *   // 每帧:先 update(按位置建格),再让你的力 kernel 读 cellStart/cellFill/order
 *   grid.update(posBuffer);
 *
 * [v2.0] scan 本体走 core 原语(双档位一致验证);本包只保留 counts/scatter
 * 两个专用 kernel + 一个 post(fill 游标归位 + counts 清零)。
 * 外部审查 P1-4 修复:旧 main_scan 的绑定声明错位(bgScan 绑 1/2/3 而 shader
 * 声明 2/3/4,公开路径建格全错)且 strided 前缀越界——原语化后整类问题消失。
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
  /** 格内结束槽位(scatter 填充后 = start + count) */
  cellFill: Buffer;
  /** 按格子序排列的实体下标(order[slot] = 实体 i) */
  order: Buffer;
  /** [v2.0] 幂等准备(含 core scan 原语);encode 前必须完成 */
  prepare(): Promise<void>;
  /** [v2.0] 同步编码:counts → scan(原语) → post → scatter 写入调用方 encoder(不提交)。
   *  内部 scan 原语带 encode-once 合同:同实例一次提交前重复 encode 会被拒绝,
   *  自定义 submit 后调用 endSubmit() 重置。 */
  encode(encoder: GPUCommandEncoder, pos: Buffer): void;
  /** [v2.0] 自定义 submit 流程完成后调用:重置内部 scan 的 encode-once 闸 */
  endSubmit(): void;
  /** 建格:便捷路径 = 内部 encoder + 提交 */
  update(pos: Buffer): void;
  destroy(): void;
}

const WG = 64;
const USIZE = 32;

export async function createNeighborGrid(config: NeighborGridConfig): Promise<NeighborGrid> {
  const { count, worldHalf, cellSize, workgroupSize = WG } = config;
  if (!Number.isInteger(count) || count <= 0) throw new Error(`count must be a positive integer, got ${String(count)}`);
  if (!(cellSize > 0)) throw new Error(`cellSize must be positive, got ${String(cellSize)}`);

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

  // core scan 原语(双档位一致验证,外部审查 P1-4 的根治)
  const scan = createScan();
  await scan.prepare();

  const { module, messages } = await createShaderModuleChecked(device, gridWgsl(), 'ngrid');
  const errors = messages.filter((m) => m.type === 'error');
  if (errors.length > 0) throw new CompileError('ngrid', errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);

  const pCounts = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_counts' } });
  const pPost = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_post' } });
  const pScatter = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_scatter' } });

  const bgCounts = (pos: Buffer) => device.createBindGroup({
    layout: pCounts.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: pos.gpuBuffer } },
      { binding: 2, resource: { buffer: cellCount.gpuBuffer } },
    ],
  });
  // post:fill 游标归位到 start + counts 清零(给下一帧)
  const bgPost = device.createBindGroup({
    layout: pPost.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 2, resource: { buffer: cellCount.gpuBuffer } },
      { binding: 3, resource: { buffer: cellStart.gpuBuffer } },
      { binding: 4, resource: { buffer: cellFill.gpuBuffer } },
    ],
  });
  const bgScatter = (pos: Buffer) => device.createBindGroup({
    layout: pScatter.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: pos.gpuBuffer } },
      { binding: 4, resource: { buffer: cellFill.gpuBuffer } },
      { binding: 5, resource: { buffer: order.gpuBuffer } },
    ],
  });


  const encodeImpl = (encoder: GPUCommandEncoder, pos: Buffer): void => {
    writeUniform();
    // 独立 pass:同 pass 连续 dispatch 的存储可见性规范不保证(Dawn/Windows 实测)
    const pass1 = encoder.beginComputePass({ label: 'ngrid-counts' });
    pass1.setPipeline(pCounts);
    pass1.setBindGroup(0, bgCounts(pos));
    pass1.dispatchWorkgroups(Math.ceil(count / WG));
    pass1.end();

    // scan 原语:自管 pass 写进本 encoder(counts → cellStart 排他前缀)
    scan.encode(encoder, cellCount.gpuBuffer, cellStart.gpuBuffer, cells, true);

    const pass3 = encoder.beginComputePass({ label: 'ngrid-post' });
    pass3.setPipeline(pPost);
    pass3.setBindGroup(0, bgPost);
    pass3.dispatchWorkgroups(Math.ceil(cells / WG));
    pass3.end();

    const pass4 = encoder.beginComputePass({ label: 'ngrid-scatter' });
    pass4.setPipeline(pScatter);
    pass4.setBindGroup(0, bgScatter(pos));
    pass4.dispatchWorkgroups(Math.ceil(count / WG));
    pass4.end();
  };

  return {
    gridSize,
    cells,
    cellStart,
    cellFill,
    order,

    async prepare(): Promise<void> {
      await scan.prepare(); // 幂等;其余管线在 create 时已同步编译
    },

    encode: (encoder, pos) => encodeImpl(encoder, pos),

    /** 自定义 submit 流程完成后调用:重置内部 scan 原语的 encode-once 闸 */
    endSubmit(): void {
      scan.endSubmit();
    },

    update: (pos) => {
      const enc = device.createCommandEncoder();
      encodeImpl(enc, pos);
      device.queue.submit([enc.finish()]);
      scan.endSubmit(); // 本帧已提交:重置 scan 闸,下一帧 update 可再次 encode
    },

    destroy(): void {
      cellCount.destroy(); cellStart.destroy(); cellFill.destroy(); order.destroy(); uniform.destroy();
      scan.destroy();
    },
  };
}

function gridWgsl(): string {
  return /* wgsl */ `
// 全模块统一一套 binding 声明:layout:'auto' 为每个入口点取其静态使用的子集,
// 同一 binding 号不得被两个入口点重复声明(WGSL 校验:同一模块内绑定唯一)
struct Params {
  count: u32, _pad0: u32,
  worldHalf: f32, gridSize: u32, cells: u32,
  _p0: u32, _p1: u32, _p2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> cellStartIn: array<u32>;
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

// scan 后置:fill 游标归位到段起点(scatter 原子递增至 start+count)+ counts 清零
// (scan 本体在 core 原语层;本 kernel 只消费其排他输出 cellStartIn)
@compute @workgroup_size(${WG})
fn main_post(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.cells) { return; }
  atomicStore(&cellFill[i], cellStartIn[i]);
  atomicStore(&cellCount[i], 0u);
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
