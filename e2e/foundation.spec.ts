import { readFileSync } from 'node:fs'
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

// Issue 081 test-first plan item 10 — the Existing Scenario rich-text field:
// enter a mix of bold/italic/underline/a bulleted list/indent, reload
// persists; export/import round-trips the same formatting into a fresh
// project.
test('existing scenario: enter formatted prose, reload persists, export/import round-trips it', async ({
  page,
  browser,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  const phantomProject = page.getByPlaceholder(/Name your first project|New project/)
  await phantomProject.fill('Tavalo')
  await phantomProject.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await expect(page.getByText('1st Tier · Foundation')).toBeVisible()

  const scenario = page.getByLabel('Existing scenario')
  await scenario.click()

  // Bold + italic + underline on a typed word each, exercised via the
  // toolbar (Cmd/Ctrl+B/I/U also ship — src/components/ui/rich-text-editor.tsx —
  // but the toolbar is the primary, always-visible affordance per the design
  // brief).
  await page.keyboard.type('Today the ')
  await page.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type('booking')
  await page.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type(' desk is ')
  await page.getByRole('button', { name: 'Italic' }).click()
  await page.keyboard.type('entirely')
  await page.getByRole('button', { name: 'Italic' }).click()
  await page.keyboard.type(' ')
  await page.getByRole('button', { name: 'Underline' }).click()
  await page.keyboard.type('manual')
  await page.getByRole('button', { name: 'Underline' }).click()
  await page.keyboard.type('.')
  await page.keyboard.press('Enter')

  // A bulleted list with one indented sub-item.
  await page.getByRole('button', { name: 'Bulleted list' }).click()
  await page.keyboard.type('Phone calls only')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Indent' }).click()
  await page.keyboard.type('No confirmation email')

  await expect(scenario.locator('strong', { hasText: 'booking' })).toBeVisible()
  await expect(scenario.locator('em', { hasText: 'entirely' })).toBeVisible()
  await expect(scenario.locator('u', { hasText: 'manual' })).toBeVisible()
  await expect(scenario.locator('ul li', { hasText: 'Phone calls only' })).toBeVisible()
  await expect(scenario.locator('ul li', { hasText: 'No confirmation email' })).toBeVisible()

  // Commit on blur — click elsewhere on the page to leave the editor.
  await page.getByText('1st Tier · Foundation').click()

  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const reloaded = page.getByLabel('Existing scenario')
  await expect(reloaded.locator('strong', { hasText: 'booking' })).toBeVisible()
  await expect(reloaded.locator('em', { hasText: 'entirely' })).toBeVisible()
  await expect(reloaded.locator('u', { hasText: 'manual' })).toBeVisible()
  await expect(reloaded.locator('ul li', { hasText: 'Phone calls only' })).toBeVisible()
  await expect(reloaded.locator('ul li', { hasText: 'No confirmation email' })).toBeVisible()

  // Export -> import into a fresh project: the same formatting round-trips
  // through the envelope (FORMAT_VERSION 4, projectEnvelope.ts).
  await page.getByRole('button', { name: 'Project menu' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export project…' }).click(),
  ])
  const filePath = await download.path()
  const buffer = readFileSync(filePath)

  const cleanContext = await browser.newContext()
  const cleanPage = await cleanContext.newPage()
  await cleanPage.goto('/')
  await expect(cleanPage.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await cleanPage.locator('input[type="file"]').setInputFiles({
    name: 'Tavalo.gede.json',
    mimeType: 'application/json',
    buffer,
  })
  await expect(cleanPage.getByRole('button', { name: 'Open Tavalo' })).toBeVisible()
  await cleanPage.getByRole('button', { name: 'Open Tavalo' }).click()

  const imported = cleanPage.getByLabel('Existing scenario')
  await expect(imported.locator('strong', { hasText: 'booking' })).toBeVisible()
  await expect(imported.locator('em', { hasText: 'entirely' })).toBeVisible()
  await expect(imported.locator('u', { hasText: 'manual' })).toBeVisible()
  await expect(imported.locator('ul li', { hasText: 'Phone calls only' })).toBeVisible()
  await expect(imported.locator('ul li', { hasText: 'No confirmation email' })).toBeVisible()

  await cleanContext.close()
})
