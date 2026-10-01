#!/usr/bin/env node
/** Inspect npm's actual packlist without running lifecycle scripts or creating a tarball. */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectExports, ROOT } from './audit-exports.mjs';

const { pkg, errors, modules } = inspectExports();
if (JSON.stringify(pkg.files) !== JSON.stringify(['dist'])) errors.push('files must be exactly ["dist"]');
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
const rootFile = (path) => path === 'package.json' || /^readme(?:\.[^/]+)?$/i.test(path) || /^(?:licen[cs]e|copying)(?:\.[^/]+)?$/i.test(path);
for (const path of paths) {
  if (/\.(?:map|tgz|tar|zip)$/i.test(path) || /(?:^|\/)node_modules(?:\/|$)|(?:^|\/)tests?(?:\/|$)|\.bundle\./i.test(path)) {
    errors.push('forbidden package artifact: ' + path);
  } else if (!rootFile(path) && !modules.has(path)) {
    errors.push('file outside the public distribution: ' + path);
  }
}
for (const path of [...modules, 'package.json', 'README.md', 'LICENSE']) {
  if (!paths.has(path)) errors.push('npm pack omitted required file: ' + path);
}
for (const error of errors) console.error('  FAIL ' + error);
console.log(errors.length ? 'Package audit failed (' + errors.length + ' issues).' : 'Package audit passed: ' + pkg.name + '@' + pkg.version + ', ' + paths.size + ' files, ' + report.unpackedSize + ' unpacked bytes; no lifecycle scripts or tarball created.');
process.exitCode = errors.length ? 1 : 0;
