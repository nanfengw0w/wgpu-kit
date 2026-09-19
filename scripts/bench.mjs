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

// ① 跑基准(复用 harness)。本机偶发"创建管线挂起数十秒"的间歇停顿(与代码无关,
//   新旧代码都会中招,过一会儿自愈)——超时会被 harness 判 FAIL,所以重试一次。
let ran = false;
for (let attempt = 1; attempt <= 2 && !ran; attempt++) {
  try {
    execSync(`node scripts/verify.mjs tests/gpu/bench.html --timeout 240000`,
      { cwd: ROOT, stdio: 'inherit' });
    ran = true;
  } catch (e) {
    if (attempt === 2) throw e;
    console.warn(`\n[bench] 第 ${attempt} 次运行未通过(常见为间歇性驱动停顿),重试…\n`);
  }
}

// ② 读最新结果 JSON → 生成 Markdown
const resultsDir = join(ROOT, 'docs', 'validation', 'results');
const files = readdirSync(resultsDir).filter((f) => f.startsWith('tests_gpu_bench'));
files.sort((a, b) => statMtime(b) - statMtime(a));
const latest = JSON.parse(readFileSync(join(resultsDir, files[0]), 'utf8'));

const rows = latest.results
  .filter((r) => r.name.startsWith('bench'))
  .map((r) => {
    const m = r.detail.match(/^([\d.]+) ms\/frame sync · ([\d.]+) fps 管线/);
    const [tag, ms, fpsPipe] = [r.name.replace('bench ', ''), m?.[1] ?? '?', m?.[2] ?? '?'];
    const syncFps = ms !== '?' ? (1000 / parseFloat(ms)).toFixed(1) : '?';
    return `| ${tag} | ${ms} | ${syncFps} | ${fpsPipe} |`;
  });

const md = `# 邻域算法基准(自动生成)

> 由 \`npm run bench\` 生成——勿手改。最近运行:${new Date().toLocaleString()}
> 规则:同会话内对比有效;绝对值受笔记本 GPU 热节流影响,跑基准前先 nvidia-smi 确认无外部负载。

**两种口径,不要混着读:**
- **同步延迟**(ms/帧,及 1000/ms 的折算 fps):每帧 \`tick()\` 后等 GPU 跑完再计时,
  杀死 CPU/GPU 流水线重叠——衡量单帧往返耗时的上界,适合做算法 A/B 对比。
- **管线吞吐**(fps,3 帧在途泵送):每帧提交不等完成、在途满 3 帧排空一次,
  量 CPU/GPU 重叠下的饱和吞吐——playground 实际帧率受显示节流,低于此值属正常。

| 路径 | 同步 ms/帧 | 同步折算 fps | 管线 fps(3帧在途) |
| --- | --- | --- | --- |
${rows.join('\n')}

${latest.results.find((r) => !r.pass) ? '⚠️ 存在失败探针!' : '✓ 全部探针通过'}
`;

writeFileSync(join(ROOT, 'docs', 'BENCHMARK.md'), md);
console.log('\n✓ docs/BENCHMARK.md 已生成');
