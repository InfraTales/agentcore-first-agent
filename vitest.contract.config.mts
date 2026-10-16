import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/contract/**/*.test.ts'],
    testTimeout: 120_000,
    // Building the arm64 image can take a few minutes on a cold cache.
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
