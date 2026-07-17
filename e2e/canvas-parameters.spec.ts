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

  // Issue 089 D2 — the Design surface is a co-mounted, fixed-width lane now, so
  // the canvas `.canvas-shell` can no longer reach the 'full' tier (≥640px); it
  // tops out ~592px (see canvas.spec.ts for the measured explanation). Param
  // labels are hidden ONLY in the 'legend' tier (Canvas.tsx renders them for
  // both 'full' and 'truncated'), so a 'truncated'-tier viewport still proves
  // "every dot carries a visible label". The four names here are all ≤ 8 chars
  // (PARAM_LABEL_TRUNCATE_LENGTH), so they render in FULL even at 'truncated' —
  // the label-text assertions below are unaffected by truncation.
  await page.setViewportSize({ width: 560, height: 900 })
  await expect(page.locator('.canvas-shell')).toHaveAttribute('data-label-tier', 'truncated')

  await expect(page.locator('.canvas-dot')).toHaveCount(4)
  await expect(page.locator('.canvas-param-label')).toHaveCount(4)

  for (const name of ['Comfort', 'Warmth', 'Users', 'Buyers']) {
    await expect(page.locator('.canvas-param-label', { hasText: name })).toBeVisible()
  }
})

test('parameter labels degrade with the canvas width, per the label-tier machinery', async ({ page }) => {
  await setUpCanvas(page)
  const shell = page.locator('.canvas-shell')

  // Issue 089 D2 — 'full' is lane-unreachable; 'truncated' is the widest
  // reachable tier that still shows labels (see the note above / canvas.spec.ts).
  // The degrade this test asserts — labels present at width, gone in 'legend' —
  // is proven across the reachable truncated → legend switch.
  await page.setViewportSize({ width: 560, height: 900 })
  await expect(shell).toHaveAttribute('data-label-tier', 'truncated')
  await expect(page.locator('.canvas-param-label', { hasText: 'Comfort' })).toBeVisible()

  await page.setViewportSize({ width: 380, height: 900 })
  await expect(shell).toHaveAttribute('data-label-tier', 'legend')
  await expect(page.locator('.canvas-param-label')).toHaveCount(0)
})
