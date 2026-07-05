import { expect, test, type Page } from '@playwright/test'

// Issue 009 — canvas selection, spokes, composer bar, register sync.
// Mirrors canvas.spec.ts's setup (3 dimensions, one parameter each).
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

async function createAndBindAlpha(page: Page, justification: string) {
  const registerPhantom = page.getByPlaceholder(/Type to create your first context — it becomes α|New context/)
  await registerPhantom.click()
  await page.keyboard.type(justification)
  await page.keyboard.press('Enter')

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
  return row
}

test('selecting a context on the canvas populates the composer; editing justification there updates the register', async ({
  page,
}) => {
  await setUpCanvas(page)
  const row = await createAndBindAlpha(page, 'Original reason')

  await page.locator('.canvas-node[data-context-id]').first().click()

  await expect(page.locator('.composer-bar')).toBeVisible()
  await expect(page.locator('.composer-tuple')).toHaveText('{Comfort} {Users} {Engagement}')
  await expect(page.locator('.composer-justification')).toHaveText('Original reason')
  await expect(page.locator('.canvas-spoke')).toHaveCount(3)
  await expect(row).toHaveClass(/grid-row--selected/)

  await page.locator('.composer-justification').click()
  const composerTextarea = page.locator('.composer-justification__input')
  await composerTextarea.fill('Revised via composer')
  await composerTextarea.press('Enter')

  // The register's own justification cell reflects the composer's edit —
  // same underlying context, one store field.
  await expect(row.locator('td').nth(5)).toContainText('Revised via composer')
})

test('clicking a register row selects it on the canvas — spokes and the accent ring appear, non-selected contexts dim', async ({
  page,
}) => {
  await setUpCanvas(page)
  const rowAlpha = await createAndBindAlpha(page, 'Alpha reason')

  // A second, unbound (draft) context so there's something to dim.
  const registerPhantom = page.getByPlaceholder('New context')
  await registerPhantom.click()
  await page.keyboard.type('Beta reason')
  await page.keyboard.press('Enter')

  const alphaId = await rowAlpha.getAttribute('data-row-id')

  // Click the Documented cell (a static, non-editable dot) — clicking the
  // Symbol cell itself would also enter that cell's own rename-edit mode
  // (mono cells edit-in-place on click), which isn't what this test is
  // exercising and would replace the "α" text with an input's value.
  await rowAlpha.locator('.grid-col--status').click()

  await expect(page.locator('.canvas-node[aria-pressed="true"][data-context-id]')).toHaveCount(1)
  const selectedNode = page.locator('.canvas-node[aria-pressed="true"]')
  await expect(selectedNode).toHaveAttribute('data-context-id', alphaId ?? '')
  await expect(page.locator('.canvas-node--dimmed')).toHaveCount(1) // β dims, α doesn't
  await expect(page.locator('.canvas-spoke')).toHaveCount(3)
})
