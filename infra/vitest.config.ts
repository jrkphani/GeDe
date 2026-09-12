import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesizing the whole app once per file is a few seconds; keep it out of the default budget.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
