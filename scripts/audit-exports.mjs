#!/usr/bin/env node
/**
 * 发布产物审计:package.json exports 里每一个子路径都必须真实存在于 dist/。
 * 背景:v0.9.10~1.0.3 的 exports 混有 esbuild 时代路径(dist/life.js 等),
 // 而 preserved-modules 构建产物在 dist/packs/ 下——曾因 exports 指向旧 bundle 路径,7/9 子路径对用户坏死。
 // 本脚本在 prepublishOnly 里强制执行:构建后核对,缺一个就拒绝发布。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

let fail = 0;
console.log('exports 审计:');
for (const [sub, { types, import: imp }] of Object.entries(pkg.exports ?? {})) {
  for (const [label, rel] of [['types', types], ['import', imp]]) {
    const abs = join(ROOT, rel);
    const ok = existsSync(abs);
    if (!ok) { console.log(`  MISS ${sub} (${label}) → ${rel}`); fail++; }
  }
  const ok = existsSync(join(ROOT, pkg.exports[sub].import));
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${sub}`);
}
// 主入口 + 必备文件
for (const f of [pkg.main, pkg.types, 'LICENSE', 'README.md']) {
  if (!existsSync(join(ROOT, f))) { console.log(`  MISS root → ${f}`); fail++; }
}
console.log(fail ? `\n✗ ${fail} 处缺失——拒绝发布` : '\n✓ 全部 exports 目标存在');
process.exit(fail ? 1 : 0);
