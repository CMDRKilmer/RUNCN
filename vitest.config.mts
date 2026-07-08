import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const srcDir = resolve(__dirname, 'src');

export default defineConfig({
  resolve: {
    alias: {
      '@src': srcDir,
      '~': resolve(srcDir, 'assets'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
