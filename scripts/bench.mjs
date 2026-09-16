#!/usr/bin/env node
/**
 * 基准脚本化:跑邻域算法基准页 → 生成 docs/BENCHMARK.md。
 * 规矩("基准即文档")的机制兜底:数字进 README 前必须能由本命令复现。
 * 用法:npm run bench
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ① 跑基准(复用 harness)
execSync(`node scripts/verify.mjs tests/gpu/bench.html --timeout 240000`,
  { cwd: ROOT, stdio: 'inherit' });

// ② 读最新结果 JSON → 生成 Markdown
const resultsDir = join(ROOT, 'docs', 'validation', 'results');
const files = readdirSync(resultsDir).filter((f) => f.startsWith('tests_gpu_bench'));
files.sort((a, b) => statMtime(b) - statMtime(a));
const latest = JSON.parse(readFileSync(join(resultsDir, files[0]), 'utf8'));

const rows = latest.results
  .filter((r) => r.name.startsWith('bench'))
  .map((r) => {
    const m = r.detail.match(/^([\d.]+) ms\/frame ≈ ([\d.]+) fps/);
    const [tag, ms, fps] = [r.name.replace('bench ', ''), m?.[1] ?? '?', m?.[2] ?? '?'];
    return `| ${tag} | ${ms} | ${fps} |`;
  });

const md = `# 邻域算法基准(自动生成)

> 由 \`npm run bench\` 生成——勿手改。最近运行:${new Date().toLocaleString()}
> 规则:同会话内对比有效;绝对值受笔记本 GPU 热节流影响,跑基准前先 nvidia-smi 确认无外部负载。

| 路径 | 粒子数 | ms/帧 | fps |
| --- | --- | --- | --- |
${rows.join('\n')}

${latest.results.find((r) => !r.pass) ? '⚠️ 存在失败探针!' : '✓ 全部探针通过'}
`;

writeFileSync(join(ROOT, 'docs', 'BENCHMARK.md'), md);
console.log('\n✓ docs/BENCHMARK.md 已生成');
