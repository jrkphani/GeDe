import { expect, test } from '@playwright/test'

// Issue 036 (sync state + offline reconciliation UI). This dev build has no
// VITE_SYNC_ENABLED (v1's tested default, src/sync/config.ts) and no live
// Electric server is reachable from any test tier in this repo (HANDOFF,
// issue 032's own constraint) — the shared playwright webServer can't be
// force-enabled for just this spec without changing what every other e2e
// spec runs against. The offline → reconnecting → synced state-machine flow
// (test-first plan #2) is instead covered with the same fake-stream +
// browser online/offline-event DI 032 established, at the store/component
// tier (src/store/sync.test.ts). This e2e spec covers what's honestly
// testable against the real running app: the indicator's default-off
// behavior (no clutter for the v1 no-sync path) and the status bar's
// single-feedback-channel invariants.

async function createAndOpenProject(page: import('@playwright/test').Page, name: string) {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const phantom = page.getByPlaceholder(/Name your first project|New project/)
  await phantom.fill(name)
  await phantom.press('Enter')
  await page.getByRole('button', { name: `Open ${name}` }).click()
  await expect(page).toHaveURL(/\/p\/[^/]+\/foundation$/)
}

test('the sync indicator does not render when sync is disabled (v1 default)', async ({ page }) => {
  await createAndOpenProject(page, 'NoSync')
  await expect(page.locator('.status-bar__sync')).toHaveCount(0)
  // The ambient cluster still shows the version — unaffected by 036.
  await expect(page.locator('.status-bar__version')).toBeVisible()
})

test('the status bar remains the single aria-live feedback region with sync disabled', async ({
  page,
}) => {
  await createAndOpenProject(page, 'StatusChannel')
  const narration = page.locator('.status-bar__narration[role="status"]')
  await expect(narration).toHaveAttribute('aria-live', 'polite')
})
