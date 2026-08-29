/**
 * 邻域算法路径基准:n2 / tiled / grid(计数排序 spatial hash)。
 * 只测计算(不 attach 渲染,三种路径渲染成本相同)。
 * 同会话内对比;绝对值受笔记本 GPU 热节流影响,见 validation/05。
 */
import { particles } from '../../src/packs/particles/index.ts';
import { GpuContext } from '../../src/core/context.ts';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const report = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  document.getElementById('out')!.textContent = results.map((r) => `${r.pass ? '✓' : '✗'} ${r.name}: ${r.detail}`).join('\n');
};

interface Cell { mode: 'n2' | 'tiled' | 'grid'; count: number; rMax?: number; maxNeighbors?: number }

const CELLS: Cell[] = [
  { mode: 'n2', count: 2_000 },
  { mode: 'n2', count: 8_000 },
  { mode: 'n2', count: 16_000 },
  { mode: 'tiled', count: 8_000 },
  { mode: 'tiled', count: 16_000 },
  { mode: 'tiled', count: 32_000 },
  { mode: 'tiled', count: 66_000 },
  { mode: 'grid', count: 16_000 },
  { mode: 'grid', count: 16_000, maxNeighbors: 32 },
  { mode: 'tiled', count: 16_000 },
  { mode: 'grid', count: 66_000 },
  { mode: 'grid', count: 131_072 },
  { mode: 'grid', count: 200_000 },
  { mode: 'grid', count: 262_144, rMax: 0.05 },
];

async function benchCell(cell: Cell): Promise<void> {
  const sim = await particles({
    count: cell.count,
    mode: cell.mode,
    seed: 'bench',
    forces: 'cells',
    ...(cell.rMax !== undefined ? { rMax: cell.rMax } : {}),
    ...(cell.maxNeighbors !== undefined ? { maxNeighbors: cell.maxNeighbors } : {}),
  });
  const ctx = await GpuContext.get();
  for (let i = 0; i < 3; i++) sim.tick(); // 预热(编译/缓存)
  await ctx.sync();
  // 关键:tick 是 fire-and-forget,必须每帧等 GPU 完成才是真实耗时
  // (首版基准漏掉这点,测出 10 万 fps 的笑话数据)
  const t0 = performance.now();
  let n = 0;
  while (n < 40 && performance.now() - t0 < 3000) {
    sim.tick();
    await ctx.sync();
    n++;
  }
  const ms = (performance.now() - t0) / n;
  const tag = `${cell.mode}@${cell.count.toLocaleString()}${cell.rMax ? ` rMax=${cell.rMax}` : ''}${cell.maxNeighbors ? ` cap=${cell.maxNeighbors}` : ''}`;
  report(`bench ${tag}`, true, `${ms.toFixed(2)} ms/frame ≈ ${(1000 / ms).toFixed(1)} fps(${n} 帧采样)`);
  sim.destroy();
}

async function main() {
  for (const cell of CELLS) {
    try {
      await benchCell(cell);
    } catch (e) {
      report(`bench ${cell.mode}@${cell.count}`, false, String((e as Error).message ?? e).slice(0, 200));
    }
  }
  report('summary-done', results.every((r) => r.pass), `${results.filter((r) => r.pass).length}/${results.length}`);
}

main()
  .catch((e) => report('fatal', false, String((e as Error).message ?? e)))
  .finally(() => {
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  });
