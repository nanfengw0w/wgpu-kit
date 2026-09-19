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
  { mode: 'grid', count: 200_000, maxNeighbors: 8100 },
  { mode: 'grid', count: 200_000, maxNeighbors: 900 },
  { mode: 'grid', count: 262_144, rMax: 0.05 },
];

async function benchCell(cell: Cell): Promise<void> {
  const tCreate = performance.now();
  const sim = await particles({
    count: cell.count,
    mode: cell.mode,
    seed: 'bench',
    forces: 'cells',
    ...(cell.rMax !== undefined ? { rMax: cell.rMax } : {}),
    ...(cell.maxNeighbors !== undefined ? { maxNeighbors: cell.maxNeighbors } : {}),
  });
  const tCreateDone = performance.now();
  const ctx = await GpuContext.get();
  for (let i = 0; i < 3; i++) sim.tick(); // 预热(编译/缓存)
  await ctx.sync();
  const tWarmDone = performance.now();
  // 口径一【同步延迟】:每帧等 GPU 完成——单帧往返耗时的上界,算法 A/B 对比用。
  // (首版基准漏掉等完成,测出 10 万 fps 的笑话数据;但它只是延迟口径,不是吞吐)
  const t0 = performance.now();
  let n = 0;
  while (n < 40 && performance.now() - t0 < 3000) {
    sim.tick();
    await ctx.sync();
    n++;
  }
  const tSyncDone = performance.now();
  const ms = (performance.now() - t0) / n;
  // 口径二【端到端吞吐】:rAF 节流、每帧提交不等完成——CPU/GPU 流水线重叠,
  // 与 playground 实际 fps 同口径(playground 探针实测 200k grid ≈ 120fps)。
  // 注意背压:rAF 提交快于 GPU 消耗时队列会积压,窗口结束后 drain 是净等待。
  const tWin0 = performance.now();
  const fps2 = await new Promise<number>((ok) => {
    let frames = 0;
    const s0 = performance.now();
    const loop = () => {
      sim.tick();
      frames++;
      if (performance.now() - s0 < 3000) requestAnimationFrame(loop);
      else {
        ctx.sync().then(() => {
          ok(frames / ((performance.now() - s0) / 1000));
        });
      }
    };
    requestAnimationFrame(loop);
  });
  const tWin = performance.now() - tWin0;
  sim.destroy();
  const tAll = performance.now() - tCreate;
  const tag = `${cell.mode}@${cell.count.toLocaleString()}${cell.rMax ? ` rMax=${cell.rMax}` : ''}${cell.maxNeighbors ? ` cap=${cell.maxNeighbors}` : ''}`;
  report(`bench ${tag}`, true, `${ms.toFixed(2)} ms/frame sync · ${fps2.toFixed(1)} fps rAF · 分段:建 ${Math.round(tCreateDone - tCreate)} 预热 ${Math.round(tWarmDone - tCreateDone)} 同步环 ${Math.round(tSyncDone - tWarmDone)} rAF ${Math.round(tWin)} 总 ${Math.round(tAll)}`);
}

async function main() {
  for (const cell of CELLS) {
    const tIter = performance.now();
    try {
      await benchCell(cell);
    } catch (e) {
      report(`bench ${cell.mode}@${cell.count}`, false, String((e as Error).message ?? e).slice(0, 200));
    }
    // 格间空隙诊断:页内每格实测 ~3.5s,但页面总时长多出几十秒——定位停顿在哪
    report(`gap ${cell.mode}@${cell.count}`, true, `本格迭代总耗时 ${Math.round(performance.now() - tIter)}ms`);
  }
  report('summary-done', results.every((r) => r.pass), `${results.filter((r) => r.pass).length}/${results.length}`);
}

main()
  .catch((e) => report('fatal', false, String((e as Error).message ?? e)))
  .finally(() => {
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  });
