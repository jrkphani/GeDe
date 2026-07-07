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
  },
})
