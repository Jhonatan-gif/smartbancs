import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    env: {
      LOG_LEVEL: 'silent',
      DB_CONNECT_TIMEOUT_MS: '20000',
      DB_LOCK_TIMEOUT_MS: '10000',
      DB_STATEMENT_TIMEOUT_MS: '20000',
    },
  },
});
