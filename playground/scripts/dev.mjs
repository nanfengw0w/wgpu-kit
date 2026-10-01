import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pipeline } from 'node:stream';
import { basePath, outputRoot, outputPath } from './paths.mjs';

if (!process.argv.includes('--no-build')) await import('./build.mjs');
if (!fs.existsSync(outputPath('index.html'))) throw new Error('Run npm run build:playground first.');
const port = Number(process.env.PORT ?? process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 5178);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port.');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const redirect = location => { response.writeHead(302, { Location: location }); response.end(); };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
  }
  if (url.pathname === '/' || url.pathname === basePath.slice(0, -1)) { redirect(basePath + url.search); return; }
  if (!url.pathname.startsWith(basePath)) { response.writeHead(404); response.end('Not found'); return; }
  let file;
  try {
    file = outputPath(decodeURIComponent(url.pathname.slice(basePath.length)));
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      if (!url.pathname.endsWith('/')) { redirect(url.pathname + '/' + url.search); return; }
      file = path.join(file, 'index.html');
    }
    const info = fs.statSync(file);
    if (!info.isFile()) throw new Error('Not a file');
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
    if (request.method === 'HEAD') { response.end(); return; }
    pipeline(fs.createReadStream(file), response, error => { if (error) response.destroy(error); });
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Showcase preview: http://127.0.0.1:${port}${basePath} (from ${outputRoot})`));
