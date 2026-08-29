/**
 * life 包演示页:四种人工生命一键切换。
 * ?verify=<秒>&sim=<名字> → 探针模式(页面契约同 harness)。
 */
import { GpuContext } from '../src/core/context.ts';
import { turing, physarum, boids, tentacles } from '../src/packs/life/index.ts';
import type { TuringSim, PhysarumSim, BoidsSim, TentaclesSim } from '../src/packs/life/index.ts';

type AnySim = TuringSim | PhysarumSim | BoidsSim | TentaclesSim;

const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const simSel = $<HTMLSelectElement>('sim');
const stats = $<HTMLElement>('stats');

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const report = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

let sim: AnySim | null = null;
let kind = params.get('sim') ?? simSel.value;

async function rebuild() {
  sim?.destroy();
  kind = simSel.value;
  const canvas = $<HTMLCanvasElement>('cv');
  if (kind === 'turing') sim = await turing({ preset: 'coral', seed: 'life' });
  else if (kind === 'physarum') sim = await physarum({ agents: 100_000, seed: 'life' });
  else if (kind === 'boids') sim = await boids({ count: 3000, seed: 'life' });
  else sim = await tentacles({ chains: 48 });
  await sim.attach(canvas);
}

simSel.onchange = () => { void rebuild(); };
$('reload').onclick = () => { void rebuild(); };
$('sprinkle').onclick = () => { if (kind === 'turing') (sim as TuringSim).sprinkle(8); };

// —— 启动 ——
try {
  simSel.value = kind;
  await rebuild();
  report('life-boot', true, kind);
} catch (e) {
  report('life-boot', false, String((e as Error).message ?? e));
  stats.textContent = `启动失败: ${String((e as Error).message ?? e)}`;
  (window as unknown as { __done: boolean }).__done = true;
}

async function loop() {
  sim?.tick();
  const { fps } = sim!.stats();
  const ctx = await GpuContext.get();
  stats.innerHTML = `<b>${fps.toFixed(0)}</b> fps · ${kind} · ${ctx.adapterInfo}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// —— verify 探针:各模拟的物理不变量 ——
const verifySecs = Number(params.get('verify') ?? 0);
if (verifySecs > 0) {
  setTimeout(async () => {
    report('life-running', (sim!.stats().fps ?? 0) > 10, `${sim!.stats().fps.toFixed(1)} fps · ${kind}`);
    try {
      if (kind === 'turing') {
        const b = await (sim as TuringSim).sampleB();
        let finite = true; let mean = 0;
        for (let i = 0; i < b.length; i += 97) { const v = b[i]!; if (!Number.isFinite(v)) { finite = false; break; } mean += v; }
        mean /= Math.ceil(b.length / 97);
        let variance = 0;
        for (let i = 0; i < b.length; i += 97) { const d = b[i]! - mean; variance += d * d; }
        const std = Math.sqrt(variance / Math.ceil(b.length / 97));
        report('life-turing-pattern', finite && std > 0.05, `B 通道标准差 ${std.toFixed(3)}(阈值 0.05,出现花纹)`);
      } else if (kind === 'physarum') {
        const t = await (sim as PhysarumSim).sampleTrail();
        let finite = true; let maxv = 0;
        for (let i = 0; i < t.length; i += 89) { const v = t[i]!; if (!Number.isFinite(v)) { finite = false; break; } if (v > maxv) maxv = v; }
        report('life-physarum-trail', finite && maxv > 3, `信息素峰值 ${maxv.toFixed(1)}(阈值 3,轨迹在沉积)`);
      } else if (kind === 'boids') {
        const { pos, vel } = (sim as BoidsSim).buffers();
        const p = (await pos.read()) as Float32Array;
        const v = (await vel.read()) as Float32Array;
        let finite = true; let inBounds = true; let moving = 0;
        for (let i = 0; i < v.length; i += 2) {
          if (!Number.isFinite(p[i]) || !Number.isFinite(v[i])) { finite = false; break; }
          if (Math.abs(p[i]!) > 1.01 || Math.abs(p[i + 1]!) > 1.01) { inBounds = false; }
          moving += Math.hypot(v[i]!, v[i + 1]!);
        }
        report('life-boids-flock', finite && inBounds && moving > 0, `有限=${finite} 界内=${inBounds} 平均速度=${(moving / (v.length / 2)).toFixed(4)}`);
      } else {
        const { pos } = (sim as TentaclesSim).buffers();
        const p = (await pos.read()) as Float32Array;
        const segs = 64; const segLen = 0.018;
        let finite = true; let worst = 0; let checked = 0;
        for (let i = 1; i < p.length / 2; i++) {
          if (i % segs === 0) continue; // 链首
          const dx = p[i * 2]! - p[(i - 1) * 2]!;
          const dy = p[i * 2 + 1]! - p[(i - 1) * 2 + 1]!;
          const err = Math.abs(Math.hypot(dx, dy) - segLen);
          if (!Number.isFinite(err)) { finite = false; break; }
          if (err > worst) worst = err;
          checked++;
        }
        report('life-tentacles-constraint', finite && worst < 1e-2, `约束残差最大 ${worst.toFixed(5)}(阈值 0.01,${checked} 节)`);
      }
      const ctx = await GpuContext.get();
      (window as unknown as { __adapter: string }).__adapter = ctx.adapterInfo;
    } catch (e) {
      report('life-probe-error', false, String((e as Error).message ?? e));
    }
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  }, verifySecs * 1000);
}
