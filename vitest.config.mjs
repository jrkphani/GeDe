// Root Vitest config: each workspace carries its own vitest.config.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { projects: ['packages/*', 'services/*', 'apps/*', 'infra'] },
});
