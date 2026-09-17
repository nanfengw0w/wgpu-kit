// Error i18n for kernel.ts, layout.ts, observe.ts — replace Chinese with English
const fs = require('fs');

// kernel.ts
let fp = 'src/core/kernel.ts';
let s = fs.readFileSync(fp, 'utf8');
s = s.replace(
  "import { UsageError } from './errors.ts';",
  "import { ERR, UsageError } from './errors.ts';"
);
const kernReplacements = [
  ["throw new UsageError(`workgroupSize 必须在 1..512,收到: ${String(workgroupSize)}`);",
   "throw new UsageError(ERR.WORKGROUP_SIZE, `workgroupSize must be in 1..512, got: ${String(workgroupSize)}`);"],
  ["throw new UsageError(`elementKernel \"${name}\" 至少需要一个 state 或 inputs 字段`);",
   "throw new UsageError(ERR.RESOURCE_MISSING, `elementKernel \"${name}\" requires at least one state or inputs field`);"],
  ["throw new UsageError(`uniform 名 \"${uName}\" 是保留名(count 由库自动注入)`);",
   "throw new UsageError(ERR.USAGE, `uniform name \"${uName}\" is reserved (count is auto-injected by the library)`);"],
  ["throw new UsageError(`elementKernel \"${name}\" 的 state/inputs/uniforms 存在重名字段`);",
   "throw new UsageError(ERR.USAGE, `elementKernel \"${name}\" has duplicate field names across state/inputs/uniforms`);"],
  ["throw new UsageError(`elementKernel \"${name}\" 缺少 code(用户 WGSL 函数)`);",
   "throw new UsageError(ERR.USAGE, `elementKernel \"${name}\" is missing code (user WGSL function)`);"],
  ["throw new UsageError(`kernel \"${normalized.name}\".run 缺少资源 \"${f.key}\"`);",
   "throw new UsageError(ERR.RESOURCE_MISSING, `kernel \"${normalized.name}\".run is missing resource \"${f.key}\"`);"],
  ["throw new UsageError(`资源 \"${f.key}\" 类型不匹配: 需要 ${want},收到 ${buf.kind}`);",
   "throw new UsageError(ERR.RESOURCE_TYPE, `Resource \"${f.key}\" type mismatch: expected ${want}, got ${buf.kind}`);"],
  ["throw new UsageError(`资源 \"${f.key}\" 长度 ${buf.length} 与 \"${firstKey}\" 的 ${count} 不一致`);",
   "throw new UsageError(ERR.RESOURCE_LENGTH, `Resource \"${f.key}\" length ${buf.length} does not match \"${firstKey}\" length ${count}`);"],
];
let kernCount = 0;
for (const [o, n] of kernReplacements) {
  if (s.includes(o)) { s = s.replace(o, n); kernCount++; }
}
fs.writeFileSync(fp, s);
console.log(`kernel.ts: ${kernCount} replacements`);

// layout.ts: Chinese Error → English UsageError with codes
fp = 'src/core/layout.ts';
s = fs.readFileSync(fp, 'utf8');
s = s.replace(
  "import { alignTo, type ScalarKind } from './layout.ts';",
  "import { alignTo, type ScalarKind } from './layout.ts';"
);
// layout.ts doesn't import from itself — it IS layout.ts. Let me check imports.
// Actually layout.ts doesn't have errors import. Let me add it and replace.
if (!s.includes("import") || !s.includes("errors.ts")) {
  // Layout is self-contained, uses plain Error. Add UsageError import.
  s = "import { ERR, UsageError } from './errors.ts';\n" + s;
}
const layoutReplacements = [
  ["throw new Error(`uniform 字段 ${f.name} 的类型 ${f.kind} 暂不支持(当前仅支持标量)`);",
   "throw new UsageError(ERR.UNIFORM_UNSUPPORTED, `Uniform field \"${f.name}\" has unsupported type \"${f.kind}\". Only scalars are currently supported.`);"],
  ["throw new Error(`缺少 uniform 值: ${f.name}`);",
   "throw new UsageError(ERR.UNIFORM_FIELD, `Missing uniform value for \"${f.name}\"`);"],
  ["throw new Error(`uniform 值 ${f.name} 必须是有限数字,收到: ${String(v)}`);",
   "throw new UsageError(ERR.UNIFORM_FIELD, `Uniform value for \"${f.name}\" must be a finite number, got: ${String(v)}`);"],
];
let layoutCount = 0;
for (const [o, n] of layoutReplacements) {
  while (s.includes(o)) { s = s.replace(o, n); layoutCount++; }
}
fs.writeFileSync(fp, s);
console.log(`layout.ts: ${layoutCount} replacements`);

// observe.ts
fp = 'src/observe.ts';
s = fs.readFileSync(fp, 'utf8');
s = s.replace(
  "throw new UsageError('timestamp-query 在当前设备不可用(需 Chrome/Edge + 支持时间戳的 GPU)');",
  "throw new UsageError(ERR.TIMESTAMP_UNSUPPORTED, 'timestamp-query is not supported on this device (requires Chrome/Edge + a GPU with timestamp support)');"
);
if (!s.includes("import { ERR")) {
  s = s.replace(
    "import { UsageError } from './errors.ts';",
    "import { ERR, UsageError } from './errors.ts';"
  );
}
fs.writeFileSync(fp, s);
console.log('observe.ts ok');
