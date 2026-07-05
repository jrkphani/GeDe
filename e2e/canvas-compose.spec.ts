import { expect, test, type Page } from '@playwright/test'

// Issue 010 — compose & bind a context entirely on the canvas, then assert the
// register projection matches (SPEC §6 M2 done-when: recreate prototype image 1
// by direct manipulation). Mirrors canvas-selection.spec.ts's setup: 3
// dimensions (Value/Stake/Process), one parameter each.
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
  await addParameterTo('Stake', 'Users')
  await addParameterTo('Process', 'Engagement')

  await page.getByRole('button', { name: 'Dimensions' }).click() // close the popover
}

test('compose α on the canvas — bind three dots, justify — and the register row matches', async ({
  page,
}) => {
  await setUpCanvas(page)

  // Enter compose mode: a draft node (dashed ring, symbol α) appears.
  await page.getByRole('button', { name: 'New context' }).click()
  const draftNode = page.locator('.canvas-node--draft')
  await expect(draftNode).toHaveCount(1)
  await expect(page.locator('.composer-bar[data-composing="true"]')).toBeVisible()

  // Each dimension has exactly one parameter dot; binding them in sort order
  // reproduces prototype image 1 (Comfort / Users / Engagement).
  const dots = page.locator('.canvas-dot-group')
  await expect(dots).toHaveCount(3)
  await dots.nth(0).click()
  await dots.nth(1).click()
  await dots.nth(2).click()

  // Now complete: dashed ring gone, three spokes drawn, tuple read out.
  await expect(page.locator('.canvas-node--draft')).toHaveCount(0)
  await expect(page.locator('.canvas-spoke')).toHaveCount(3)
  await expect(page.locator('.composer-tuple')).toHaveText('{Comfort} {Users} {Engagement}')

  // Justify in the composer (required to mark documented).
  await page.locator('.composer-justification').click()
  const composerTextarea = page.locator('.composer-justification__input')
  await composerTextarea.fill('First real context')
  await composerTextarea.press('Enter')

  // The register — same tree, other projection — shows α fully bound + justified.
  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await expect(row.locator('td').nth(2)).toContainText('Comfort')
  await expect(row.locator('td').nth(3)).toContainText('Users')
  await expect(row.locator('td').nth(4)).toContainText('Engagement')
  await expect(row.locator('td').nth(5)).toContainText('First real context')
  await expect(row.locator('.status-dot')).toHaveAttribute('data-status', 'documented')
})

test('the `c` key enters compose mode and Escape keeps the draft with a discard offer', async ({
  page,
}) => {
  await setUpCanvas(page)

  await page.locator('.canvas-svg').click() // focus the canvas surface, not a text field
  await page.keyboard.press('c')
  await expect(page.locator('.canvas-node--draft')).toHaveCount(1)
  await expect(page.locator('.composer-bar[data-composing="true"]')).toBeVisible()

  // Escape leaves compose mode but keeps the draft; the status bar offers a
  // one-action discard (drafts are legal — no confirmation dialog).
  await page.keyboard.press('Escape')
  await expect(page.locator('.composer-bar[data-composing="true"]')).toHaveCount(0)
  await expect(page.locator('.canvas-node--draft')).toHaveCount(1)
  const discard = page.locator('.status-bar').getByRole('button', { name: /Discard draft/ })
  await expect(discard).toBeVisible()

  // Discarding removes the draft (and is itself undoable).
  await discard.click()
  await expect(page.locator('.canvas-node')).toHaveCount(0)
})
