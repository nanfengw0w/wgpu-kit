/** 环境检测页:WebGPU 可用性逐级诊断 + 人话修复建议(ADR-1 的承诺)。同样遵循 harness 页面契约。 */
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const out = document.getElementById('out')!;

const line = (ok: boolean, text: string, hint = '') => {
  results.push({ name: text, pass: ok, detail: hint });
  out.innerHTML += `<div class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${text}${hint ? ` — <span class="hint">${hint}</span>` : ''}</div>`;
};

async function main() {
  line(typeof navigator !== 'undefined', 'Browser', navigator.userAgent.slice(0, 80));

  if (!('gpu' in navigator) || !navigator.gpu) {
    line(false, 'navigator.gpu missing', 'Needs Chrome/Edge 113+ or Safari 18+; enable WebGPU flags in headless mode');
    return;
  }
  line(true, 'navigator.gpu present');

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    line(false, 'requestAdapter() returned null', 'Check GPU driver / hardware acceleration; remote desktop or VMs may lack GPU');
    return;
  }
  const info = adapter.info;
  line(true, 'Adapter acquired', [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' / ') || 'unknown');

  try {
    const device = await adapter.requestDevice();
    line(true, 'Device acquired', `最大缓冲 ${device.limits.maxStorageBufferBindingSize / 1024 / 1024} MB`);
    device.destroy();
  } catch (e) {
    line(false, 'Device request failed', String((e as Error).message ?? e));
    return;
  }

  line(true, 'Environment OK', 'Open index.html to run the playground');
}

main()
  .catch((e) => line(false, 'Check flow error', String((e as Error).message ?? e)))
  .finally(() => {
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  });

export {};
