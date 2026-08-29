#!/usr/bin/env node
/**
 * wgpu-kit 验证设施(harness)
 *
 * 以无头 Chromium(优先 Chrome,回退 Edge)真实运行页面,收集页面自报的
 * 结构化测试结果。页面契约:
 *   - window.__results: [{ name, pass, detail }]
 *   - window.__adapter: adapter 描述(可选)
 *   - window.__done:   测试结束置 true
 *
 * 两条捕获路径(A/B 对比见 docs/validation/):
 *   --mode=cdp    mini-CDP:Node 内置 WebSocket 直连 DevTools(默认,零依赖)
 *                 ——弃用 puppeteer-core:与本机 Edge 151 + 启动加速驻留不兼容,
 *                    且 Edge 不支持 --remote-debugging-port=0 动态端口
 *   --mode=stderr 零依赖,spawn + 解析 --enable-logging=stderr 的 [RESULT64] 行
 *
 * 用法:node scripts/verify.mjs <page.html> [page2.html ...] [--shot <前缀>] [--mode=cdp] [--timeout=30000]
 * 页面路径相对仓库根,由内置静态服务器以 http://127.0.0.1:<port>/ 提供。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { get as httpGet } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ts': 'text/plain', '.map': 'application/json',
  '.wgsl': 'text/plain', '.md': 'text/plain',
};

const BROWSERS = [
  process.env.WGPU_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const BROWSER = BROWSERS.find((p) => existsSync(p));
if (!BROWSER) {
  console.error('[verify] 未找到 Chrome/Edge,可用 WGPU_BROWSER 环境变量指定路径');
  process.exit(2);
}

const args = process.argv.slice(2);
// 支持 --name=value 与 --name value 两种形态
const opts = {};
const pageArgs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
    else { opts[a.slice(2)] = args[i + 1]; i++; }
  } else pageArgs.push(a);
}
const pages = pageArgs;
const MODE = opts.mode ?? 'cdp';
const TIMEOUT = parseInt(opts.timeout ?? '30000', 10);
const SHOT = opts.shot ?? '';

function serve(root, port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let file = join(root, decodeURIComponent(url.pathname));
      if (file.endsWith('/')) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((ok) => {
    server.on('error', () => ok(server)); // 端口被占(如同根服务器已运行)时静默复用
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

const GPU_ARGS = ['--enable-unsafe-webgpu', '--hide-scrollbars', '--window-size=1280,800'];

/** 申请空闲 TCP 端口(Edge 151 不支持 --remote-debugging-port=0) */
const freePort = () => new Promise((ok, err) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  s.on('error', err);
});
const getJson = (url) => new Promise((ok, err) => {
  httpGet(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { err(e); } }); }).on('error', err);
});

