import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'skills-engine/**/*.test.ts'],
    env: {
      LOG_LEVEL: 'silent',
    },
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
