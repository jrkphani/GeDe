import { defineConfig, devices } from '@playwright/test';

/**
 * The live suite: `e2e-live/` against a deployed GeDe (`E2E_BASE_URL`, `https://gede.work`
 * in the pipeline's Playwright-Live step, after Smoke) as the pool's `e2e@gede.work`
 * account. Nothing is faked: real Cognito, real sync service, real CloudFront. What the suite
 * needs and how it signs in is in `e2e-live/fixtures/live.ts` and docs/TESTING.md.
 *
 * One worker, serial: the suite shares one account, cleans up after itself, and a production
 * service is not a load target. Sixty seconds per test: every step crosses the network.
 */
const CI = Boolean(process.env.CI);
const baseURL = process.env.E2E_BASE_URL;
if (baseURL === undefined || baseURL === '') {
  throw new Error('E2E_BASE_URL is required for the live suite (for example https://gede.work)');
}

export default defineConfig({
  testDir: './e2e-live',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report-live' }],
        ['json', { outputFile: 'test-results-live/e2e-live.json' }],
      ]
    : 'list',
  outputDir: 'test-results-live',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    {
      name: 'chromium',
      // Desktop Chrome reports a Windows UA, so the app's chords resolve to Control (as in e2e/).
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
