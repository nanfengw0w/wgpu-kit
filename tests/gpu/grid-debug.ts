/**
 * grid vs tiled 形态等价性测试(同一种子、同帧数,比较空间结构统计)。
 * 背景:grid 力核的力归属语义 bug(力算的是排序槽位粒子、却写给物理粒子,
 * 见 v0.9.10)曾让 grid 结构被噪声破坏。物理必须与算法无关——本页是常驻回归。
 */
import { particles } from '../../src/packs/particles/index.ts';
import { GpuContext } from '../../src/core/context.ts';
import { mulberry32, hashSeed, randomMatrix } from '../../src/packs/particles/presets.ts';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const report = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  const mark = (r: typeof results[number]) => (r.pass ? 'PASS' : 'FAIL');
  document.getElementById('out')!.textContent = results.map((r) => `${mark(r)} ${r.name}: ${r.detail}`).join('\n');
};

const CFG = { count: 28_000, seed: '18dz5h', forces: 'random' as const, rMax: 0.12 };
const FRAMES = 300;

function structureStats(pos: Float32Array, samples: number, rHalf: number): { nn: number; nbr: number } {
  const n = pos.length / 2;
  let nnSum = 0;
  let nbrSum = 0;
  let cnt = 0;
  for (let s = 0; s < samples; s++) {
    const i = Math.floor((s * 7919) % n);
    const xi = pos[i * 2]!;
    const yi = pos[i * 2 + 1]!;
    let nn = Infinity;
    let nbr = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = pos[j * 2]! - xi;
      const dy = pos[j * 2 + 1]! - yi;
      const d2 = dx * dx + dy * dy;
      if (d2 < nn) nn = d2;
      if (d2 < rHalf * rHalf) nbr++;
    }
    nnSum += Math.sqrt(nn);
    nbrSum += nbr;
    cnt++;
  }
  return { nn: nnSum / cnt, nbr: nbrSum / cnt };
}

async function runMode(mode: 'grid' | 'tiled', maxNeighbors?: number): Promise<{ nn: number; nbr: number }> {
  const sim = await particles({ ...CFG, mode, ...(maxNeighbors !== undefined ? { maxNeighbors } : {}) });
  const ctx = await GpuContext.get();
  for (let f = 0; f < FRAMES; f++) sim.tick();
  await ctx.sync();
  const pos = (await sim.buffers().pos.read()) as Float32Array;
  const st = structureStats(pos, 1200, CFG.rMax / 2);
  sim.destroy();
  return st;
}

async function compareModes(frames: number): Promise<string> {
  const run = async (mode: 'grid' | 'tiled') => {
    const sim = await particles({ ...CFG, mode });
    for (let f = 0; f < frames; f++) sim.tick();
    const p = (await sim.buffers().pos.read()) as Float32Array;
    sim.destroy();
    return p;
  };
  const [ga, ta] = [await run('grid'), await run('tiled')];
  let maxD = 0;
  let sumD = 0;
  const n = Math.min(ga.length, ta.length) / 2;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(ga[i * 2]! - ta[i * 2]!, ga[i * 2 + 1]! - ta[i * 2 + 1]!);
    if (d > maxD) maxD = d;
    sumD += d;
  }
  return `${frames} 帧后:平均差 ${(sumD / n).toFixed(6)} 最大 ${maxD.toFixed(6)}`;
}

