/**
 * React 绑定演示 + 验证页:挂载 <ParticleCanvas />,探针读 fps 与卸载行为。
 */
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ParticleCanvas } from '../src/react/index.tsx';
import type { ParticlesSim } from '../src/packs/particles/index.ts';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const report = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

function Demo(): JSX.Element {
  const [sim, setSim] = useState<ParticlesSim | null>(null);
  useEffect(() => {
    if (!sim) return;
    const timer = setInterval(() => {
      const { fps } = sim.stats();
      document.getElementById('stats')!.innerHTML =
        `<b>${fps.toFixed(0)}</b> fps · 66,000 粒子 · grid · 已挂载 ${document.querySelectorAll('canvas').length} 个 canvas`;
    }, 500);
    return () => clearInterval(timer);
  }, [sim]);

  return (
    <ParticleCanvas
      count={66_000}
      forces="cells"
      mode="grid"
      seed="react-demo"
      onReady={(s) => {
        setSim(s);
        (window as unknown as { __sim: ParticlesSim }).__sim = s;
        report('react-mount', true, 'onReady 已回调');
      }}
    />
  );
}

createRoot(document.getElementById('stage')!).render(<Demo />);

// —— verify 探针 ——
const verifySecs = Number(new URLSearchParams(location.search).get('verify') ?? 0);
if (verifySecs > 0) {
  setTimeout(async () => {
    const sim = (window as unknown as { __sim?: ParticlesSim }).__sim;
    const canvas = document.querySelector('#stage canvas');
    report('react-canvas', !!canvas && canvas.clientWidth > 100, canvas ? `${canvas.clientWidth}x${canvas.clientHeight}` : '未找到 canvas');
    report('react-fps', (sim?.stats().fps ?? 0) > 30, `${sim?.stats().fps.toFixed(1) ?? '0'} fps(阈值 30)`);
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  }, verifySecs * 1000);
}

export {};
