/**
 * NeighborGrid 专项验证页(外部审查 P1-4 的验证缺口):
 * 旧 main_scan 的绑定错位曾让公开路径建格全错,而 grid-debug 只测 particles
 * 内部路径——公开 API 必须有自己的物理探针。
 *
 * 断言(对 CPU 参考做逐位比较):
 *   ① fill 语义:scatter 后每格 fill-start = 该格粒子数
 *   ② 全格覆盖:Σ(fill-start) = count、start 单调不减
 *   ③ order 覆盖:order 是 0..N-1 的排列
 *   ④ 重复 update 一致性
 *   ⑤ encode 合同:grid.encode 写入调用方 encoder 与 update 结果一致
 */
import { Buffer, GpuContext } from "../../src/index.ts";
import { createNeighborGrid } from '../../src/packs/grid/index.ts';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const report = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  document.getElementById('out')!.textContent = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`).join('\n');
};

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

const N = 20_000;
const WORLD_HALF = 1.0;
const CELL_SIZE = 0.1; // gridSize = 20 → 400 cells(> 256,专杀扫描截断类 bug)

async function buildAndRead(pos: Float32Array<ArrayBuffer>): Promise<{ start: Uint32Array; fill: Uint32Array; order: Uint32Array; cells: number }> {
  const grid = await createNeighborGrid({ count: N, worldHalf: WORLD_HALF, cellSize: CELL_SIZE });
  const posBuf = await Buffer.create('vec2f', N);
  posBuf.write(pos);
  grid.update(posBuf);
  const ctx = await GpuContext.get();
  await ctx.sync();
  const start = (await grid.cellStart.read()) as Uint32Array;
  const fill = (await grid.cellFill.read()) as Uint32Array;
  const order = (await grid.order.read()) as Uint32Array;
  posBuf.destroy();
  grid.destroy();
  return { start, fill, order, cells: 400 };
}

function cpuBin(pos: Float32Array): Uint32Array {
  const g = 20;
  const span = WORLD_HALF * 2;
  const counts = new Uint32Array(g * g);
  for (let i = 0; i < N; i++) {
    const cx = Math.min(Math.max(Math.floor((pos[i * 2]! + WORLD_HALF) / span * g), 0), g - 1);
    const cy = Math.min(Math.max(Math.floor((pos[i * 2 + 1]! + WORLD_HALF) / span * g), 0), g - 1);
    counts[cy * g + cx]!++;
  }
  return counts;
}

async function main() {
  const ctx = await GpuContext.get();
  ctx.device.addEventListener?.('uncapturederror', (e: Event) => {
    report('gpu-validation-error', false, String((e as GPUUncapturedErrorEvent).error?.message ?? e).slice(0, 250));
  });

  // 可复现位置:一半均匀 + 一半重度聚集(两簇),覆盖稀疏/拥挤两种分布
  const rand = lcg(0x1234567);
  const pos = new Float32Array(new ArrayBuffer(N * 2 * 4));
  for (let i = 0; i < N; i++) {
    if (i % 2 === 0) {
      pos[i * 2] = rand() * 1.8 - 0.9;
      pos[i * 2 + 1] = rand() * 1.8 - 0.9;
    } else {
      // 聚簇:两处高斯近似(三角和)
      const cx = i % 4 === 1 ? -0.5 : 0.5;
      pos[i * 2] = cx + (rand() + rand() + rand()) / 3 * 0.08 - 0.04;
      pos[i * 2 + 1] = (rand() + rand() + rand()) / 3 * 0.08 - 0.04;
    }
  }

  const { start, fill, order, cells } = await buildAndRead(pos);
  const cpuCounts = cpuBin(pos);

  // ① fill 语义:每格 fill-start = 该格粒子数(逐格对 CPU)
  {
    let bad = -1;
    for (let c = 0; c < cells; c++) {
      if (fill[c]! - start[c]! !== cpuCounts[c]!) { bad = c; break; }
    }
    report('ngrid fill 语义(逐格对 CPU)', bad === -1, bad === -1 ? `400 格全部一致 ✓(聚集簇 ${cpuCounts.filter((c) => c > 500).length} 个重格)` : `格${bad}: GPU ${fill[bad]! - start[bad]!} vs CPU ${cpuCounts[bad]}`);
  }

  // ② 全格覆盖 + 单调
  {
    let total = 0;
    let mono = true;
    for (let c = 0; c < cells; c++) {
      total += fill[c]! - start[c]!;
      if (c > 0 && start[c]! < start[c - 1]!) { mono = false; break; }
    }
    report('ngrid 全格覆盖+单调', total === N && mono, `Σ=N=${total === N} 单调=${mono}(cells=${cells})`);
  }

  // ③ order 是排列
  {
    const seen = new Uint8Array(N);
    let perm = true;
    let badK = -1;
    for (let k = 0; k < N; k++) {
      const v = order[k]!;
      if (v >= N || seen[v]!) { perm = false; badK = k; break; }
      seen[v] = 1;
    }
    report('ngrid order 是 0..N-1 排列', perm, perm ? `N=${N} 无重无漏 ✓` : `order[${badK}] 重复或越界`);
  }

  // ④ 重复 update 一致性
  {
    const grid = await createNeighborGrid({ count: N, worldHalf: WORLD_HALF, cellSize: CELL_SIZE });
    const posBuf = await Buffer.create('vec2f', N);
    posBuf.write(pos);
    grid.update(posBuf);
    const s1 = (await grid.cellStart.read()) as Uint32Array;
    grid.update(posBuf);
    const s2 = (await grid.cellStart.read()) as Uint32Array;
    let same = true;
    for (let c = 0; c < cells; c++) if (s1[c] !== s2[c]) { same = false; break; }
    report('ngrid 重复 update 一致', same, same ? '两次位一致 ✓(counts 清零正确)' : '两次不同 ← counts 残留 bug');
    posBuf.destroy();
    grid.destroy();
  }

  // ⑤ encode 合同:grid.encode 写入调用方 encoder,结果与 update 一致
  {
    const grid = await createNeighborGrid({ count: N, worldHalf: WORLD_HALF, cellSize: CELL_SIZE });
    await grid.prepare();
    const posBuf = await Buffer.create('vec2f', N);
    posBuf.write(pos);
    const enc = ctx.device.createCommandEncoder();
    grid.encode(enc, posBuf);
    ctx.device.queue.submit([enc.finish()]);
    await ctx.sync();
    const startEnc = (await grid.cellStart.read()) as Uint32Array;
    let same = true;
    for (let c = 0; c < cells; c++) if (startEnc[c] !== start[c]) { same = false; break; }
    report('ngrid encode 合同', same, same ? 'encode 与 update 结果位一致 ✓' : 'encode 路径结果不同');
    posBuf.destroy();
    grid.destroy();
  }
}

main()
  .then(() => report('summary-done', results.every((r) => r.pass), `${results.filter((r) => r.pass).length}/${results.length}`))
  .catch((e) => report('fatal', false, String((e as Error).message ?? e).slice(0, 300)))
  .finally(() => {
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  });
