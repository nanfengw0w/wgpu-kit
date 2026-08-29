/**
 * wgpu-kit playground:粒子生命。
 * demo 即营销,也是验证目标:?verify=<秒数> 会自报 fps 探针(页面契约同 spike)。
 */
import { GpuContext } from '../src/core/context.ts';
import { particles, type ParticlesSim } from '../src/packs/particles/index.ts';
import type { ForcePresetName } from '../src/packs/particles/presets.ts';
import { CanvasRecorder, downloadBlob } from '../src/media.ts';

const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const presetSel = $<HTMLSelectElement>('preset');
const modeSel = $<HTMLSelectElement>('mode');
const countInput = $<HTMLInputElement>('count');
const countLabel = $<HTMLElement>('countLabel');
const seedInput = $<HTMLInputElement>('seed');
const colorSel = $<HTMLSelectElement>('color');
const stats = $<HTMLElement>('stats');

let sim: ParticlesSim | null = null;
let lastPreset = 'cells';

function currentConfig() {
  return {
    forces: presetSel.value as ForcePresetName | 'random',
    mode: modeSel.value as 'tiled' | 'n2' | 'grid',
    count: Number(countInput.value),
    seed: seedInput.value || 'wgpu-kit',
    color: colorSel.value as 'species' | 'velocity',
  };
}

function syncUrl() {
  const c = currentConfig();
  const q = new URLSearchParams({ p: c.forces, m: c.mode, n: String(c.count), s: c.seed, c: c.color });
  history.replaceState(null, '', `?${q}`);
}

function updateCountLabel() {
  countLabel.textContent = Number(countInput.value).toLocaleString();
}

let rebuilding = false;
let rebuildQueued = false;

async function rebuild() {
  if (rebuilding) { rebuildQueued = true; return; } // 串行化:进行中的重建完成后补一次
  rebuilding = true;
  try {
    const c = currentConfig();
    const old = sim;
    sim = null;            // 先摘除:rAF 循环在重建期间安全空转,不再触碰销毁中的缓冲
    old?.destroy();
    sim = await particles(c);
    await sim.attach($<HTMLCanvasElement>('cv'));
    syncUrl();
    lastPreset = c.forces as string;
  } finally {
    rebuilding = false;
    if (rebuildQueued) { rebuildQueued = false; void rebuild(); }
  }
}

presetSel.onchange = modeSel.onchange = colorSel.onchange = countInput.onchange = seedInput.onchange = () => { void rebuild(); };
countInput.oninput = updateCountLabel;

$('apply').onclick = () => { void rebuild(); };
$('random').onclick = () => {
  const presets: string[] = ['cells', 'snakes', 'orbitals', 'viruses', 'random'];
  presetSel.value = presets[Math.floor(Math.random() * presets.length)]!;
  seedInput.value = Math.random().toString(36).slice(2, 8);
  void rebuild();
};
$('copy').onclick = async () => {
  syncUrl();
  await navigator.clipboard?.writeText(location.href).catch(() => undefined);
  toast('✓ 链接已复制,去分享这个宇宙');
};

// —— 录制(MediaRecorder,mp4 优先) ——
const recordBtn = $<HTMLButtonElement>('record');
let recorder: CanvasRecorder | null = null;
recordBtn.onclick = async () => {
  if (recorder?.recording) {
    const r = await recorder.stop();
    document.getElementById('hud')!.classList.remove('recording');
    recordBtn.textContent = '⏺ 录制';
    const ext = r.mimeType.includes('mp4') ? 'mp4' : 'webm';
    downloadBlob(r.blob, `wgpu-kit-universe.${ext}`);
    toast(`✓ 录制 ${r.seconds.toFixed(1)}s / ${(r.bytes / 1024 / 1024).toFixed(2)} MB · ${ext} 已下载`);
    (window as unknown as Record<string, unknown>)['__recordResult'] = r.bytes;
    return;
  }
  recorder = recorder ?? new CanvasRecorder();
  recorder.start($<HTMLCanvasElement>('cv'));
  document.getElementById('hud')!.classList.add('recording');
  recordBtn.textContent = '⏹ 停止';
};

