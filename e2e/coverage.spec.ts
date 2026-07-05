import { expect, test, type Page } from '@playwright/test'

// Issue 012 — the coverage matrix (SPEC §4.5, test-plan #4 at n = 3): from a
// hollow cell, compose pre-filled, justify, and watch the cell fill and the
// stat increment. Mirrors canvas-compose.spec.ts's setup but gives every
// dimension two parameters, so the tuple space (∏ mᵢ = 8) is non-trivial.
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
  await addParameterTo('Value', 'Cost')
  await addParameterTo('Stake', 'Users')
  await addParameterTo('Stake', 'Admins')
  await addParameterTo('Process', 'Engagement')
  await addParameterTo('Process', 'Onboarding')

  await page.getByRole('button', { name: 'Dimensions' }).click() // close the popover
}

test('coverage matrix: a hollow cell composes pre-filled, and justifying fills it + increments the stat', async ({
  page,
}) => {
  await setUpCanvas(page)

  // Switch to the coverage view; the stat starts at zero documented of 8.
  await page.getByRole('button', { name: 'Coverage' }).click()
  await expect(page.locator('.coverage-matrix')).toBeVisible()
  await expect(page.locator('.coverage-stat--lead')).toHaveText('0 / 8 documented')

  // The whole page is hollow — pick the Comfort × Users cell on the default
  // Process = Engagement page and open the composer from the gap.
  const gap = page.getByRole('gridcell', { name: 'Unexplored — Comfort · Users · Engagement' })
  await expect(gap).toHaveAttribute('data-documented', 'false')
  await gap.click()

  // We jump to the canvas in compose mode, pre-filled with that tuple.
  await expect(page.locator('.composer-bar[data-composing="true"]')).toBeVisible()
  await expect(page.locator('.composer-tuple')).toHaveText('{Comfort} {Users} {Engagement}')

  // Justify — required to count as documented (SPEC invariant 2).
  await page.locator('.composer-justification').click()
  const composerTextarea = page.locator('.composer-justification__input')
  await composerTextarea.fill('First documented tuple')
  await composerTextarea.press('Enter')

  // Back to coverage: the cell now carries the symbol and the stat incremented.
  await page.getByRole('button', { name: 'Coverage' }).click()
  await expect(page.locator('.coverage-stat--lead')).toHaveText('1 / 8 documented')
  const filled = page.getByRole('gridcell', { name: /— Comfort · Users · Engagement/ })
  await expect(filled).toHaveAttribute('data-documented', 'true')
  await expect(filled).toHaveText('α')
})

test('the `v` key toggles between canvas and coverage', async ({ page }) => {
  await setUpCanvas(page)

  await page.locator('.canvas-svg').click() // focus the surface, not a text field
  await page.keyboard.press('v')
  await expect(page.locator('.coverage-matrix')).toBeVisible()
  await page.keyboard.press('v')
  await expect(page.locator('.coverage-matrix')).toHaveCount(0)
  await expect(page.locator('.canvas-svg')).toBeVisible()
})
