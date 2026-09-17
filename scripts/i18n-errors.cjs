// Error i18n: replace all Chinese error messages with English equivalents
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(path.dirname(process.argv[1] || __filename), '..');

function patch(rel, replacements) {
  const fp = path.join(ROOT, rel);
  let s = fs.readFileSync(fp, 'utf8');
  let count = 0;
  for (const [old, neu] of replacements) {
    if (s.includes(old)) { s = s.split(old).join(neu); count++; }
  }
  fs.writeFileSync(fp, s);
  console.log(`${rel}: ${count} replacements`);
}

// buffer.ts
patch('src/core/buffer.ts', [
  ["import { UsageError } from './errors.ts';", "import { ERR, UsageError } from './errors.ts';"],
  ["`Buffer 长度必须是正整数,收到: ${String(length)}`", "`Buffer length must be a positive integer, got: ${String(length)}`"],
  ['`未知类型 "${String(kind)}",可用: ${Object.keys(TYPES).join(\', \')}`', '`Unknown Buffer kind "${String(kind)}". Available: ${Object.keys(TYPES).join(", ")}`'],
  ["`Buffer<${this.kind}>.write 需要 ${def.typed},收到 ${data.constructor?.name ?? typeof data}`", "`Buffer<${this.kind}>.write expects ${def.typed}, got ${data.constructor?.name ?? typeof data}`"],
  ["`Buffer<${this.kind}>[${this.length}].write 需要 ${expected} 个分量,收到 ${data.length}`", "`Buffer<${this.kind}>[${this.length}].write expects ${expected} components, got ${data.length}`"],
]);

// context.ts
patch('src/core/context.ts', [
  ["'navigator.gpu 不存在'", "'navigator.gpu is not available'"],
]);

// pingpong.ts
patch('src/core/pingpong.ts', [
  ["'PingPong 至少需要一个字段'", "'PingPong requires at least one field'"],
]);

// raw.ts
patch('src/core/raw.ts', [
  ["'rawKernel 需要 WGSL 代码'", "'rawKernel requires WGSL code'"],
  ["`rawKernel.run 的 workgroups 必须是正整数,收到 ${String(workgroups)}`", "`rawKernel.run workgroups must be a positive integer, got ${String(workgroups)}`"],
]);

// media.ts
patch('src/media.ts', [
  ["'当前环境不支持 MediaRecorder 录制(无可用编码)'", "'MediaRecorder is not supported in this environment'"],
  ["'已在录制中'", "'Recording already in progress'"],
  ["`录制产物为空(${this.#mime});编码器可能不可用,换浏览器或网络前重试`", "`Recording produced 0 bytes (${this.#mime}); encoder may be unavailable`"],
]);

// config.ts
patch('src/packs/particles/config.ts', [
  ["`count 必须是 1..1_000_000 的整数,收到: ${String(count)}`", "`count must be an integer in 1..1_000_000, got: ${String(count)}`"],
  ['`mode 必须是 ${MODES.join(\' | \')},收到: "${String(mode)}"`', '`mode must be one of ${MODES.join(" | ")}, got: "${String(mode)}"`'],
  ["`mode='n2' 建议 count ≤ 20000(当前 ${count});大规模请用 mode='tiled' 或 'grid'`", "`mode='n2' is recommended for count <= 20000 (got ${count}); use 'tiled' or 'grid' for larger counts`"],
]);

// presets.ts
patch('src/packs/particles/presets.ts', [
  ['`未知力矩阵预设 "${forces}",可用: ${Object.keys(FORCE_PRESETS).join(\', \')}, random`', '`Unknown force preset "${forces}". Available: ${Object.keys(FORCE_PRESETS).join(", ")}, random`'],
]);

// image
patch('src/packs/image/index.ts', [
  ["'applyImage 需要至少一个算子'", "'applyImage requires at least one operator'"],
  ['"目标 canvas.getContext(\\"webgpu\\") 返回空"', '"target canvas.getContext(\\"webgpu\\") returned null"'],
]);

// grid pack
patch('src/packs/grid/index.ts', [
  ["`count 必须是正整数,收到 ${String(count)}`", "`count must be a positive integer, got ${String(count)}`"],
  ["`cellSize 必须为正,收到 ${String(cellSize)}`", "`cellSize must be positive, got ${String(cellSize)}`"],
]);

console.log('Done');
