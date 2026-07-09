import { defineConfig } from 'vite';
import { resolve } from 'path';

// Separate build for content scripts. They must be self-contained IIFE
// files because Manifest V3 content scripts load as classic scripts,
// not ES modules. The page script (refined-prun.ts) is built separately
// by vite.config.mts as an ES module and injected via <script type="module">.

const srcDir = resolve(__dirname, 'src');
const outDir = resolve(__dirname, 'dist');

export default defineConfig({
  resolve: {
    alias: {
      '@src': srcDir,
      '~': resolve(srcDir, 'assets'),
    },
  },
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: {
        'refined-prun-startup': resolve(srcDir, 'refined-prun-startup.ts'),
      },
      external: ['chrome'],
      output: {
        format: 'iife',
        entryFileNames: '[name].js',
      },
    },
  },
  define: {
    'process.env.NODE_ENV': `"${process.env.NODE_ENV}"`,
  },
});
