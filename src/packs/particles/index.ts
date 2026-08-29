import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { PingPong } from '../../core/pingpong.ts';
import { CompileError, createComputePipelineChecked } from '../../core/errors.ts';
import { resolveConfig, type ParticlesConfig, type ResolvedConfig } from './config.ts';
import { mulberry32, resolveMatrix, hashSeed, type ForceMatrix, type ForcePresetName } from './presets.ts';
import { simWgsl, WORKGROUP } from './wgsl.ts';
import { gridCountsWgsl, gridScanWgsl, gridScatterWgsl, gridForceWgsl } from './grid.ts';
import { ParticlesRenderer } from './render.ts';

/**
 * particles(config) —— 粒子领域包(5 分钟出活的 Layer 2)。
 *
 * const sim = await particles({ count: 100_000, forces: 'cells' });
 * await sim.attach(canvas);
 * function frame() { sim.tick(); requestAnimationFrame(frame); }
 */
export interface ParticlesSim {
  readonly config: ResolvedConfig;
  /** 配置渲染目标;只调一次(tick 之前或之后均可) */
  attach(canvas: HTMLCanvasElement): Promise<void>;
  /** 推进一帧;dtMultiplier 便于暂停(0)/慢放(<1)/快放(>1) */
  tick(dtMultiplier?: number): void;
  /** 热更新力矩阵(预设名或自定义) */
  setForces(forces: ForcePresetName | 'random' | ForceMatrix): void;
  /** 热更新物理参数(rMax 变化会触发 grid 重建) */
  setParams(params: { rMax?: number; beta?: number; forceFactor?: number; frictionHalfLife?: number; dt?: number }): void;
  /** 可序列化的当前配置(URL 分享用) */
  snapshot(): string;
  /** 运行统计(500ms 窗口的 fps;playground/harness 直接读) */
  stats(): { fps: number; gpuErrors: number };
  /** 调试:grid 模式内部缓冲(仅诊断用) */
  debugGrid?(): { partial: Buffer; start: Buffer; fill: Buffer; sortedPos: Buffer; sortedSp: Buffer; order: Buffer };
  /** 当前帧数据(interop/three 用) */
  buffers(): { pos: Buffer; vel: Buffer; species: Buffer };
  destroy(): void;
}

interface UniformState {
  rMax: number; beta: number; forceFactor: number; frictionHalfLife: number; dt: number;
}

const USIZE = 48;

