import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Workspace packages resolve to their `dist` through package.json `exports`;
 * alias them to source so tests never depend on a stale build.
 */
const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@gede/core': pkg('core'),
      '@gede/db': pkg('db'),
      '@gede/mail': pkg('mail'),
    },
  },
  test: {
    name: 'sync',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
