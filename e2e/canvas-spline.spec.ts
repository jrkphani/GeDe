import { expect, test, type Page } from '@playwright/test'

// Issue 039 (028 phase b) — canvas spoke bundling. Structural assertions on
// the rendered SVG (this repo has no visual-snapshot/toHaveScreenshot infra
// yet — see canvas.spec.ts's own header comment: Linux-CI vs. local-macOS
// font/OS rendering makes pixel baselines a flakiness risk) plus a plain
// page.screenshot() dump for the HANDOFF gotcha ("geometry needs a real
// screenshot, not just component data") — manual review, not a CI gate.
// Mirrors canvas-focus.spec.ts's setup and its paid-for compose gotcha: wait
// for each .canvas-spoke between dot clicks and for
// .composer-bar[data-composing="true"] to clear before treating a draft as
// finished (HANDOFF Gotchas).
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

  async function addParametersTo(dimensionName: string, paramNames: string[]) {
    const section = page.locator('.dim-section', {
      has: page.locator('.dim-row__name', { hasText: dimensionName }),
    })
    const paramPhantom = section.getByPlaceholder('Type to add a parameter')
    for (const paramName of paramNames) {
      await paramPhantom.fill(paramName)
      await paramPhantom.press('Enter')
      await expect(section.getByText(paramName, { exact: true })).toBeVisible()
    }
  }
  // Three parameters per dimension (up from canvas.spec.ts's one) — enough
  // bound contexts sharing a dimension produces a genuinely dense fan-in.
  await addParametersTo('Value', ['Comfort', 'Cost', 'Speed'])
  await addParametersTo('Stake', ['Users', 'Admins', 'Guests'])
  await addParametersTo('Process', ['Engagement', 'Retention', 'Growth'])

  await page.getByRole('button', { name: 'Dimensions' }).click() // close the popover
}

// Composes one context via the draft dot-click flow, cycling through a fixed
// set of dots per dimension so different contexts land on different
// parameters (dot index 0/1/2 within each dimension's 3 dots) — this is what
// produces the "many contexts, many bindings" density the issue describes,
// rather than every context binding the exact same tuple.
async function composeContext(page: Page, dotIndexes: [number, number, number]) {
  await page.getByRole('button', { name: 'New context' }).click()
  await expect(page.locator('.canvas-node--draft')).toHaveCount(1)
  await expect(page.locator('.composer-bar[data-composing="true"]')).toBeVisible()

  for (const dotIndex of dotIndexes) {
    const beforeCount = await page.locator('.canvas-spoke').count()
    // Compose mode advances the active dimension automatically after each
    // bind, so re-query which dimension is active this iteration and scope
    // the dot lookup to it (each dimension's arc has 3 dots seeded above).
    const activeDimId = await page.locator('.canvas-arc-group[data-active="true"]').getAttribute('data-dimension-id')
    const dimDots = page.locator(`.canvas-dot-group[data-dimension-id="${activeDimId}"]`)
    await dimDots.nth(dotIndex).click()
    await expect(page.locator('.canvas-spoke')).toHaveCount(beforeCount + 1)
  }
  await expect(page.locator('.canvas-node--draft')).toHaveCount(0)
  await page.keyboard.press('Escape') // exit compose, keep the draft
  await expect(page.locator('.composer-bar[data-composing="true"]')).toHaveCount(0)
}

test('a dense canvas (many contexts x many bindings) renders legible bundled spline spokes, not a straight-line knot', async ({
  page,
}) => {
  await setUpCanvas(page)

  // Six contexts spread across the 3x3x3 parameter grid — enough to make a
  // hovered dimension's fan-in genuinely dense (issue 039 motivation).
  const tuples: [number, number, number][] = [
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 2],
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
  ]
  for (const tuple of tuples) {
    await composeContext(page, tuple)
  }
  await expect(page.locator('.canvas-node')).toHaveCount(tuples.length)

  // Hover the Value arc: every context binds a Value parameter (issue 028a),
  // so all six contexts' bound-dimension spokes render at once — 6 contexts
  // x 3 bound dimensions each = 18 spokes converging through the interior,
  // the exact "dense" scenario the issue's motivation describes.
  const valueArc = page.locator('.canvas-arc-group[data-dimension-id]').first()
  await valueArc.hover()

  const spokes = page.locator('.canvas-spoke')
  await expect(spokes).toHaveCount(tuples.length * 3)

  // Every spoke is a bundled curve (a Q/C command in its `d`), not a straight
  // chord — the structural half of "legible bundled splines, not a knot".
  const dAttrs = await spokes.evaluateAll((els) => els.map((el) => el.getAttribute('d') ?? ''))
  for (const d of dAttrs) {
    expect(d.length).toBeGreaterThan(0)
    expect(d).toMatch(/[QC]/)
  }

  // Manual-review artifact (HANDOFF gotcha: geometry needs a real screenshot,
  // not just component data) — not asserted against, this repo has no visual
  // baseline infra (see this file's header comment).
  await page.locator('.canvas-shell').screenshot({ path: 'test-results/canvas-spline-dense.png' })
})
