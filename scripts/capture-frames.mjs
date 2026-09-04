#!/usr/bin/env node
/**
 * 物料捕获:打开粒子模拟,等结构成形,定时截帧(用于合成 README 主视觉 GIF)。
 * 用法:node scripts/capture-frames.mjs <url> <输出目录> [帧数] [间隔ms]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { get as httpGet } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.argv[2] ?? 'http://127.0.0.1:8123/dist-playground/index.html?n=66000&c=species&m=grid';
const OUT = resolve(process.argv[3] ?? join(ROOT, 'docs/assets/frames'));
const FRAMES = parseInt(process.argv[4] ?? '24', 10);
const GAP = parseInt(process.argv[5] ?? '400', 10);
const WARMUP = parseInt(process.argv[6] ?? '9000', 10);

const BROWSER = process.env.WGPU_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!existsSync(BROWSER)) { console.error('browser not found'); process.exit(2); }

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const getJson = (u) => new Promise((ok, e) => { httpGet(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { ok(JSON.parse(b)); } catch (x) { e(x); } }); }).on('error', e); });

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let n = 0;
  const pend = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) events.push(m);
  });
  const send = (method, params = {}, sessionId) => new Promise((ok, err) => {
    const id = ++n;
    pend.set(id, (m) => (m.error ? err(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const opened = new Promise((ok, e) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => e(new Error('ws fail'))); });
  return { opened, send, events, close: () => ws.close() };
}

const profile = mkdtempSync(join(tmpdir(), 'wgpu-cap-'));
const port = await freePort();
const child = spawn(BROWSER, ['--headless=new', '--no-first-run', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--hide-scrollbars', '--window-size=1280,800', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });

try {
  let wsUrl;
  const dl = Date.now() + 20000;
  for (;;) {
    try { wsUrl = (await getJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl; break; }
    catch { if (Date.now() > dl) throw new Error('devtools timeout'); await new Promise((r) => setTimeout(r, 300)); }
  }
  const c = cdp(wsUrl);
  await c.opened;
  const { targetInfos } = await c.send('Target.getTargets');
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await c.send('Page.navigate', { url: URL_ }, sessionId);

  // 等 warmup(结构成形)
  console.log(`warmup ${WARMUP}ms …`);
  await new Promise((r) => setTimeout(r, WARMUP));

  mkdirSync(OUT, { recursive: true });
  for (let i = 0; i < FRAMES; i++) {
    const shot = await c.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(join(OUT, `frame-${String(i).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'));
    process.stdout.write(`frame ${i + 1}/${FRAMES}\r`);
    await new Promise((r) => setTimeout(r, GAP));
  }
  console.log(`\n${FRAMES} 帧 → ${OUT}`);
} finally {
  try { child.kill(); } catch { /* noop */ }
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try { rmSync(profile, { recursive: true, force: true }); break; } catch { /* busy */ }
  }
}
