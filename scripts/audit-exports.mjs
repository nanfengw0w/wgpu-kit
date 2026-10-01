#!/usr/bin/env node
/** Check public entrypoints and every runtime/declaration module they reference. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const posix = (path) => path.split(sep).join('/');

export function inspectExports(root = ROOT) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const dist = resolve(root, 'dist');
  const errors = [];
  const modules = new Set();
  const pending = [];
  const add = (path, label) => {
    const absolute = resolve(root, path);
    const rel = posix(relative(root, absolute));
    if (!absolute.startsWith(dist + sep) || !/\.(?:js|d\.ts)$/.test(rel)) {
      errors.push(label + ': expected a .js or .d.ts module inside dist, got ' + path);
      return;
    }
    if (!modules.has(rel)) { modules.add(rel); pending.push(rel); }
  };

  const entries = Object.entries(pkg.exports ?? {});
  if (!entries.length) errors.push('package.json has no public exports');
  for (const [subpath, conditions] of entries) {
    if (!conditions || typeof conditions !== 'object') {
      errors.push(subpath + ': expected import/types export conditions');
      continue;
    }
    for (const condition of ['import', 'types']) {
      const path = conditions[condition];
      if (typeof path !== 'string') {
        errors.push(subpath + ': missing ' + condition + ' target');
        continue;
      }
      if (!path.endsWith(condition === 'types' ? '.d.ts' : '.js')) {
        errors.push(subpath + ' [' + condition + ']: wrong target extension');
      }
      add(path, subpath + ' [' + condition + ']');
    }
  }
  for (const field of ['main', 'module', 'types']) {
    if (typeof pkg[field] !== 'string') errors.push('package.json is missing ' + field);
    else add(pkg[field], field);
  }
  if (pkg.main !== pkg.exports?.['.']?.import || pkg.module !== pkg.main || pkg.types !== pkg.exports?.['.']?.types) {
    errors.push('main/module/types must agree with the root export');
  }

  while (pending.length) {
    const file = pending.pop();
    const absolute = resolve(root, file);
    if (!existsSync(absolute)) { errors.push('missing module: ' + file); continue; }
    const declaration = file.endsWith('.d.ts');
    add(file.replace(declaration ? /\.d\.ts$/ : /\.js$/, declaration ? '.js' : '.d.ts'), file + ' companion');
    const ast = ts.createSourceFile(file, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, false, declaration ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const references = [];
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        references.push(node.moduleSpecifier.text);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        references.push(node.argument.literal.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        references.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const specifier of references.filter((name) => name.startsWith('.'))) {
      let target = resolve(dirname(absolute), specifier);
      if (declaration && !target.endsWith('.d.ts')) {
        target = /\.(?:ts|js)$/.test(target) ? target.replace(/\.(?:ts|js)$/, '.d.ts') : target + '.d.ts';
      }
      add(target, file + ' → ' + specifier);
    }
  }

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      const rel = posix(relative(root, absolute));
      if (entry.isSymbolicLink()) errors.push('dist must not contain symlinks: ' + rel);
      else if (entry.isDirectory()) walk(absolute);
      else if (!modules.has(rel)) errors.push('unexpected dist file outside the public module graph: ' + rel);
    }
  };
  if (existsSync(dist)) walk(dist);
  else errors.push('dist is missing; run npm run build first');
  return { pkg, errors, modules, entryCount: entries.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, modules, entryCount } = inspectExports();
  for (const error of errors) console.error('  FAIL ' + error);
  console.log(errors.length ? 'Export audit failed (' + errors.length + ' issues).' : 'Export audit passed: ' + entryCount + ' entrypoints, ' + modules.size + ' shared JS/declaration modules.');
  process.exitCode = errors.length ? 1 : 0;
}