// —— 收藏到本地画廊 ——
$('fav').onclick = () => {
  syncUrl();
  const list: Array<{ name: string; url: string }> = JSON.parse(localStorage.getItem('wgpu-kit-gallery') ?? '[]');
  const c = currentConfig();
  list.unshift({ name: `${c.forces} · ${c.count.toLocaleString()} · ${c.seed}`, url: location.href });
  localStorage.setItem('wgpu-kit-gallery', JSON.stringify(list.slice(0, 48)));
  toast('⭐ 已收藏,画廊可见');
};

// —— 4×4 力矩阵可视化编辑器 ——
const matrixPanel = document.getElementById('matrix')!;
const mgrid = document.getElementById('mgrid')!;
let editing = false;
let dragCell: { el: HTMLElement; i: number; j: number; startY: number; startV: number } | null = null;

function currentMatrix(): number[] {
  return [...(sim?.config.forces ?? [0, 0.6, -0.4, 0, -0.4, 0, 0.7, -0.2, 0.5, -0.5, 0, 0.6, -0.3, 0.4, -0.6, 0])];
}

function paintCell(el: HTMLElement, v: number) {
  el.textContent = v.toFixed(1);
  const a = Math.min(Math.abs(v), 1);
  el.style.background = v >= 0
    ? `rgba(70, 200, 120, ${0.12 + a * 0.55})`
    : `rgba(230, 90, 70, ${0.12 + a * 0.55})`;
}

function buildMatrixEditor() {
  mgrid.innerHTML = '';
  const m = currentMatrix();
  // 表头
  ['', 'A', 'B', 'C', 'D'].forEach((h) => {
    const d = document.createElement('div');
    d.className = 'mhead';
    d.textContent = h;
    mgrid.appendChild(d);
  });
  for (let i = 0; i < 4; i++) {
    const h = document.createElement('div');
    h.className = 'mhead';
    h.textContent = 'ABCD'[i]!;
    mgrid.appendChild(h);
    for (let j = 0; j < 4; j++) {
      const cell = document.createElement('div');
      cell.className = 'mcell';
      paintCell(cell, m[i * 4 + j]!);
      cell.onpointerdown = (e) => {
        dragCell = { el: cell, i, j, startY: e.clientY, startV: m[i * 4 + j]! };
        cell.setPointerCapture(e.pointerId);
      };
      cell.onpointermove = (e) => {
        if (!dragCell || dragCell.el !== cell) return;
        const v = Math.max(-1, Math.min(1, dragCell.startV + (dragCell.startY - e.clientY) * 0.01));
        m[i * 4 + j] = Math.round(v * 10) / 10;
        paintCell(cell, m[i * 4 + j]!);
      };
      cell.onpointerup = () => { if (dragCell?.el === cell) { dragCell = null; sim?.setForces(m as unknown as Parameters<ParticlesSim['setForces']>[0]); } };
      cell.ondblclick = () => {
        m[i * 4 + j] = 0;
        paintCell(cell, 0);
        sim?.setForces(m as unknown as Parameters<ParticlesSim['setForces']>[0]);
      };
      mgrid.appendChild(cell);
    }
  }
}

$<HTMLButtonElement>('toggleMatrix').onclick = () => {
  editing = !editing;
  matrixPanel.classList.toggle('hidden', !editing);
  if (editing) buildMatrixEditor();
};

// 供验证探针调用:程序化改一格并生效
(window as unknown as Record<string, unknown>)['__setForceCell'] = (i: number, j: number, v: number) => {
  const m = currentMatrix();
  m[i * 4 + j] = v;
  sim?.setForces(m as unknown as Parameters<ParticlesSim['setForces']>[0]);
  return sim?.config.forces[i * 4 + j];
};

function toast(msg: string) {
  const t = document.getElementById('toast')!;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// 从 URL 恢复(demo 的"参数即 URL"契约)
if (params.get('p')) presetSel.value = params.get('p')!;
if (params.get('m')) modeSel.value = params.get('m')!;
if (params.get('n')) countInput.value = params.get('n')!;
if (params.get('s')) seedInput.value = params.get('s')!;
if (params.get('c')) colorSel.value = params.get('c')!;
updateCountLabel();

// 窗口尺寸变化:防抖后重建(连续 resize 只重建一次)
let resizeTimer = 0;
window.addEventListener('resize', () => {
  if (!sim) return;
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { void rebuild(); }, 300);
});