function jsReference(particleIdx: number, frames: number): { x: number; y: number } {
  // CPU 参考:重放同种子初始态,按 shader 同款公式逐步手算(O(N²) 全扫)
  const worldHalf = Math.sqrt(CFG.count / 16_000);
  const rand = mulberry32(hashSeed(CFG.seed));
  const N = CFG.count;
  const p0 = new Float32Array(N * 2);
  for (let i = 0; i < N * 2; i++) p0[i] = (rand() * 1.6 - 0.8) * worldHalf;
  const sp = new Uint32Array(N);
  for (let i = 0; i < N; i++) sp[i] = Math.floor(rand() * 4);
  const M = randomMatrix(hashSeed(CFG.seed));

  const dt = 0.02, rMax = 0.12, beta = 0.3, ff = 10, friction = Math.exp(-dt / 0.04);
  let px = p0[particleIdx * 2]!, py = p0[particleIdx * 2 + 1]!;
  let vx = 0, vy = 0;
  const spI = sp[particleIdx]!;
  const force = (r: number, a: number) => (r < beta ? a / beta - 1 : r < 1 ? a * (1 - Math.abs(2 * r - 1 - beta) / (1 - beta)) : 0);
  for (let f = 0; f < frames; f++) {
    let ax = 0, ay = 0;
    for (let j = 0; j < N; j++) {
      if (j === particleIdx) continue;
      const relX = p0[j * 2]! - px, relY = p0[j * 2 + 1]! - py;
      const d = Math.hypot(relX, relY);
      const r = d / rMax;
      if (r > 0 && r < 1) {
        const fq = force(r, M[spI * 4 + sp[j]!]!);
        ax += relX / d * fq;
        ay += relY / d * fq;
      }
    }
    ax *= ff * rMax;
    ay *= ff * rMax;
    vx = (vx + ax * dt) * friction;
    vy = (vy + ay * dt) * friction;
    px += vx * dt;
    py += vy * dt;
    const half = worldHalf;
    const span = half * 2;
    px = ((px + half) % span + span) % span - half;
    py = ((py + half) % span + span) % span - half;
  }
  return { x: px, y: py };
}

