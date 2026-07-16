import { expect, test, type Page } from '@playwright/test'

// Issue 023 — regression guard for the bug report: "the canvas is not showing
// the parameters in each dimension." 2 dimensions, 2 parameters each — the
// exact shape from the bug report screenshot. Mirrors canvas.spec.ts's setup.
async function setUpCanvas(page: Page) {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await page.getByRole('link', { name: 'Design' }).click()

  async function addWithDefaultName() {
    // Issue 082 Phase 1 — the old "Add dimension" command button was
    // replaced by a persistent phantom-row rail (type a name, press Enter).
    // No blank-add affordance remains, so we type the same default name the
    // old flow used to leave behind.
    const phantom = page.getByPlaceholder('Type to add a dimension')
    const count = await page.locator('.dim-row').count()
    await phantom.fill(`Dimension ${count + 1}`)
    await phantom.press('Enter')
    await expect(page.locator('.dim-row').nth(count)).toBeVisible()
  }

  // Cross the n = 2 floor (issue 002 guided start), then reopen the manager.
  await addWithDefaultName()
  await addWithDefaultName()
  await expect(page.getByText('Add a second dimension to start binding contexts.')).toBeHidden()

  async function renameDimension(oldName: string, newName: string) {
    await page.locator('.dim-row__name', { hasText: oldName }).click()
    await page.locator('.dim-row input').first().fill(newName)
    await page.keyboard.press('Enter')
  }
  await renameDimension('Dimension 1', 'Value')
  await renameDimension('Dimension 2', 'Stake')

  async function addParameterTo(dimensionName: string, paramName: string) {
    const section = page.locator('.dim-section', {
      has: page.locator('.dim-row__name', { hasText: dimensionName }),
    })
    const paramPhantom = section.getByPlaceholder('Type to add a parameter')
    await paramPhantom.fill(paramName)
    await paramPhantom.press('Enter')
    await expect(section.getByText(paramName, { exact: true })).toBeVisible()
  }
  await addParameterTo('Value', 'Comfort')
  await addParameterTo('Value', 'Warmth')
  await addParameterTo('Stake', 'Users')
  await addParameterTo('Stake', 'Buyers')
}

test('every parameter dot on the canvas carries a visible label with its name', async ({ page }) => {
  await setUpCanvas(page)

  // Ensure the canvas measures wide enough for the 'full' label tier
  // (STYLE_GUIDE §7: shell width ≥640px). Issue 082 Phase 1's persistent
  // dimension rail now takes a fixed ~260px column in this row too, so a
  // wider viewport than pre-082 is needed to clear the shell's own 640px
  // threshold.
  await page.setViewportSize({ width: 2200, height: 900 })
  await expect(page.locator('.canvas-shell')).toHaveAttribute('data-label-tier', 'full')

  await expect(page.locator('.canvas-dot')).toHaveCount(4)
  await expect(page.locator('.canvas-param-label')).toHaveCount(4)

  for (const name of ['Comfort', 'Warmth', 'Users', 'Buyers']) {
    await expect(page.locator('.canvas-param-label', { hasText: name })).toBeVisible()
  }
})

test('parameter labels degrade with the canvas width, per the label-tier machinery', async ({ page }) => {
  await setUpCanvas(page)
  const shell = page.locator('.canvas-shell')

  await page.setViewportSize({ width: 2200, height: 900 })
  await expect(shell).toHaveAttribute('data-label-tier', 'full')
  await expect(page.locator('.canvas-param-label', { hasText: 'Comfort' })).toBeVisible()

  await page.setViewportSize({ width: 380, height: 900 })
  await expect(shell).toHaveAttribute('data-label-tier', 'legend')
  await expect(page.locator('.canvas-param-label')).toHaveCount(0)
})
