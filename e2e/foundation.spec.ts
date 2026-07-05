import { expect, test, type Page } from '@playwright/test'

const PROPS = [
  'Seating-status comfort',
  'Mobility fluidity',
  'Social configurability',
  'Spatial economy',
  'Age-spectrum compatibility',
]

// dnd-kit listens on pointer events (not HTML5 drag) — drive the mouse by hand
// with intermediate moves so the sensor activates and settles over the target.
// Drag handles reveal on row hover (STYLE_GUIDE §6), so hover each row before
// measuring its handle.
async function dragHandleOnto(page: Page, fromName: string, toName: string) {
  const fromRow = page.locator('.editable-grid tbody tr', { hasText: fromName })
  const toRow = page.locator('.editable-grid tbody tr', { hasText: toName })
  await fromRow.hover()
  const fb = await fromRow.getByRole('button', { name: `Reorder ${fromName}` }).boundingBox()
  await toRow.hover()
  const tb = await toRow.getByRole('button', { name: `Reorder ${toName}` }).boundingBox()
  if (!fb || !tb) throw new Error('drag handle not laid out')
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
  await page.mouse.down()
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2 - 6, { steps: 4 })
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 12 })
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2 - 2, { steps: 4 })
  await page.mouse.up()
}

test('foundation: enter five value propositions, re-rank by drag, persist across reload', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  const phantomProject = page.getByPlaceholder(/Name your first project|New project/)
  await phantomProject.fill('Tavalo')
  await phantomProject.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()

  // Opening a project lands on Foundation (default tier).
  await expect(page.getByText('1st Tier · Foundation')).toBeVisible()

  // Purpose block: edit in place, autosaved.
  await page.getByText('What is this system for?').click()
  const purpose = page.getByLabel('System purpose')
  await purpose.fill('A better way to sit together.')
  await purpose.press('Enter')
  await expect(page.getByText('A better way to sit together.')).toBeVisible()

  // Enter the five value propositions through the phantom row.
  const phantomProp = page.getByPlaceholder('Name a value proposition')
  for (const name of PROPS) {
    await phantomProp.fill(name)
    await phantomProp.press('Enter')
    await expect(page.getByRole('cell', { name })).toBeVisible()
  }

  const dataRows = page.locator('.editable-grid tbody tr:not(.grid-row--phantom)')
  await expect(dataRows).toHaveCount(5)
  // Ranks render as degree notation, contiguous 1°..5° in entry order.
  await expect(dataRows.nth(0)).toContainText('1°')
  await expect(dataRows.nth(0)).toContainText('Seating-status comfort')
  await expect(dataRows.nth(3)).toContainText('4°')
  await expect(dataRows.nth(3)).toContainText('Spatial economy')

  // Drag #4 (Spatial economy) to the top.
  await dragHandleOnto(page, 'Spatial economy', 'Seating-status comfort')

  await expect(dataRows.nth(0)).toContainText('1°')
  await expect(dataRows.nth(0)).toContainText('Spatial economy')
  await expect(dataRows.nth(1)).toContainText('2°')
  await expect(dataRows.nth(1)).toContainText('Seating-status comfort')

  // Reload: order and ranks persist through the mutation layer.
  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('1st Tier · Foundation')).toBeVisible()
  const after = page.locator('.editable-grid tbody tr:not(.grid-row--phantom)')
  await expect(after.nth(0)).toContainText('1°')
  await expect(after.nth(0)).toContainText('Spatial economy')
  await expect(after.nth(4)).toContainText('5°')
  await expect(page.getByText('A better way to sit together.')).toBeVisible()
})
