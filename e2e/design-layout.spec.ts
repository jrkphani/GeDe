import { expect, test, type Locator, type Page } from '@playwright/test'

// Narrows Playwright's nullable boundingBox() return without a non-null
// assertion (forbidden repo-wide — @typescript-eslint/no-non-null-assertion).
async function requireBox(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('boundingBox() returned null — element not found or not visible')
  return box
}

// Issue 027 — design tier layout cleanup + navigation clarity. Structural/
// geometry assertions the vitest component suite can't make (jsdom doesn't
// lay out real pixels — HANDOFF gotcha) alongside the real-browser CSS
// cascade the empty-state suppression rule depends on (Canvas.tsx itself is
// untouched; the "never both" behavior lives in base.css, which only a real
// browser fully applies).
async function setUpTwoDimensionCanvas(page: Page) {
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
  await addParameterTo('Stake', 'Users')
}

// Issue 085 Phase C — the canvas moves OUT from between the rail and the
// register to a side visual panel; the rail + register now share one
// bordered editing zone. Rewritten from the pre-085 "register beside the
// canvas" geometry (the canvas used to be the middle column) to the new
// "canvas beside the editing zone" geometry.
test('at >=640px the canvas sits beside the editing zone (not between rail and register); below 640px they stack', async ({
  page,
}) => {
  await setUpTwoDimensionCanvas(page)

  // Wide: editing zone (rail + register) and the canvas are side by side,
  // canvas last — never sandwiched between the two editing surfaces.
  await page.setViewportSize({ width: 1400, height: 900 })
  const zoneBox = await requireBox(page.locator('.editing-zone'))
  const canvasBox = await requireBox(page.locator('.canvas-shell'))
  const registerBox = await requireBox(page.locator('.context-register-shell'))
  expect(canvasBox.x).toBeGreaterThanOrEqual(zoneBox.x + zoneBox.width - 1)
  expect(canvasBox.x).toBeGreaterThanOrEqual(registerBox.x + registerBox.width - 1)
  // The register keeps a real (not collapsed) min-width inside the zone
  // (design brief: "sensible min-width") — comfortably above the 320px CSS
  // floor with viewport slack.
  expect(registerBox.width).toBeGreaterThanOrEqual(300)
  // The editing zone and the canvas read as balanced (align-items: stretch,
  // issue 027), and the canvas keeps its min-height floor even as a
  // narrower side column (design brief: "legible without being the hero").
  expect(zoneBox.height).toBeGreaterThanOrEqual(canvasBox.height * 0.9)
  expect(canvasBox.height).toBeGreaterThanOrEqual(300)

  // Narrow: stacked — the editing zone stacks first (rail -> register), the
  // canvas moves below the whole zone, not beside it.
  await page.setViewportSize({ width: 500, height: 900 })
  const zoneBoxNarrow = await requireBox(page.locator('.editing-zone'))
  const canvasBoxNarrow = await requireBox(page.locator('.canvas-shell'))
  const railBoxNarrow = await requireBox(page.locator('.dim-rail'))
  const registerBoxNarrow = await requireBox(page.locator('.context-register-shell'))
  expect(canvasBoxNarrow.y).toBeGreaterThanOrEqual(zoneBoxNarrow.y + zoneBoxNarrow.height - 1)
  expect(registerBoxNarrow.y).toBeGreaterThanOrEqual(railBoxNarrow.y + railBoxNarrow.height - 1)
})