// —— 启动 ——
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const report = (name: string, pass: boolean, detail = '') => { results.push({ name, pass, detail }); };

let frames = 0;
let last = performance.now();

async function loop() {
  sim?.tick();
  frames++;
  const now = performance.now();
  const dt = now - last;
  last = now;
  if (dt >= 500) {
    const { fps } = sim!.stats();
    const ctx = await GpuContext.get();
    stats.innerHTML = `<b>${fps.toFixed(0)}</b> fps · <b>${Number(countInput.value).toLocaleString()}</b> 粒子 · ${modeSel.value}<br/>${ctx.adapterInfo} · ${lastPreset} · seed=${seedInput.value}`;
    last = now;
  }
  requestAnimationFrame(loop);
}

try {
  await rebuild();
  report('playground-boot', true, currentConfig().count.toLocaleString() + ' 粒子');
  requestAnimationFrame(loop);
} catch (e) {
  report('playground-boot', false, String((e as Error).message ?? e));
  stats.textContent = `启动失败: ${String((e as Error).message ?? e)}`;
  (window as unknown as { __done: boolean }).__done = true;
}

// —— verify 探针模式 ——
const verifySecs = Number(params.get('verify') ?? 0);
const recordSecs = Number(params.get('record') ?? 0);
if (recordSecs > 0) {
  setTimeout(() => { recorder = recorder ?? new CanvasRecorder(); recorder.start($<HTMLCanvasElement>('cv')); }, 500);
  setTimeout(async () => {
    if (recorder?.recording) {
      const r = await recorder.stop();
      // headless 合成器可能送入近空帧(WebGPU canvas captureStream 的已知限制),
      // 这里验证"管线完整性":容器合法 + 非空 + 时长正确;内容丰富度由有头环境人工复核
      report('record-ok', r.bytes > 3000 && r.seconds > 2, `${(r.bytes / 1024).toFixed(0)} KB · ${r.mimeType} · ${r.seconds.toFixed(1)}s`);
    }
  }, (0.5 + recordSecs) * 1000);
}
if (params.get('forceprobe')) {
  setTimeout(() => {
    const hook = (window as unknown as { __setForceCell?: (i: number, j: number, v: number) => number | undefined });
    const applied = hook.__setForceCell?.(0, 1, 0.9);
    report('force-editor', applied === 0.9, `setForceCell(0,1,0.9) → 读回 ${String(applied)}`);
  }, 1500);
}
const waitSecs = Math.max(verifySecs, recordSecs + 3, params.get('forceprobe') ? 2.5 : 0);
if (waitSecs > 0) {
  setTimeout(async () => {
    const n = Number(countInput.value);
    // 阈值按规模分档(邻域成本随密度上升;grid 模式为大规模而生)
    const threshold = n <= 20_000 ? 30 : n <= 100_000 ? 20 : 12;
    const { fps } = sim!.stats();
    report('playground-fps', fps >= threshold, `${fps.toFixed(1)} fps @ ${n.toLocaleString()} (${modeSel.value});阈值 ${threshold}`);
    report('playground-no-boot-error', results.every((r) => r.name !== 'playground-boot' || r.pass));
    const gpuErrors = sim!.stats().gpuErrors;
    const lastErr = (window as unknown as { __firstGpuError?: string }).__firstGpuError;
    report('playground-no-gpu-errors', gpuErrors === 0, `GPU 运行期错误 ${gpuErrors} 条${lastErr ? ' | 首条: ' + lastErr.slice(0, 220) : ''}`);
    try {
      const ctx = await GpuContext.get();
      report('playground-adapter', true, ctx.adapterInfo);
      (window as unknown as { __adapter: string }).__adapter = ctx.adapterInfo;
    } catch { /* already reported */ }
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  }, waitSecs * 1000);
}
