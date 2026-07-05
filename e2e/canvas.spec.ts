import { expect, test, type Page } from '@playwright/test'

// Issue 008 — read-only circle canvas. Structural assertions on the rendered
// SVG rather than pixel screenshots (no visual-snapshot infra in this repo
// yet, and GitHub Actions' Linux runner vs. local macOS font/OS rendering
// makes toHaveScreenshot()-style baselines a real flakiness risk — deferred
// to a later polish issue). Mirrors context-register.spec.ts's setup.
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

  // Cross the n = 2 floor, then add the example's third dimension.
  await addWithDefaultName()
  await addWithDefaultName()
  await expect(page.getByText('Add at least two dimensions to begin designing.')).toBeHidden()
  await page.getByRole('button', { name: 'Dimensions' }).click()
  await addWithDefaultName()

  async function renameDimension(oldName: string, newName: string) {
    await page.locator('.dim-row__name', { hasText: oldName }).click()
    await page.locator('.dim-row input').first().fill(newName)
    await page.keyboard.press('Enter')
  }
  await renameDimension('Dimension 1', 'Value')
  await renameDimension('Dimension 2', 'Stake')
  await renameDimension('Dimension 3', 'Process')

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
  await addParameterTo('Stake', 'Users')
  await addParameterTo('Process', 'Engagement')

  await page.getByRole('button', { name: 'Dimensions' }).click() // close the popover
}

test('canvas renders one arc per dimension and the empty-state prompt before any context exists', async ({
  page,
}) => {
  await setUpCanvas(page)

  await expect(page.locator('.canvas-arc')).toHaveCount(3)
  await expect(page.locator('.canvas-dot')).toHaveCount(3) // one parameter per dimension
  await expect(page.locator('.canvas-svg[data-empty="true"]')).toBeVisible()
  await expect(page.getByText('Bind your first context')).toBeVisible()
})

test('binding a context renders exactly one non-draft node with its symbol; the empty-state prompt clears', async ({
  page,
}) => {
  await setUpCanvas(page)

  const registerPhantom = page.getByPlaceholder(/Type to create your first context — it becomes α|New context/)
  await registerPhantom.click()
  await page.keyboard.type('Comfort, Users, Engagement align')
  await page.keyboard.press('Enter')

  await expect(page.locator('.canvas-node')).toHaveCount(1)
  await expect(page.locator('.canvas-node--draft')).toHaveCount(1) // unbound so far

  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  const valueCell = row.locator('td').nth(2)
  const stakeCell = row.locator('td').nth(3)
  const processCell = row.locator('td').nth(4)

  async function bindViaClick(cell: typeof valueCell, paramName: string) {
    await cell.getByRole('button').click()
    await page.getByPlaceholder('Type to filter…').fill(paramName)
    await page.keyboard.press('Enter')
    await expect(cell).toContainText(paramName)
  }
  await bindViaClick(valueCell, 'Comfort')
  await bindViaClick(stakeCell, 'Users')
  await bindViaClick(processCell, 'Engagement')

  await expect(page.locator('.canvas-svg[data-empty="true"]')).toHaveCount(0)
  await expect(page.locator('.canvas-node')).toHaveCount(1)
  await expect(page.locator('.canvas-node--draft')).toHaveCount(0)
  await expect(page.locator('.canvas-node[data-context-id] text').first()).toHaveText('α')
})

test('the canvas label tier switches as the container crosses the 640px/400px breakpoints', async ({ page }) => {
  await setUpCanvas(page)
  const shell = page.locator('.canvas-shell')

  // canvas-shell is ~40% of the side-by-side row (design-surface-row), which
  // is itself the viewport minus page padding/gap — these viewport sizes are
  // chosen so the *shell's own measured width* (not the viewport) lands
  // solidly within each STYLE_GUIDE §7 tier.
  await page.setViewportSize({ width: 1800, height: 900 })
  await expect(shell).toHaveAttribute('data-label-tier', 'full')

  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(shell).toHaveAttribute('data-label-tier', 'truncated')

  await page.setViewportSize({ width: 380, height: 900 })
  await expect(shell).toHaveAttribute('data-label-tier', 'legend')
})
