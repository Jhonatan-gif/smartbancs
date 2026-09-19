import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    env: { LOG_LEVEL: 'silent' },
  },
});
