#!/usr/bin/env node
/** Inspect npm's actual packlist without running lifecycle scripts or creating a tarball. */
import { execSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectExports, ROOT } from './audit-exports.mjs';

const { pkg, errors, modules } = inspectExports();
const publicDocs = [
  'docs/API.md',
  'docs/API.zh-CN.md',
  'docs/COMPUTE-RENDER.md',
  'docs/COMPUTE-RENDER.zh-CN.md',
  'docs/examples/shared-device.html',
];
const rootFiles = ['package.json', 'README.md', 'README.cn.md', 'LICENSE'];
if (JSON.stringify(pkg.files) !== JSON.stringify(['dist', ...publicDocs])) {
  errors.push('files must be exactly dist plus the five explicit public documentation paths');
}
if (Object.keys(pkg.dependencies ?? {}).length) errors.push('the library must have zero runtime dependencies');
const lock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8'));
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) errors.push('package-lock.json root versions must match package.json');

const output = execSync('npm pack --dry-run --ignore-scripts --offline --json', {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, npm_config_cache: join(tmpdir(), 'wgpu-kit-npm-cache'), npm_config_update_notifier: 'false' },
});
const reports = JSON.parse(output);
if (reports.length !== 1 || reports[0].name !== pkg.name || reports[0].version !== pkg.version) errors.push('npm pack returned unexpected package metadata');
const report = reports[0];
const paths = new Set((report?.files ?? []).map((file) => file.path.replaceAll('\\', '/')));
const publicFiles = new Set([...rootFiles, ...publicDocs]);
for (const path of paths) {
  if (/\.(?:map|tgz|tar|zip|log)$/i.test(path) ||
      /(?:^|\/)(?:node_modules|tests?|qa|validation|\.git|\.codex|\.workbuddy-ai)(?:\/|$)|\.bundle\./i.test(path) ||
      /(?:^|\/)(?:AGENTS\.md|AI-HANDOFF\.md|CHANGELOG(?:\.[^/]+)?|\.env(?:\.[^/]+)?|\.npmrc)$/i.test(path)) {
    errors.push('forbidden package artifact: ' + path);
  } else if (!publicFiles.has(path) && !modules.has(path)) {
    errors.push('file outside the public distribution: ' + path);
  }
}
for (const path of [...modules, ...publicFiles]) {
  if (!paths.has(path)) errors.push('npm pack omitted required file: ' + path);
}

// Only inspect public documents. Links must work from the unpacked package,
// without depending on repository-only notes, examples or generated media.
for (const file of [...rootFiles, ...publicDocs].filter((path) => path.endsWith('.md'))) {
  if (!paths.has(file)) continue;
  const absolute = resolve(ROOT, file);
  if (!lstatSync(absolute).isFile()) {
    errors.push('public documentation must be a regular file: ' + file);
    continue;
  }
  const markdown = readFileSync(absolute, 'utf8')
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[ \t]*\r?$/gm, '')
    .replace(/`+[^`\n]*`+/g, '');
  const links = [
    ...markdown.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^"'\n]*["'])?\s*\)/g),
    ...markdown.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm),
    ...markdown.matchAll(/\b(?:href|src)=["']([^"']+)["']/g),
  ];
  for (const match of links) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^(?:file:|[a-z]:[\\/])/i.test(target)) {
      errors.push('local filesystem link in public documentation: ' + file);
      continue;
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#|\?)/i.test(target)) continue;
    let local;
    try { local = decodeURIComponent(target.split(/[?#]/, 1)[0]); }
    catch { errors.push('invalid local documentation link in ' + file); continue; }
    if (!local) continue;
    const destination = local.startsWith('/') ? posix.normalize(local.slice(1)) : posix.normalize(posix.join(posix.dirname(file), local));
    if (!paths.has(destination)) errors.push(file + ' links to a file omitted from npm pack: ' + destination);
  }
}
for (const error of errors) console.error('  FAIL ' + error);
console.log(errors.length ? 'Package audit failed (' + errors.length + ' issues).' : 'Package audit passed: ' + pkg.name + '@' + pkg.version + ', ' + paths.size + ' files, ' + report.unpackedSize + ' unpacked bytes; no lifecycle scripts or tarball created.');
process.exitCode = errors.length ? 1 : 0;
