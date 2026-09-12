import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright journeys against a built web app, no backend.
 *
 * The web server builds `e2e/dist/` with `e2e/vite.config.ts` (the production
 * build plus `/config.json` from `e2e/fixtures/config.json` and the error-page
 * harness) and serves it with `vite preview`. Set `E2E_BASE_URL` to point the
 * suite at something already running instead.
 *
 * Breakpoints and 200 % zoom are chosen per test (see `e2e/fixtures/test.ts`);
 * the single project is desktop Chromium at 1440 × 900.
 */
const PORT = 4173;
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // CodeBuild SMALL is 2 vCPU / 3 GB: two Chromium workers is the ceiling there.
  ...(CI ? { workers: 2 } : {}),
  reporter: CI
    ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/e2e.json' }]]
    : 'list',
  outputDir: 'test-results',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    // The error pages copy their reference to the clipboard; the spec reads it back.
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: `npm run e2e:build && npm run e2e:preview -- --port ${PORT}`,
          url: baseURL,
          reuseExistingServer: !CI,
          timeout: 180_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
      }),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
