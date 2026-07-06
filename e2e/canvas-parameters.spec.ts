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
    await page.getByRole('button', { name: 'Add dimension' }).click()
    await page.locator('.dim-row input').first().waitFor()
    await page.keyboard.press('Escape')
  }

  // Cross the n = 2 floor (issue 002 guided start), then reopen the manager.
  await addWithDefaultName()
  await addWithDefaultName()
  await expect(page.getByText('Add at least two dimensions to begin designing.')).toBeHidden()
  await page.getByRole('button', { name: 'Dimensions' }).click()

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

  await page.getByRole('button', { name: 'Dimensions' }).click() // close the popover
}

test('every parameter dot on the canvas carries a visible label with its name', async ({ page }) => {
  await setUpCanvas(page)

  // Ensure the canvas measures wide enough for the 'full' label tier
  // (STYLE_GUIDE §7: ≥640px).
  await page.setViewportSize({ width: 1800, height: 900 })
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

  await page.setViewportSize({ width: 1800, height: 900 })
  await expect(shell).toHaveAttribute('data-label-tier', 'full')
  await expect(page.locator('.canvas-param-label', { hasText: 'Comfort' })).toBeVisible()

  await page.setViewportSize({ width: 380, height: 900 })
  await expect(shell).toHaveAttribute('data-label-tier', 'legend')
  await expect(page.locator('.canvas-param-label')).toHaveCount(0)
})