// Issue 085 Phase C, test-first plan item 11 — the whole point of one
// editing zone with a continuous tab order: pour in dimensions + their
// parameters, then tab straight into defining contexts, without the mouse
// ever crossing to the canvas. The canvas stays a side visual the whole time.
test('dimensions, parameters, and contexts can all be defined by keyboard alone — Tab bridges rail -> register without ever touching the canvas', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await page.getByRole('link', { name: 'Design' }).click()

  // Two dimensions with a parameter each — via the working type+Enter phantom
  // grammar (082 Phase 1). NB: the richer "Tab on a content-filled phantom
  // creates it and continues straight into the parameter phantom" chain is an
  // 082 Phase 1 keyboard follow-up, out of 085 Phase C scope. Phase C's
  // deliverable is the rail -> register BRIDGE below — that is what removes the
  // mouse trip across the canvas (085's core complaint).
  const dimPhantom = page.getByPlaceholder('Type to add a dimension')
  await dimPhantom.fill('Value')
  await dimPhantom.press('Enter') // creates Value, refocuses the dimension phantom
  await dimPhantom.fill('Stake')
  await dimPhantom.press('Enter') // creates Stake
  await expect(page.locator('.dim-row')).toHaveCount(2)

  // One parameter per dimension, by keyboard, via each dimension's own param
  // phantom (indexed, no dependence on the dimension's rendered name). Param
  // names render in both the rail (param row) and the canvas (dot label), so
  // scope the assertions to the rail.
  const firstParam = page.getByPlaceholder('Type to add a parameter').first()
  await firstParam.fill('Comfort')
  await firstParam.press('Enter')
  await expect(page.locator('.dim-rail').getByText('Comfort', { exact: true })).toBeVisible()
  const secondParam = page.getByPlaceholder('Type to add a parameter').nth(1)
  await secondParam.fill('Users')
  await secondParam.press('Enter')
  await expect(page.locator('.dim-rail').getByText('Users', { exact: true })).toBeVisible()

  // Bridge (issue 085 Phase C): focus the rail's LAST phantom — the empty
  // dimension-add phantom — and press Tab. It must land in the register's
  // "new context" phantom row, NOT the canvas (which now sits OUTSIDE the
  // editing zone, as the last child of the row). This is the mouse-free
  // rail -> register hop that Phase C adds; without it, native focus order
  // would land on the canvas that used to sit between the two surfaces.
  await dimPhantom.focus()
  await expect(dimPhantom).toHaveValue('')
  await page.keyboard.press('Tab')
  const registerPhantom = page.getByPlaceholder(/Type to create your first context — it becomes α|New context/)
  await expect(registerPhantom).toBeFocused()

  // Define a context entirely by keyboard, still without touching the mouse.
  await page.keyboard.type('Because reasons')
  await page.keyboard.press('Enter')
  // α renders in both the register (symbol cell) and the canvas (context node);
  // scope to the register so the assertion is unambiguous.
  await expect(page.locator('.context-register-shell').getByText('α', { exact: true })).toBeVisible()

  // The canvas never received focus or a click during this flow, and it
  // sits beside the editing zone, never between the rail and the register.
  const zoneBox = await requireBox(page.locator('.editing-zone'))
  const canvasBox = await requireBox(page.locator('.canvas-shell'))
  expect(canvasBox.x).toBeGreaterThanOrEqual(zoneBox.x + zoneBox.width - 1)

  // The ring renders — proportional arcs (Phase A): one arc + one dot per
  // dimension/parameter defined above.
  await expect(page.locator('.canvas-arc')).toHaveCount(2)
  await expect(page.locator('.canvas-dot')).toHaveCount(2)

  // Reload persists — a real store write, not just in-memory React state.
  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.context-register-shell').getByText('α', { exact: true })).toBeVisible()
  await expect(page.locator('.canvas-arc')).toHaveCount(2)
})

test('child canvas needing sub-parameters shows exactly one empty-state prompt, not the canvas prompt too', async ({
  page,
}) => {
  await setUpTwoDimensionCanvas(page)

  // Compose + complete α, then drill into its child canvas — a freshly
  // seeded child canvas has dimensions but no sub-parameters yet (design
  // brief's "child, no params" state).
  await page.getByRole('button', { name: 'New context' }).click()
  await expect(page.locator('.canvas-dot-group--compose').first()).toBeVisible()
  const dots = page.locator('.canvas-dot-group')
  await expect(dots).toHaveCount(2)
  // Wait for each spoke so the bind is committed before the next click (the
  // clicks are otherwise racy — proven flow mirrors recursion.spec).
  await dots.nth(0).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(1)
  await dots.nth(1).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(2)
  await expect(page.locator('.canvas-node--draft')).toHaveCount(0)
  await page.keyboard.press('Escape') // exit compose
  await expect(page.locator('.canvas-dot-group--compose')).toHaveCount(0)

  await page.locator('.children-drill').first().click()
  await expect(page.locator('.breadcrumb--current')).toHaveText('α')
  await expect(page.locator('.canvas-seed-hint')).toBeVisible()

  // Never both: Canvas's own built-in prompt is present in the DOM (SPEC
  // §4.2 — Canvas.tsx always renders it while there are no contexts) but
  // must not be visible while the seed-hint above is already saying it.
  await expect(page.locator('.canvas-empty-prompt')).toHaveCount(1)
  await expect(page.locator('.canvas-empty-prompt')).toBeHidden()
  // The lineage line was dropped outright (DesignSurface no longer passes
  // `lineage` to Canvas) — never enters the DOM at all.
  await expect(page.locator('.canvas-empty-lineage')).toHaveCount(0)
})

test('root canvas (no contexts yet, params present) shows Canvas\'s own prompt, unsuppressed, with no needs-parameters banner', async ({
  page,
}) => {
  await setUpTwoDimensionCanvas(page)

  await expect(page.locator('.canvas-seed-hint')).toHaveCount(0)
  await expect(page.locator('.canvas-empty-prompt')).toBeVisible()
  await expect(page.getByText('Bind your first context')).toBeVisible()
})
