import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import unimport from 'unimport/unplugin';

const srcDir = resolve(__dirname, 'src');

export default defineConfig({
  resolve: {
    alias: {
      '@src': srcDir,
      '~': resolve(srcDir, 'assets'),
    },
  },
  plugins: [
    unimport.vite({
      presets: ['vue'],
      imports: [
        { name: 'C', from: '@src/infrastructure/prun-ui/prun-css' },
        { name: 'subscribe', from: '@src/utils/subscribe-async-generator' },
        { name: 'default', as: 'tiles', from: '@src/infrastructure/prun-ui/tiles' },
        { name: 'default', as: 'features', from: '@src/features/feature-registry' },
        { name: 'default', as: 'xit', from: '@src/features/XIT/xit-registry' },
        { name: 'default', as: 'config', from: '@src/infrastructure/shell/config' },
        { name: 'createFragmentApp', from: '@src/utils/vue-fragment-app' },
        { name: 'applyCssRule', from: '@src/infrastructure/prun-ui/refined-prun-css' },
      ],
      addons: {
        vueTemplate: true,
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
