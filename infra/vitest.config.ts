import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // @gede/mail resolves to its dist through package.json exports; alias it to source so
    // the tests (and the handler they load) never depend on a stale build.
    alias: {
      '@gede/mail': fileURLToPath(new URL('../packages/mail/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesizing the whole app once per file is a few seconds; keep it out of the default budget.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
