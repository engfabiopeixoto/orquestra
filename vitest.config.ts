import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'dev/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    globalSetup: ['packages/core/test/global-setup.ts'],
  },
});
