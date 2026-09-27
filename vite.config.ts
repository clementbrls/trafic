import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works from any sub-folder (GitHub Pages, itch.io…)
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 8192,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // simulation-heavy tests are slower on CI runners
    testTimeout: 60000,
  },
});
