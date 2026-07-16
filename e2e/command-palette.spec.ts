import { expect, test, type Page } from '@playwright/test'

// Issue 017 — command palette (⌘K). Drives the real shell: open, keyboard-only
// navigation, and context selection reusing the shared selection field (009).

async function openDesignWithTwoDimensions(page: Page) {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await page.getByRole('link', { name: 'Design' }).click()

  async function addDimension() {
    // Issue 082 Phase 1 — the old "Add dimension" command button was
    // replaced by a persistent phantom-row rail (type a name, press Enter).
    const dimPhantom = page.getByPlaceholder('Type to add a dimension')
    const count = await page.locator('.dim-row').count()
    await dimPhantom.fill(`Dimension ${count + 1}`)
    await dimPhantom.press('Enter')
    await expect(page.locator('.dim-row').nth(count)).toBeVisible()
  }
  await addDimension()
  await addDimension()
  await expect(page.getByText('Add a second dimension to start binding contexts.')).toBeHidden()
}

test('⌘K opens the centered palette; Escape closes it', async ({ page }) => {
  await openDesignWithTwoDimensions(page)

  await page.keyboard.press('Meta+k')
  await expect(page.locator('.command-palette')).toBeVisible()
  await expect(page.getByPlaceholder(/Jump to a tier/)).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.locator('.command-palette')).toBeHidden()
})

test('⌘K → type a tier name → Enter navigates there, keyboard-only', async ({ page }) => {
  await openDesignWithTwoDimensions(page)

  await page.keyboard.press('Meta+k')
  await page.getByPlaceholder(/Jump to a tier/).fill('Foundation')
  await expect(page.locator('.command-palette__row', { hasText: 'Foundation' })).toBeVisible()
  await page.keyboard.press('Enter')

  await expect(page.locator('.command-palette')).toBeHidden()
  await expect(page.locator('.tab--active')).toHaveText('Foundation')
})

test('⌘K → type a context symbol → Enter selects it on the canvas', async ({ page }) => {
  await openDesignWithTwoDimensions(page)

  // Create context α via the register phantom row.
  const registerPhantom = page.getByPlaceholder(/Type to create your first context — it becomes α|New context/)
  await registerPhantom.click()
  await page.keyboard.type('Comfort first')
  await page.keyboard.press('Enter')
  const alphaRow = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await expect(alphaRow).toBeVisible()

  await page.keyboard.press('Meta+k')
  await expect(page.locator('.command-palette')).toBeVisible()
  await page.getByPlaceholder(/Jump to a tier/).fill('α')
  await expect(page.locator('.command-palette__row', { hasText: 'α' })).toBeVisible()
  await page.keyboard.press('Enter')

  await expect(page.locator('.command-palette')).toBeHidden()
  // Selecting a context result navigates to its canvas AND selects it.
  await expect(page.locator('.canvas-node[aria-pressed="true"]')).toHaveCount(1)
  await expect(alphaRow).toHaveClass(/grid-row--selected/)
})
