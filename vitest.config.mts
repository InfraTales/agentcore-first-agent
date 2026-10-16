import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // test/contract builds and starts the real container: `npm run test:contract`.
    exclude: ['test/contract/**', 'node_modules/**'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