/** mini-CDP:Node 内置 WebSocket 直连 DevTools 协议 */
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  });
  const send = (method, params = {}, sessionId) => new Promise((ok, err) => {
    const mid = ++nextId;
    pending.set(mid, (m) => (m.error ? err(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const opened = new Promise((ok, err) => {
    ws.addEventListener('open', ok);
    ws.addEventListener('error', () => err(new Error('WebSocket 连接失败')));
  });
  return { opened, send, events, close: () => ws.close() };
}

/** 按“命令行含某标记”清扫浏览器进程(标记 = 每次运行唯一的 profile 目录/调试端口) */
async function sweepByMarker(marker) {
  if (!marker) return;
  await new Promise((ok) => {
    const p = spawn('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' });
    // 必须等它跑完:harness 退出会带走未完成的清扫子进程(实测教训)
    p.on('exit', ok);
    p.on('error', ok);
    setTimeout(ok, 12000);
  });
}

/** 杀掉浏览器整棵进程树。Edge 启动器开完真身即退出 → child.pid 清理时会变尸体;
 *  所以 taskkill 只是尽力而为,真正的保证是按唯一标记的两次清扫。 */
async function killBrowserTree(child, profile, port) {
  try { child.kill(); } catch { /* noop */ }
  if (child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
  }
  await sweepByMarker(profile);
  await sweepByMarker(`--remote-debugging-port=${port}`);
}

/** 路径 B(默认):spawn 空白页 → attach → Page.navigate → 轮询 __done */
async function runCDP(url, { timeout, screenshot }) {
  const profile = mkdtempSync(join(tmpdir(), 'wgpu-kit-edge-'));
  const port = await freePort();
  const headed = !!process.env.WGPU_HEADED;
  const child = spawn(BROWSER, [
    ...(headed ? [] : ['--headless=new']), '--no-first-run', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, ...(headed ? ['--window-position=40,40', '--window-size=1280,800'] : []), ...GPU_ARGS, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    let wsUrl;
    {
      const deadline = Date.now() + 20000;
      for (;;) {
        try { wsUrl = (await getJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl; break; }
        catch { if (Date.now() > deadline) throw new Error('等待 DevTools endpoint 超时'); await new Promise((r) => setTimeout(r, 300)); }
      }
    }
    const c = cdpConnect(wsUrl);
    await c.opened;
    const { targetInfos } = await c.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await c.send('Runtime.enable', {}, sessionId);
    await c.send('Page.enable', {}, sessionId);
    await c.send('Log.enable', {}, sessionId).catch(() => undefined);

    const logs = [];
    for (const e of c.events) {
      if (e.sessionId !== sessionId) continue;
      if (e.method === 'Runtime.consoleAPICalled') {
        const text = (e.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        logs.push(`console.${e.params.type}: ${text.slice(0, 200)}`);
      } else if (e.method === 'Log.entryAdded') {
        logs.push(`browser: [${e.params.entry.level}] ${String(e.params.entry.text).slice(0, 200)}`);
      } else if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        logs.push(`[pageerror] ${d.text} ${d.exception?.description ?? ''}`.slice(0, 300));
      }
    }

    await c.send('Page.navigate', { url }, sessionId);
    const evl = async (expression) => {
      const r = await c.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      return r.result?.value;
    };
    // 等页面加载完成(最多 15s)
    {
      const deadline = Date.now() + 15000;
      for (;;) {
        const rs = await evl('document.readyState').catch(() => '');
        if (rs === 'complete') break;
        if (Date.now() > deadline) { logs.push('[verify] document.readyState 等待超时'); break; }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // 等测试完成
    {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (await evl('window.__done === true').catch(() => false)) break;
        if (Date.now() > deadline) {
          logs.push('[verify] 等待 __done 超时;诊断: ' + await evl(
            `JSON.stringify({url: location.href, readyState: document.readyState, hasGpu: 'gpu' in navigator, results: window.__results ?? null, done: window.__done ?? null})`,
          ).catch(() => 'n/a'));
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    const data = await evl('JSON.stringify({ results: window.__results ?? [], adapter: window.__adapter ?? null })').catch(() => null);
    const parsed = data ? JSON.parse(data) : { results: [], adapter: null };
    if (screenshot) {
      const shot = await c.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(resolve(screenshot), Buffer.from(shot.data, 'base64'));
    }
    c.close();
    return { results: parsed.results, adapter: parsed.adapter, logs };
  } finally {
    await killBrowserTree(child, profile, port);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { /* busy, retry */ }
    }
  }
}

/** 路径 A:零依赖 stderr 解析——解析 --enable-logging=stderr 里的 [RESULT64] 行 */
function runStderr(url, { timeout, screenshot }) {
  return new Promise((done) => {
    const profile = mkdtempSync(join(tmpdir(), 'wgpu-kit-edge-'));
    const a = [...GPU_ARGS, '--headless=new', '--enable-logging=stderr', '--v=0', `--user-data-dir=${profile}`];
    if (screenshot) a.push(`--screenshot=${resolve(screenshot)}`);
    const child = spawn(BROWSER, [...a, url], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    const results = []; const logs = [];
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      void killBrowserTree(child, profile);
      for (const line of err.split('\n')) {
        const m = line.match(/\[RESULT64\]([A-Za-z0-9+/=]+)/);
        if (m) {
          try { results.push(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))))); } catch { /* ignore */ }
        }
        const i = line.indexOf('[RESULT]');
        if (i !== -1) logs.push(`console: ${line.slice(i, i + 160)}`);
      }
      if (results.length === 0 && err) logs.push(...err.split('\n').filter((l) => l.includes('CONSOLE')).slice(-10));
      if (child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { child.kill(); } catch { /* noop */ } }
      }
      done({ results, adapter: results[0]?.adapter ?? null, logs });
    };
    const timer = setTimeout(finish, timeout);
    child.stderr.on('data', () => { if (err.includes('__done__')) setTimeout(finish, 500); });
  });
}

await mkdir(join(ROOT, 'docs/validation/results'), { recursive: true });
const server = await serve(ROOT, PORT); // 可能复用已有同根服务器
const all = [];
for (const p of pages) {
  const url = p.startsWith('http://') || p.startsWith('https://') ? p : `http://127.0.0.1:${PORT}/${p.replace(/^\//, '')}`;
  const slug = p.replace(/[^\w.-]+/g, '_').replace(/\.html$/, '');
  const screenshot = SHOT ? `${SHOT.replace(/\.png$/, '')}-${slug.replace(/.*_/, '')}.png` : undefined;
  console.log(`\n[verify] ${p}  (mode=${MODE}, browser=${BROWSER.includes('edge') ? 'edge' : 'chrome'})`);
  const t0 = performance.now();
  const { results, adapter, logs } = MODE === 'stderr'
    ? await runStderr(url, { timeout: TIMEOUT, screenshot })
    : await runCDP(url, { timeout: TIMEOUT, screenshot });
  const wall = Math.round(performance.now() - t0);
  for (const l of logs.slice(0, 10)) console.log(`  log: ${l}`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ?? ''}`);
  console.log(`  → ${results.filter((r) => r.pass).length}/${results.length} 通过,页面耗时 ${wall}ms${adapter ? `,adapter=${adapter}` : ''}`);
  all.push({ page: p, mode: MODE, adapter, wallMs: wall, results });
  if (screenshot) console.log(`  → 截图 ${screenshot}`);
  await writeFile(join(ROOT, `docs/validation/results/${slug}.json`), JSON.stringify({ ...all.at(-1), browser: BROWSER }, null, 2));
}
try { server?.close(); } catch { /* noop */ }
const failed = all.flatMap((a) => a.results).filter((r) => !r.pass).length;
const ran = all.flatMap((a) => a.results).length;
console.log(`\n[verify] 总计 ${ran - failed}/${ran} 通过 → ${failed === 0 && ran > 0 ? 'OK' : 'FAILED'}`);
process.exit(failed === 0 && ran > 0 ? 0 : 1);
