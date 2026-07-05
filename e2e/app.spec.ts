import { expect, test } from '@playwright/test'

test('shell boots: wordmark on graph paper, database migrated, no console errors', async ({
  page,
}) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'GeDe' })).toBeVisible()

  // PGlite opens and migration 0000 applies on boot (TECH_STACK §6.2).
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  expect(consoleErrors).toEqual([])
})