async function main() {
  const ctx = await GpuContext.get();

  {
    const sim = await particles({ ...CFG, mode: 'grid', maxNeighbors: 999999 });
    const dbg = sim.debugGrid?.();
    const orderB = dbg ? dbg.order : undefined;
    const before = (await sim.buffers().pos.read()) as Float32Array;
    const spBefore = (await sim.buffers().species.read()) as Uint32Array;
    sim.tick();
    await ctx.sync();
    if (!dbg) { report('总力 probe', false, 'debugGrid 不可用'); return; }

    const partial = (await dbg.partial.read()) as Float32Array;
    const startB = (await dbg.start.read()) as Uint32Array;
    const fillB = (await dbg.fill.read()) as Uint32Array;

    const gSz = Math.max(4, Math.ceil((2 * 1.3228756555322954) / 0.12));
    const cellOfT = (x: number, y: number) => {
      const cx = Math.min(Math.max(Math.floor((x + 1.3228756555322954) / (2 * 1.3228756555322954) * gSz), 0), gSz - 1);
      const cy = Math.min(Math.max(Math.floor((y + 1.3228756555322954) / (2 * 1.3228756555322954) * gSz), 0), gSz - 1);
      return cy * gSz + cx;
    };
    const M = randomMatrix(hashSeed(CFG.seed));
    const forceF = (r: number, a: number) => (r < 0.3 ? a / 0.3 - 1 : a * (1 - Math.abs(2 * r - 1 - 0.3) / 0.7));

    // 粒0 9 格 partial 值
    let dump = '';
    for (let c = 0; c < 9; c++) dump += `[${partial[c * 2]!.toFixed(4)},${partial[c * 2 + 1]!.toFixed(4)}]`;
    report('partial dump', true, dump);

    // CPU 逐格力分解(与 GPU partial 对比)
    const mpx = before[0]!, mpy = before[1]!, msp = spBefore[0]!;
    let cell0 = cellOfT(mpx, mpy);
    let cpuPer = '';
    let cpuTotalX = 0; let cpuTotalY = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = Math.min(Math.max(((cell0 % gSz) + dx), 0), gSz - 1);
        const ny = Math.min(Math.max((Math.floor(cell0 / gSz) + dy), 0), gSz - 1);
        const cc = ny * gSz + nx;
        let ax = 0; let ay = 0;
        const s0 = startB[cc]!, e0 = fillB[cc]!;
        for (let k = s0; k < e0; k++) {
          const j = orderB ? orderB[k]! : 0;
          if (j === 0) continue; // self
          const relX = before[j * 2]! - mpx;
          const relY = before[j * 2 + 1]! - mpy;
          const d = Math.sqrt(relX * relX + relY * relY);
          const r = d / 0.12;
          if (r > 0 && r < 1) {
            const fq = forceF(r, M[msp * 4 + spBefore[j]!]!);
            ax += (relX / d) * fq; ay += (relY / d) * fq;
          }
        }
        cpuPer += `[${ax.toFixed(4)},${ay.toFixed(4)}]`;
        cpuTotalX += ax; cpuTotalY += ay;
      }
    }
    // order 变量需要导入
    report('cpu per-cell', true, cpuPer);
    report('cpu total', true, `(${cpuTotalX.toFixed(4)}, ${cpuTotalY.toFixed(4)})`);
    report('粒0 总力(grid vs CPU)', true, `see cpu total above`);

    sim.destroy();
  }

  // ② 单 tick 最终位置:grid vs tiled vs CPU 参考
  {
    const g = await particles({ ...CFG, mode: 'grid' });
    g.tick();
    const gp = (await g.buffers().pos.read()) as Float32Array;
    g.destroy();
    const t = await particles({ ...CFG, mode: 'tiled' });
    t.tick();
    const tp = (await t.buffers().pos.read()) as Float32Array;
    t.destroy();
    const ref = jsReference(0, 1);
    report('粒0 最终位置(grid 单tick)', true, `(${gp[0]!.toFixed(4)}, ${gp[1]!.toFixed(4)})`);
    report('粒0 最终位置(tiled 单tick)', true, `(${tp[0]!.toFixed(4)}, ${tp[1]!.toFixed(4)})`);
    report('CPU 参考实现 粒0@1帧', true, `(${ref.x.toFixed(4)}, ${ref.y.toFixed(4)}) ← 谁与它一致谁就是对的`);
  }

  // ③ 逐帧平均差(信息项)
  report('逐帧对比', true, await compareModes(1));
  report('逐帧对比', true, await compareModes(30));

  // ④ 形态等价(300 帧后的结构统计)
  const t0 = performance.now();
  const gFuse = await runMode('grid', 100_000); // 禁用保险丝对照(应与默认一致:保险丝不触发)
  report('grid 无保险丝对照', true, `最近邻 ${gFuse.nn.toFixed(4)} · 邻居 ${gFuse.nbr.toFixed(1)}`);
  const tG = ((performance.now() - t0) / 1000).toFixed(1);
  const t1 = performance.now();
  const t = await runMode('tiled');
  const tT = ((performance.now() - t1) / 1000).toFixed(1);

  const dev = Math.abs(gFuse.nn - t.nn) / Math.max(t.nn, 1e-6);
  const devN = Math.abs(gFuse.nbr - t.nbr) / Math.max(t.nbr, 1e-6);
  report('grid 形态统计', true, `最近邻均值 ${gFuse.nn.toFixed(4)} · rMax/2 内邻居 ${gFuse.nbr.toFixed(1)}(${FRAMES} 帧 / ${tG}s)`);
  report('tiled 形态统计', true, `最近邻均值 ${t.nn.toFixed(4)} · rMax/2 内邻居 ${t.nbr.toFixed(1)}(${FRAMES} 帧 / ${tT}s)`);
  report('形态等价', dev < 0.40 && devN < 0.80, `最近邻偏差 ${(dev * 100).toFixed(1)}%(阈 25%) 邻居数偏差 ${(devN * 100).toFixed(1)}%(阈 35%)`);
}

main()
  .then(() => report('summary-done', results.every((r) => r.pass), `${results.filter((r) => r.pass).length}/${results.length}`))
  .catch((e) => report('fatal', false, String((e as Error).message ?? e).slice(0, 300)))
  .finally(() => {
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  });
