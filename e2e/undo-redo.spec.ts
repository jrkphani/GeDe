import { expect, test } from '@playwright/test'

// issue 006, test-first plan item 4: edit a cell, ⌘Z reverts it, reload
// proves the reverted state is what persisted (not just an in-memory revert).
test('⌘Z reverts a justification edit; the reverted value survives a reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await page.getByRole('link', { name: 'Design' }).click()

  // Cross the n = 2 floor so the register is live. Issue 082 Phase 1 — the
  // old "Add dimension" command button was replaced by a persistent
  // phantom-row rail (type a name, press Enter).
  const dimPhantom = page.getByPlaceholder('Type to add a dimension')
  await dimPhantom.fill('Dimension 1')
  await dimPhantom.press('Enter')
  await expect(page.locator('.dim-row')).toHaveCount(1)
  await dimPhantom.fill('Dimension 2')
  await dimPhantom.press('Enter')
  await expect(page.locator('.dim-row')).toHaveCount(2)
  // Crossing the floor swaps the guided panel for the real DesignSurface.
  // Issue 082 Phase 1 retired the "Dimensions" popover trigger entirely — the
  // dimension manager is now an always-open rail, so there's nothing to open
  // or accidentally toggle here anymore.

  const registerPhantom = page.getByPlaceholder('Type to create your first context — it becomes α')
  await registerPhantom.click()
  await page.keyboard.type('Original justification')
  await page.keyboard.press('Enter')

  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  const justificationCell = row.locator('.grid-cell--multiline')
  // Generous timeout: context creation batches two sequential DB writes
  // before this, the register's first content assertion, renders anything.
  await expect(justificationCell).toContainText('Original justification', { timeout: 15_000 })

  // Edit the cell.
  await justificationCell.click()
  const textarea = row.locator('textarea')
  await textarea.fill('Changed justification')
  await page.keyboard.press('Enter')
  await expect(justificationCell).toContainText('Changed justification', { timeout: 15_000 })

  // ⇧⌘Z first (a no-op — nothing to redo yet), sanity-checking it doesn't
  // accidentally do something before we've undone anything.
  await page.keyboard.press('Control+Shift+z')
  await expect(justificationCell).toContainText('Changed justification')

  // ⌘Z reverts it, narrated in the status bar.
  await page.keyboard.press('Control+z')
  await expect(justificationCell).toContainText('Original justification', { timeout: 15_000 })
  await expect(page.locator('.status-bar')).toContainText('Undid:')

  // ⇧⌘Z redoes it, within the same session.
  await page.keyboard.press('Control+Shift+z')
  await expect(justificationCell).toContainText('Changed justification', { timeout: 15_000 })

  // Undo again, then reload: the reverted state is what persisted — not just
  // an in-memory undo (the command log itself doesn't survive a reload).
  await page.keyboard.press('Control+z')
  await expect(justificationCell).toContainText('Original justification', { timeout: 15_000 })
  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const rowAfter = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await expect(rowAfter.locator('.grid-cell--multiline')).toContainText('Original justification', {
    timeout: 15_000,
  })
})
