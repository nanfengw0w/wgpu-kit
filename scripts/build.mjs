#!/usr/bin/env node
/**
 * 库构建 v2:tsc emit 保留模块结构(preservedModules)。
 *
 * 为什么弃用 esbuild 打包:v0.9.11 发布后,外部评审用探针证实——每个入口独立
 * bundle 内嵌一份 GpuContext 单例,`import {elementKernel} from 'wgpu-kit'` 与
 * `import {particles} from 'wgpu-kit/particles'` 拿到**两个 GPUDevice**,
 * 跨入口传 Buffer 直接报 "Buffer is associated with one Device"。
 *
 * preservedModules 让所有入口引用同一份 dist/core/context.js——模块级单例
 * 在 ESM 下天然全库唯一,多设备问题从结构上消失。
 */
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

rmSync(DIST, { recursive: true, force: true });

const run = (cmd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
};

// 全量 tsc emit:保留模块结构,入口间共享 dist/core/*
run('npx tsc -p tsconfig.build.json');

// 体积预算核对(遍历关键产物)
const sizes = [];
const walk = (dir, prefix = '') => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, `${prefix}${f}/`);
    else if (f.endsWith('.js')) sizes.push({ file: `${prefix}${f}`, path: p });
  }
};
walk(DIST);

console.log('\n体积(gzip):');
let fail = false;
let totalCore = 0;
for (const { file, path } of sizes.sort((a, b) => a.file.localeCompare(b.file))) {
  const gz = gzipSync(readFileSync(path)).length / 1024;
  console.log(`  ${file}: ${gz.toFixed(2)} kB gzip`);
  if ((file === 'index.js' || file.startsWith('core/') || file === 'layout.js' || file === 'errors.js') && file !== 'observe.js') totalCore += gz;
}
console.log(`  → core 合计: ${totalCore.toFixed(2)} kB gzip(预算 <15)`);
if (totalCore > 15) { console.error('  ✗ core 超预算'); fail = true; }

// 结构断言:全库必须共享唯一 context 模块(多设备问题的结构性防线)
const contextFiles = readdirSync(join(DIST, 'core')).filter((f) => f === 'context.js').length;
if (contextFiles !== 1) { console.error('  ✗ dist/core/context.js 不唯一,多设备问题将复现'); fail = true; }
console.log(`  context.js 副本: ${contextFiles}(必须为 1)`);

// 结构断言:exports 里每个子路径指向的文件都必须真实存在。
// (v1.0.3 事故:6 个子路径指向 dist/particles.js 这类根级文件,而 tsc preservedModules
//  只镜像 src/ 结构,这些文件根本不存在 —— 发布后 wgpu-kit/particles 等子路径 import 直接失败。)
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const missing = [];
for (const [subpath, cond] of Object.entries(pkg.exports ?? {})) {
  for (const [key, rel] of Object.entries(cond)) {
    if (!existsSync(join(ROOT, rel))) missing.push(`${subpath} [${key}] → ${rel}`);
  }
}
if (missing.length) {
  console.error('  ✗ exports 指向不存在的产物:');
  for (const m of missing) console.error(`      ${m}`);
  fail = true;
} else {
  console.log(`  exports 目标: ${Object.keys(pkg.exports ?? {}).length} 个子路径全部命中产物`);
}

console.log(fail ? '\n构建失败!' : '\n✓ 构建完成(preservedModules),体积与结构断言通过');
process.exit(fail ? 1 : 0);
