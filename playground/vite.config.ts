import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  build: {
    outDir: '../dist-playground',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(R, 'index.html'),
        detect: resolve(R, 'detect.html'),
        life: resolve(R, 'life.html'),
        gallery: resolve(R, 'gallery.html'),
        'react-demo': resolve(R, 'react-demo.html'),
      },
    },
  },
});
