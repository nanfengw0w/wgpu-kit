import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const showcaseRoot = fileURLToPath(new URL('../', import.meta.url));
export const repositoryRoot = path.dirname(showcaseRoot);
export const outputRoot = path.join(repositoryRoot, 'dist-playground');
export const basePath = '/wgpu-kit/';
export const libraryVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
export const sourceArchive = 'https://github.com/nanfengw0w/wgpu-kit/archive/refs/heads/main.zip';

export function outputPath(relative = '') {
  const resolved = path.resolve(outputRoot, relative.replace(/^dist(?:\/|$)/, ''));
  if (resolved !== outputRoot && !resolved.startsWith(outputRoot + path.sep)) {
    throw new Error(`Output path escapes dist-playground: ${relative}`);
  }
  return resolved;
}

export function sitePath(relative) {
  return relative.startsWith(basePath) ? relative : basePath + relative.replace(/^\//, '');
}

export function adaptHtml(html) {
  return html.replace(/\b(href|src|data-dark|data-light)=(['"])\/(?!\/)(.*?)\2/g,
    (_match, attribute, quote, relative) => `${attribute}=${quote}${sitePath(relative)}${quote}`);
}