export async function particles(config: ParticlesConfig = {}): Promise<ParticlesSim> {
  const cfg = resolveConfig(config);
  const ctx = await GpuContext.get();
  const device = ctx.device;
  // 世界自适应:面积随粒子数等比扩大(默认 16k 密度),密度/邻居数/力与 16k 版逐位一致,
  // 只是"宇宙更大、相机更远"——大规模下不改变任何物理行为(用户可关)
  const worldHalf = 1 * Math.sqrt(cfg.count / 16_000);

  // —— 数据 ——
  const pp = await PingPong.create({ pos: 'vec2f', vel: 'vec2f' } as const, cfg.count);
  const sideA = { pos: pp.current.pos, vel: pp.current.vel }; // 固定引用;pp.current 随 swap 翻转
  const sideB = { pos: pp.other.pos, vel: pp.other.vel };
  const species = await Buffer.create('u32', cfg.count);
  const matrix = await Buffer.create('f32', 16);
  {
    const rand = mulberry32(cfg.seedHash);
    const pos0 = new Float32Array(cfg.count * 2);
    for (let i = 0; i < pos0.length; i++) pos0[i] = (rand() * 1.6 - 0.8) * worldHalf;
    const vel0 = new Float32Array(cfg.count * 2);
    const sp0 = new Uint32Array(cfg.count);
    for (let i = 0; i < cfg.count; i++) sp0[i] = Math.floor(rand() * 4);
    sideA.pos.write(pos0);
    sideA.vel.write(vel0);
    species.write(sp0);
    matrix.write(new Float32Array(cfg.forces));
  }

  const phys: UniformState = { rMax: cfg.rMax, beta: cfg.beta, forceFactor: cfg.forceFactor, frictionHalfLife: 0.04, dt: cfg.dt };

  const uniform = device.createBuffer({ size: USIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'particles-params' });

  // grid 尺寸由 rMax 决定(格宽 ≈ rMax → 邻域恰好 3×3 格)
  const gridSizeOf = (rMax: number, half = worldHalf) => Math.max(4, Math.ceil((2 * half) / Math.max(rMax, 1e-3)));
  let gridSize = gridSizeOf(phys.rMax, worldHalf);

  const writeUniform = (dt: number) => {
    const buf = new ArrayBuffer(USIZE);
    const v = new DataView(buf);
    v.setUint32(0, cfg.count, true);
    v.setUint32(4, 0, true);
    v.setFloat32(8, dt, true);
    v.setFloat32(12, phys.rMax, true);
    v.setFloat32(16, phys.beta, true);
    v.setFloat32(20, phys.forceFactor, true);
    v.setFloat32(24, Math.exp(-dt / phys.frictionHalfLife), true);
    v.setFloat32(28, worldHalf, true);
    v.setFloat32(32, cfg.bounds === 'wrap' ? 1 : 0, true);
    v.setUint32(36, gridSize, true);
    v.setUint32(40, gridSize * gridSize, true);
    v.setUint32(44, Math.ceil(cfg.maxNeighbors / 9), true); // 每格候选上限
    device.queue.writeBuffer(uniform, 0, buf);
  };
  writeUniform(cfg.dt);

  // —— 着色器模块(编译错误 → 行号映射) ——
  const compile = async (code: string, label: string) => {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) throw new CompileError(label, errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);
    return module;
  };
  const makePipeline = async (module: GPUShaderModule, entryPoint: string, label: string) =>
    createComputePipelineChecked(device, module, `${label}(${entryPoint})`, entryPoint);

  // —— n2 / tiled:单 kernel + 双缓冲 ——
  let simPipeline: GPUComputePipeline | null = null;
  let bgAB: GPUBindGroup | null = null;
  let bgBA: GPUBindGroup | null = null;

  // —— grid:4 kernel 流水线 ——
  interface GridState {
    size: number;
    count: Buffer; start: Buffer; fill: Buffer; order: Buffer; partial: Buffer; sortedPos: Buffer; sortedSp: Buffer;
    pCounts: GPUComputePipeline; pScan: GPUComputePipeline; pScatter: GPUComputePipeline; pForceCell: GPUComputePipeline; pForceInt: GPUComputePipeline;
    bgCountsA: GPUBindGroup; bgCountsB: GPUBindGroup;
    bgScan: GPUBindGroup;
    bgScatterA: GPUBindGroup; bgScatterB: GPUBindGroup;
    bgForceCellAB: GPUBindGroup; bgForceCellBA: GPUBindGroup;
    bgIntegrateAB: GPUBindGroup; bgIntegrateBA: GPUBindGroup;
  }
  let grid: GridState | null = null;

  const buildGrid = async (size: number): Promise<GridState> => {
    const cells = size * size;
    const count = await Buffer.create('u32', cells);
    const start = await Buffer.create('u32', cells);
    const fill = await Buffer.create('u32', cells);
    const order = await Buffer.create('u32', cfg.count);
    count.write(new Uint32Array(cells)); // 归零

    const mCounts = await compile(gridCountsWgsl(), 'grid-counts');
    const mScan = await compile(gridScanWgsl(), 'grid-scan');
    const mScatter = await compile(gridScatterWgsl(), 'grid-scatter');
    const mForce = await compile(gridForceWgsl(4), 'grid-force');
    const pCounts = await makePipeline(mCounts, 'main', 'grid-counts');
    const pScan = await makePipeline(mScan, 'main', 'grid-scan');
    const pScatter = await makePipeline(mScatter, 'main', 'grid-scatter');
    const pForceCell = await makePipeline(mForce, 'main_force_cell', 'grid-force-cell');
    const pForceInt = await makePipeline(mForce, 'main_force_integrate', 'grid-force-integrate');
    const partial = await Buffer.create('vec2f', cfg.count * 9); // (粒子 × 3×3 格) 部分力
    const sortedPos = await Buffer.create('vec2f', cfg.count);   // 按格子序重排的副本(合并访问)
    const sortedSp = await Buffer.create('u32', cfg.count);

    const bgCounts = (readPos: Buffer) => device.createBindGroup({
      layout: pCounts.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: readPos.gpuBuffer } },
        { binding: 2, resource: { buffer: count.gpuBuffer } },
      ],
    });
    const bgScan = device.createBindGroup({
      layout: pScan.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: count.gpuBuffer } },
        { binding: 2, resource: { buffer: start.gpuBuffer } },
        { binding: 3, resource: { buffer: fill.gpuBuffer } },
      ],
    });
    const bgScatter = (readPos: Buffer) => device.createBindGroup({
      layout: pScatter.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: readPos.gpuBuffer } },
        { binding: 2, resource: { buffer: species.gpuBuffer } },
        { binding: 3, resource: { buffer: fill.gpuBuffer } },
        { binding: 4, resource: { buffer: order.gpuBuffer } },
        { binding: 5, resource: { buffer: sortedPos.gpuBuffer } },
        { binding: 6, resource: { buffer: sortedSp.gpuBuffer } },
      ],
    });
    // 力核第一趟:(粒子 × 格子) 部分力 —— 负载均衡的关键;读按格子序重排的副本(合并访问)
    const bgForceCell = (readPos: Buffer) => device.createBindGroup({
      layout: pForceCell.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: matrix.gpuBuffer } },
        { binding: 2, resource: { buffer: species.gpuBuffer } },
        { binding: 3, resource: { buffer: readPos.gpuBuffer } },
        { binding: 4, resource: { buffer: sortedPos.gpuBuffer } },
        { binding: 5, resource: { buffer: sortedSp.gpuBuffer } },
        { binding: 6, resource: { buffer: start.gpuBuffer } },
        { binding: 7, resource: { buffer: fill.gpuBuffer } },
        { binding: 8, resource: { buffer: order.gpuBuffer } },
        { binding: 9, resource: { buffer: partial.gpuBuffer } },
      ],
    });
    // 力核第二趟:汇总 9 份贡献并积分
    const bgIntegrate = (read: { pos: Buffer; vel: Buffer }, write: { pos: Buffer; vel: Buffer }) => device.createBindGroup({
      layout: pForceInt.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: read.vel.gpuBuffer } },
        { binding: 2, resource: { buffer: read.pos.gpuBuffer } },
        { binding: 3, resource: { buffer: partial.gpuBuffer } },
        { binding: 4, resource: { buffer: write.pos.gpuBuffer } },
        { binding: 5, resource: { buffer: write.vel.gpuBuffer } },
      ],
    });

    return {
      size,
      count, start, fill, order, partial, sortedPos, sortedSp,
      pCounts, pScan, pScatter, pForceCell, pForceInt,
      bgCountsA: bgCounts(sideA.pos), bgCountsB: bgCounts(sideB.pos),
      bgScan,
      bgScatterA: bgScatter(sideA.pos), bgScatterB: bgScatter(sideB.pos),
      bgForceCellAB: bgForceCell(sideA.pos), bgForceCellBA: bgForceCell(sideB.pos),
      bgIntegrateAB: bgIntegrate(sideA, sideB), bgIntegrateBA: bgIntegrate(sideB, sideA),
    };
  };

  if (cfg.mode === 'grid') grid = await buildGrid(gridSize);
  else {
    const module = await compile(simWgsl(cfg.mode, 4), `particles-sim(${cfg.mode})`);
    simPipeline = await makePipeline(module, 'main', `particles-sim(${cfg.mode})`);
    const bg = (read: { pos: Buffer; vel: Buffer }, write: { pos: Buffer; vel: Buffer }) => device.createBindGroup({
      layout: simPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: matrix.gpuBuffer } },
        { binding: 2, resource: { buffer: species.gpuBuffer } },
        { binding: 3, resource: { buffer: read.pos.gpuBuffer } },
        { binding: 4, resource: { buffer: read.vel.gpuBuffer } },
        { binding: 5, resource: { buffer: write.pos.gpuBuffer } },
        { binding: 6, resource: { buffer: write.vel.gpuBuffer } },
      ],
    });
    bgAB = bg(sideA, sideB);
    bgBA = bg(sideB, sideA);
  }

  let renderer: ParticlesRenderer | null = null;
  let frame = 0;
  let lastFps = 0;
  let fpsFrames = 0;
  let fpsAcc = 0;
  let fpsLast = performance.now();

  let gpuErrorCount = 0;
  device.addEventListener?.('uncapturederror', (e) => {
    gpuErrorCount++;
    const msg = (e as GPUUncapturedErrorEvent).error?.message ?? String(e);
    const g = globalThis as { __lastGpuError?: string; __firstGpuError?: string };
    g.__firstGpuError ??= msg.slice(0, 400);
    g.__lastGpuError = msg.slice(0, 300);
    console.error('[wgpu-kit particles] GPU 错误:', msg);
  });

  return {
    config: cfg,

    async attach(canvas: HTMLCanvasElement): Promise<void> {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      renderer = await ParticlesRenderer.create(canvas, {
        count: cfg.count, species, vel: sideA.vel,
        color: cfg.color, pointSize: cfg.pointSize * worldHalf, worldHalf,
      });
    },

    tick(dtMultiplier = 1): void {
      const dt = cfg.dt * dtMultiplier;
      writeUniform(dt);
      const useAB = frame % 2 === 0;
      const read = useAB ? sideA : sideB;

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      if (grid) {
        // 实测:同一 compute pass 内连续 dispatch 之间,后续 kernel 读到的可能
        // 是前一 kernel 的旧数据(Dawn/Windows,partial 竞态)——各段独立 pass
        // 提交以保证可见性。
        pass.setPipeline(grid.pCounts);
        pass.setBindGroup(0, useAB ? grid.bgCountsA : grid.bgCountsB);
        pass.dispatchWorkgroups(Math.ceil(cfg.count / WORKGROUP));
        pass.setPipeline(grid.pScan);
        pass.setBindGroup(0, grid.bgScan);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(grid.pScatter);
        pass.setBindGroup(0, useAB ? grid.bgScatterA : grid.bgScatterB);
        pass.dispatchWorkgroups(Math.ceil(cfg.count / WORKGROUP));
        pass.end();
        device.queue.submit([enc.finish()]);

        const enc2 = device.createCommandEncoder();
        const pass2 = enc2.beginComputePass();
        pass2.setPipeline(grid.pForceCell);
        pass2.setBindGroup(0, useAB ? grid.bgForceCellAB : grid.bgForceCellBA);
        pass2.dispatchWorkgroups(Math.ceil((cfg.count * 9) / WORKGROUP));
        pass2.end();
        device.queue.submit([enc2.finish()]);

        const enc3 = device.createCommandEncoder();
        const pass3 = enc3.beginComputePass();
        pass3.setPipeline(grid.pForceInt);
        pass3.setBindGroup(0, useAB ? grid.bgIntegrateAB : grid.bgIntegrateBA);
        pass3.dispatchWorkgroups(Math.ceil(cfg.count / WORKGROUP));
        pass3.end();
        device.queue.submit([enc3.finish()]);
      } else {
        pass.setPipeline(simPipeline!);
        pass.setBindGroup(0, useAB ? bgAB! : bgBA!);
        pass.dispatchWorkgroups(Math.ceil(cfg.count / WORKGROUP));
        pass.end();
        device.queue.submit([enc.finish()]);
      }

      // 渲染刚写入的一侧(队列顺序保证 compute 先行),再翻转
      renderer?.render((useAB ? pp.other : pp.current).pos, (useAB ? pp.other : pp.current).vel);
      pp.swap();
      frame++;

      // 内置轻量 fps 统计(playground/harness 都直接读)
      fpsFrames++;
      const now = performance.now();
      fpsAcc += now - fpsLast;
      fpsLast = now;
      if (fpsAcc >= 500) {
        lastFps = fpsFrames / (fpsAcc / 1000);
        fpsFrames = 0; fpsAcc = 0;
      }
    },

    setForces(forces: ForcePresetName | 'random' | ForceMatrix): void {
      const m = resolveMatrix(forces, hashSeed(cfg.seed));
      matrix.write(new Float32Array(m));
      (cfg as { forces: ForceMatrix }).forces = m;
      (cfg as { forcesName: string }).forcesName = typeof forces === 'string' ? forces : 'custom';
    },

    setParams(p: { rMax?: number; beta?: number; forceFactor?: number; frictionHalfLife?: number; dt?: number }): void {
      Object.assign(phys, p);
      if (grid && p.rMax !== undefined) {
        const g = gridSizeOf(phys.rMax);
        if (g !== gridSize) {
          gridSize = g;
          // rMax 跨档:重建 grid 缓冲与管线绑定(rMax 变化不频繁,代价可接受)
          void (async () => {
            const old = grid!;
            grid = await buildGrid(gridSize);
            old.count.destroy(); old.start.destroy(); old.fill.destroy(); old.order.destroy();
          })();
        }
      }
    },

    snapshot(): string {
      return JSON.stringify({
        count: cfg.count, forces: cfg.forcesName, mode: cfg.mode, color: cfg.color,
        bounds: cfg.bounds, seed: cfg.seed, rMax: phys.rMax, beta: phys.beta,
        forceFactor: phys.forceFactor, frictionHalfLife: phys.frictionHalfLife, dt: phys.dt,
        pointSize: cfg.pointSize,
      });
    },

    stats(): { fps: number; gpuErrors: number } {
      return { fps: lastFps, gpuErrors: gpuErrorCount };
    },
    debugGrid: grid
      ? () => {
          const g = grid!;
          return { partial: g.partial, start: g.start, fill: g.fill, sortedPos: g.sortedPos, sortedSp: g.sortedSp, order: g.order };
        }
      : undefined,

    buffers() {
      return { pos: pp.current.pos, vel: pp.current.vel, species };
    },

    destroy(): void {
      renderer?.destroy();
      pp.destroy();
      species.destroy();
      matrix.destroy();
      uniform.destroy();
      if (grid) {
        grid.count.destroy(); grid.start.destroy(); grid.fill.destroy(); grid.order.destroy(); grid.partial.destroy(); grid.sortedPos.destroy(); grid.sortedSp.destroy();
      }
    },
  };
}
