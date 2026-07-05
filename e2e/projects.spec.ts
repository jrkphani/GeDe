import { expect, test } from '@playwright/test'

test('create a project, survive a hard reload, open it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  // First-run phantom row: typing creates, no buttons, no modal.
  const phantom = page.getByPlaceholder('Name your first project')
  await phantom.fill('Tavalo')
  await phantom.press('Enter')
  await expect(page.getByText('Tavalo')).toBeVisible()

  // Reload durability: PGlite persisted to IndexedDB.
  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Tavalo')).toBeVisible()

  // Open it.
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await expect(page.getByRole('heading', { name: 'Tavalo' })).toBeVisible()
})

test('archive is undoable via the status line', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  const phantom = page.getByPlaceholder(/Name your first project|New project/)
  await phantom.fill('Throwaway')
  await phantom.press('Enter')
  await expect(page.getByText('Throwaway')).toBeVisible()

  const row = page.getByRole('button', { name: 'Open Throwaway' })
  await row.hover()
  await page.getByRole('button', { name: 'Archive Throwaway' }).click()
  await expect(page.getByText('Archived “Throwaway”')).toBeVisible()
  await expect(row).not.toBeVisible()

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('button', { name: 'Open Throwaway' })).toBeVisible()
})
