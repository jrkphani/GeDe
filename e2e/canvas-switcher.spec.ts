import { expect, test, type Page } from '@playwright/test'

// Issue 090 Phase 4c — the root-canvas switcher: create / name / switch /
// delete multiple design canvases per project, with fully INDEPENDENT
// dimension sets (the core correctness criterion — two root canvases must not
// leak rows into each other) and an undoable delete via the status bar.
//
// Mirrors the setup grammar of recursion.spec / design-layout.spec (project
// create → open → Design link; the phantom-row add grammar for dimensions).

async function openDesign(page: Page, projectName: string) {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill(projectName)
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: `Open ${projectName}` }).click()
  await page.getByRole('link', { name: 'Design' }).click()
  await expect(page).toHaveURL(/\/design$/)
}

// A dimension via the rail's persistent phantom row (082 Phase 1), scoped to
// the rail so the assertion never collides with the canvas's own dot labels.
async function addDimension(page: Page, name: string) {
  const phantom = page.getByPlaceholder('Type to add a dimension')
  await phantom.fill(name)
  await phantom.press('Enter')
  await expect(page.locator('.dim-rail').getByText(name, { exact: true })).toBeVisible()
}

// The switcher trigger's stable aria-label is `Canvas: {name}` — anchored on
// `^Canvas:` so it never matches the "Canvas" view-toggle button.
function switcherTrigger(page: Page) {
  return page.getByRole('button', { name: /^Canvas:/ })
}

test('create, switch, rename, and delete-with-Undo multiple root canvases with independent dimensions', async ({
  page,
}) => {
  await openDesign(page, 'Tavalo')

  // Canvas 1 (the seeded default) gets a dimension of its own.
  await addDimension(page, 'Alpha-dim')

  // Open the switcher and create a 2nd root canvas.
  await switcherTrigger(page).click()
  const createPhantom = page.getByPlaceholder('Type to add a canvas')
  await createPhantom.fill('Beta canvas')
  await createPhantom.press('Enter')

  // The URL now carries the selected root canvas, and the trigger names it.
  await expect(page).toHaveURL(/\?canvas=/)
  await expect(switcherTrigger(page)).toContainText('Beta canvas')

  // Canvas 2 is empty and independent — Alpha-dim is NOT here.
  await expect(page.locator('.dim-rail').getByText('Alpha-dim', { exact: true })).toBeHidden()
  await addDimension(page, 'Beta-dim')
  await expect(page.locator('.dim-rail').getByText('Beta-dim', { exact: true })).toBeVisible()
  await expect(page.locator('.dim-rail').getByText('Alpha-dim', { exact: true })).toBeHidden()

  // Switch back to Canvas 1 — the independence holds the other way too.
  await switcherTrigger(page).click()
  await page.locator('.canvas-switcher__name', { hasText: 'Canvas 1' }).click()
  await expect(page.locator('.dim-rail').getByText('Alpha-dim', { exact: true })).toBeVisible()
  await expect(page.locator('.dim-rail').getByText('Beta-dim', { exact: true })).toBeHidden()

  // Rename Canvas 1 inline via the switcher's row editor.
  await switcherTrigger(page).click()
  await page.getByRole('button', { name: 'Rename Canvas 1' }).click()
  const renameInput = page.getByRole('textbox', { name: 'Rename Canvas 1' })
  await renameInput.fill('Primary')
  await renameInput.press('Enter')
  await expect(switcherTrigger(page)).toContainText('Primary')

  // Delete "Beta canvas" — the popover is still open from the rename above.
  await page.getByRole('button', { name: 'Delete Beta canvas' }).click()
  await expect(page.locator('.canvas-switcher__name', { hasText: 'Beta canvas' })).toBeHidden()

  // The delete is soft + undoable: the status bar offers an inline Undo.
  const undo = page.locator('.status-bar').getByRole('button', { name: 'Undo' })
  await expect(undo).toBeVisible()
  await undo.click()

  // Restored — re-open the switcher and the canvas is back.
  await switcherTrigger(page).click()
  await expect(page.locator('.canvas-switcher__name', { hasText: 'Beta canvas' })).toBeVisible()
})
