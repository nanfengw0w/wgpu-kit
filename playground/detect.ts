/** 环境检测页:WebGPU 可用性逐级诊断 + 人话修复建议(ADR-1 的承诺)。同样遵循 harness 页面契约。 */
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const out = document.getElementById('out')!;

const line = (ok: boolean, text: string, hint = '') => {
  results.push({ name: text, pass: ok, detail: hint });
  out.innerHTML += `<div class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${text}${hint ? ` — <span class="hint">${hint}</span>` : ''}</div>`;
};

async function main() {
  line(typeof navigator !== 'undefined', '浏览器环境', navigator.userAgent.slice(0, 80));

  if (!('gpu' in navigator) || !navigator.gpu) {
    line(false, 'navigator.gpu 不存在', 'Chrome/Edge 113+ 或 Safari 18+;无头模式需开启 WebGPU 相关 flag');
    return;
  }
  line(true, 'navigator.gpu 存在');

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    line(false, 'requestAdapter() 返回 null', '检查 GPU 驱动与浏览器硬件加速设置;远程桌面/虚拟机可能无 GPU');
    return;
  }
  const info = adapter.info;
  line(true, 'adapter 获取成功', [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' / ') || 'unknown');

  try {
    const device = await adapter.requestDevice();
    line(true, 'device 获取成功', `最大缓冲 ${device.limits.maxStorageBufferBindingSize / 1024 / 1024} MB`);
    device.destroy();
  } catch (e) {
    line(false, 'device 获取失败', String((e as Error).message ?? e));
    return;
  }

  line(true, '结论:环境可用', '去玩 playground → index.html');
}

main()
  .catch((e) => line(false, '检测流程异常', String((e as Error).message ?? e)))
  .finally(() => {
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  });

export {};
