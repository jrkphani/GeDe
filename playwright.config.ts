import { defineConfig } from '@playwright/test'

// CI runs on slower/contended hardware where PGlite's WASM boot + the first
// route's Vite compile push the first specs past Playwright's default 30s test
// / 5s expect timeouts (a cold-start ceiling, not a regression — see HANDOFF).
// Give CI generous headroom; keep local runs snappy.
const CI = !!process.env.CI

export default defineConfig({
  testDir: './e2e',
  timeout: CI ? 60_000 : 30_000,
  expect: { timeout: CI ? 15_000 : 5_000 },
  // 089-P7: the canvas specs now gate deploys alongside the ~57 others (P6), so a
  // single focus-timing flake under full-suite parallelism (e.g. the cross-node
  // Tab spec) could freeze prod — the 096 failure mode. CI retries recover a
  // transient flake WITHOUT masking a real regression (which fails all attempts);
  // local stays 0 so flakes surface during development, not just in CI.
  retries: CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Issue 042: disable the semantic-search model auto-load for e2e so the
    // suite never fetches ~45MB from huggingface.co (an external-network
    // dependency at the CI/deploy gate). The palette stays fully lexical here.
    env: { VITE_SEMANTIC_SEARCH: 'off' },
  },
})
