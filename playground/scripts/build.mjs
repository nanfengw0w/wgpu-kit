import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { outputRoot, outputPath, showcaseRoot } from './paths.mjs';

// Only generated output is removed; public contains the original design/assets.
fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });
fs.cpSync(path.join(showcaseRoot, 'public'), outputRoot, { recursive: true });
fs.mkdirSync(outputPath('source'), { recursive: true });
await import('./build-pages.mjs');
const { formatAllSources } = await import('./format-source.mjs');
await formatAllSources();
await build({
  absWorkingDir: showcaseRoot,
  entryPoints: ['src/app.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: outputPath('app.js'),
  minify: true,
  sourcemap: true,
  legalComments: 'linked',
});
fs.mkdirSync(outputPath('source'), { recursive: true });
for (const relative of ['sky-input', 'depth-light', 'gpu/card-light', 'gpu/card-transport', 'gpu/light-aperture', 'gpu/star-wake', 'gpu/dawn-atmosphere']) {
  fs.copyFileSync(path.join(showcaseRoot, 'src', relative + '.ts'), outputPath('source/' + path.basename(relative) + '.ts'));
}
fs.writeFileSync(outputPath('.nojekyll'), '');
console.log('Built showcase at dist-playground for /wgpu-kit/ (31 routes).');
