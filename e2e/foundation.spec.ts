import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { forceWorkspaceSurface } from './workspaceSurface'

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
  // 089-P7: re-ranks value props via in-grid `Reorder …` drag handles on the
  // stacked Foundation `.editable-grid` (rank shown as `1°…5°`) — the
  // WorkspaceSurface tier surface. The canvas decomposes Foundation into per-prop
  // RF nodes reordered by dragging the node handle (covered by d3-canvas.spec.ts).
  // Pin to the fallback surface.
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  const phantomProject = page.getByPlaceholder(/Name your first project|New project/)
  await phantomProject.fill('Tavalo')
  await phantomProject.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()

  // Opening a project lands on Foundation (default tier).
  await expect(page.getByText('1st Tier · Foundation')).toBeVisible()

  // Purpose block: a rich-text editor now (issue 089 D1 Phase 5, like the
  // sibling Existing Scenario). Type into the contentEditable and commit on
  // blur (Enter is a newline in a rich editor, never a commit) — clicking the
  // header leaves the editor and fires the blur-commit.
  const purpose = page.getByRole('textbox', { name: 'System purpose' })
  await purpose.click()
  await page.keyboard.type('A better way to sit together.')
  await expect(purpose).toContainText('A better way to sit together.')
  await page.getByText('1st Tier · Foundation').click()
  // Fast local IndexedDB commit; a short wait lets the blur-commit land before
  // the reload later (mirrors the Existing Scenario test's own note below).
  await page.waitForTimeout(500)
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
  // Pin to WorkspaceSurface (like the sibling test above): this exercises the
  // in-grid Foundation prose/RankCell + export-import round-trip on the fallback
  // surface; the canvas Foundation grammar is covered in d3-canvas.spec.ts.
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  const phantomProject = page.getByPlaceholder(/Name your first project|New project/)
  await phantomProject.fill('Tavalo')
  await phantomProject.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await expect(page.getByText('1st Tier · Foundation')).toBeVisible()

  const scenario = page.getByRole('textbox', { name: 'Existing scenario' })
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
  await expect(
    scenario.locator('.rich-text-editor__text--underline', { hasText: 'manual' }),
  ).toBeVisible()
  await expect(scenario.locator('ul li', { hasText: 'Phone calls only' })).toBeVisible()
  await expect(
    // Indenting wraps the sibling <li> in an outer, non-text-bearing
    // "nested" <li> that contains the sub-<ul> (see
    // src/components/ui/rich-text-editor.tsx theme.list.nested.listitem) —
    // exclude it so this resolves to the single leaf <li> that actually
    // carries the text, not both.
    scenario.locator('ul li:not(.rich-text-editor__list-item--nested)', {
      hasText: 'No confirmation email',
    }),
  ).toBeVisible()

  // Commit on blur — click elsewhere on the page to leave the editor.
  await page.getByText('1st Tier · Foundation').click()

  // handleBlur's onCommit (rich-text-editor.tsx) is fire-and-forget from the
  // caller's side — setExistingScenario awaits its own DB write internally,
  // but nothing here awaits *that* promise, and (unlike e.g. dimension
  // recolor) the visible content isn't re-driven by the store's post-write
  // state, since the contenteditable already shows what was typed locally.
  // So there's no DOM signal to key a wait off of before it's safe to
  // reload — the write is a fast local IndexedDB commit, so a short,
  // generous wait (mirrors e2e/canvas-spline.spec.ts's own
  // waitForTimeout for a similar no-better-signal case) is enough for it to
  // land before we reload.
  // The commit-on-blur write to local PGlite is fire-and-forget with no DOM
  // signal to await. If we reload before it lands the write is LOST (not merely
  // late) — a re-reload can never recover it — so a too-short fixed wait flaked
  // in CI under load. Give the local write ample, CI-safe headroom before
  // reloading. (A magic wait, but there is genuinely no completion signal for
  // this field; the local IndexedDB write is fast, so generous slack is safe.)
  await page.waitForTimeout(3_000)

  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const reloaded = page.getByRole('textbox', { name: 'Existing scenario' })
  await expect(reloaded.locator('strong', { hasText: 'booking' })).toBeVisible({ timeout: 15_000 })
  await expect(reloaded.locator('em', { hasText: 'entirely' })).toBeVisible()
  await expect(
    reloaded.locator('.rich-text-editor__text--underline', { hasText: 'manual' }),
  ).toBeVisible()
  await expect(reloaded.locator('ul li', { hasText: 'Phone calls only' })).toBeVisible()
  await expect(
    reloaded.locator('ul li:not(.rich-text-editor__list-item--nested)', {
      hasText: 'No confirmation email',
    }),
  ).toBeVisible()

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

  const imported = cleanPage.getByRole('textbox', { name: 'Existing scenario' })
  await expect(imported.locator('strong', { hasText: 'booking' })).toBeVisible()
  await expect(imported.locator('em', { hasText: 'entirely' })).toBeVisible()
  await expect(
    imported.locator('.rich-text-editor__text--underline', { hasText: 'manual' }),
  ).toBeVisible()
  await expect(imported.locator('ul li', { hasText: 'Phone calls only' })).toBeVisible()
  await expect(
    imported.locator('ul li:not(.rich-text-editor__list-item--nested)', {
      hasText: 'No confirmation email',
    }),
  ).toBeVisible()

  await cleanContext.close()
})
