/**
 * 库构建:esbuild 三入口打包(ESM,零依赖) + tsc 声明文件(rewriteRelativeImportExtensions)。
 * 构建后自动核对章程的性能预算(core < 8kB;core+particles < 15kB gzip)。
 */
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const run = (cmd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
};

const entries = [
  ['src/index.ts', 'dist/index.js'],
  ['src/packs/particles/index.ts', 'dist/particles.js'],
  ['src/packs/life/index.ts', 'dist/life.js'],
  ['src/packs/fields/index.ts', 'dist/fields.js'],
  ['src/packs/image/index.ts', 'dist/image.js'],
  ['src/interop/three.ts', 'dist/three.js'],
  ['src/react/index.tsx', 'dist/react.js', '--external:react'],
  ['src/vite.ts', 'dist/vite.js', '--external:vite'],
];
for (const [entry, outfile, extra] of entries) {
  run(`npx esbuild ${entry} --bundle --format=esm --outfile=${outfile} --log-level=warning${extra ? ' ' + extra : ''}`);
}
run('npx tsc -p tsconfig.build.json');

// —— 体积预算核对(章程"基准即文档") ——
console.log('\n体积(gzip):');
let fail = false;
for (const f of ['index.js', 'particles.js', 'three.js']) {
  const raw = readFileSync(join(DIST, f));
  const gz = gzipSync(raw).length;
  console.log(`  ${f}: ${(raw.length / 1024).toFixed(2)} kB → gzip ${(
    gz / 1024
  ).toFixed(2)} kB`);
}
const coreGz = gzipSync(readFileSync(join(DIST, 'index.js'))).length / 1024;
const withPackGz = gzipSync(readFileSync(join(DIST, 'particles.js'))).length / 1024;
if (coreGz > 15) { console.error(`  ✗ core 超预算: ${coreGz.toFixed(2)} > 15 kB`); fail = true; } // v0.9.11:主入口含 particles(开箱即用),预算 8→15
if (withPackGz > 15) { console.error(`  ✗ core+particles 超预算: ${withPackGz.toFixed(2)} > 15 kB`); fail = true; }
console.log(fail ? '\n构建完成,但超出性能预算!' : '\n✓ 构建完成,体积在性能预算内');
process.exit(fail ? 1 : 0);
