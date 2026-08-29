#!/usr/bin/env node
/** 一次性诊断:有头/无头打开指定 URL,动态 import 目标模块并抓第一手错误。用法:node scripts/diag-dev.mjs <url> */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { get as httpGet } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.argv[2] ?? 'http://127.0.0.1:5173/index.html';
const HEADLESS = !process.env.WGPU_HEADED;
const BROWSER = process.env.WGPU_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const getJson = (u) => new Promise((ok, e) => { httpGet(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { ok(JSON.parse(b)); } catch (x) { e(x); } }); }).on('error', e); });

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let n = 0; const pend = new Map(); const events = [];
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) events.push(m); });
  const send = (method, params = {}, sessionId) => new Promise((ok, err) => { const id = ++n; pend.set(id, (m) => (m.error ? err(new Error(m.error.message)) : ok(m.result))); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const opened = new Promise((ok, e) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => e(new Error('ws fail'))); });
  return { opened, send, events, close: () => ws.close() };
}

const profile = mkdtempSync(join(tmpdir(), 'wgpu-diag-'));
const port = await freePort();
const child = spawn(BROWSER, ['--headless=new', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-webgpu', '--window-size=1280,800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
try {
  const { webSocketDebuggerUrl } = await (async () => { for (;;) { try { return await getJson(`http://127.0.0.1:${port}/json/version`); } catch { await new Promise((r) => setTimeout(r, 300)); } } })();
  const c = cdp(webSocketDebuggerUrl);
  await c.opened;
  const { targetInfos } = await c.send('Target.getTargets');
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Page.enable', {}, sessionId);
  await c.send('Log.enable', {}, sessionId);
  const evl = async (expression) => (await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;
  await c.send('Page.navigate', { url: URL_ }, sessionId);
  await new Promise((r) => setTimeout(r, 5000));
  // 模拟用户打开 DevTools:视口 resize → 触发页面的 resize 重建路径
  if (process.env.WGPU_RESIZE) {
    console.log('--- 模拟视口 resize(DevTools 场景)---');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false }, sessionId).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 4000));
    await c.send('Emulation.clearDeviceMetricsOverride', {}, sessionId).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 4000));
  }

  const info = await evl(`JSON.stringify({
    errRecent: (window as any).__lastErr ?? null,
    url: location.href,
    ready: document.readyState,
    results: window.__results ?? null,
    canvases: document.querySelectorAll('canvas').length,
    hud: document.getElementById('stats')?.textContent?.slice(0, 80) ?? null,
  })`).catch((e) => 'eval-error: ' + e.message);
  console.log('页面状态:', info);

  const imp = await evl(`import('/main.ts').then(() => 'IMPORT-OK').catch(e => 'IMPORT-FAIL: ' + String(e && e.message || e).slice(0, 300))`);
  console.log('动态 import main.ts:', imp);

  const snap = [...c.events.slice(0, 40), ...c.events.slice(-12)]; // 保留最早的错误 + 最近的症状
  for (const e of snap) {
    if (e.sessionId !== sessionId) continue;
    if (e.method === 'Log.entryAdded') console.log(`[log ${e.params.entry.level}]`, String(e.params.entry.text).slice(0, 220));
    if (e.method === 'Runtime.exceptionThrown') console.log('[exception]', String(e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text).slice(0, 220));
    if (e.method === 'Runtime.consoleAPICalled') console.log(`[console.${e.params.type}]`, (e.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 220));
  }
} finally {
  try { child.kill(); } catch { /* noop */ }
  for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 300)); try { rmSync(profile, { recursive: true, force: true }); break; } catch { /* busy */ } }
}
