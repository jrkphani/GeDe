import { defineConfig } from '@playwright/test'

// CI runs on slower/contended hardware where PGlite's WASM boot + the first
// route's Vite compile push the first specs past Playwright's default 30s test
// / 5s expect timeouts (a cold-start ceiling, not a regression — see HANDOFF).
// Give CI generous headroom; keep local runs snappy.
const CI = !!process.env.CI

// The two heavy canvas suites — d3-canvas (32 tests) and architecture (29) —
// are ~60% of the e2e suite and each test boots a canvas with its own PGlite
// store. Run concurrently on a 2-worker CI runner they spike peak load enough
// to push child-core mount past its ceiling: the 100-D α1 flake, which fails
// all 3 retries yet passes in 8s locally in isolation. That made the e2e gate
// block PRs for reasons unrelated to their contents (and masked a red main —
// see PR #18), so they get a dedicated SERIAL lane via `npm run e2e:canvas`
// (--workers=1) while the other 23 spec files stay parallel in `e2e:app`.
// Splitting by project rather than by timeout keeps the ceilings meaningful:
// a spec that blows 30s here is slow for a real reason, not a contended one.
const HEAVY_CANVAS_SPECS = /(d3-canvas|architecture)\.spec\.ts/
const TOUCH_CANVAS_SPECS = /d3-canvas\.spec\.ts/
const TOUCH_TAG = /@touch/

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
  projects: [
    { name: 'canvas-serial', testMatch: HEAVY_CANVAS_SPECS, grepInvert: TOUCH_TAG },
    { name: 'touch-serial', testMatch: TOUCH_CANVAS_SPECS, grep: TOUCH_TAG },
    { name: 'app', testIgnore: HEAVY_CANVAS_SPECS },
  ],
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
