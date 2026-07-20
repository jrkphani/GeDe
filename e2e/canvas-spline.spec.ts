import { expect, test, type Page } from '@playwright/test'
import { forceWorkspaceSurface } from './workspaceSurface'

// Issue 039 (028 phase b) — canvas spoke bundling. Structural assertions on
// the rendered SVG (this repo has no visual-snapshot/toHaveScreenshot infra
// yet — see canvas.spec.ts's own header comment: Linux-CI vs. local-macOS
// font/OS rendering makes pixel baselines a flakiness risk) plus a plain
// page.screenshot() dump for the HANDOFF gotcha ("geometry needs a real
// screenshot, not just component data") — manual review, not a CI gate.
// Mirrors canvas-focus.spec.ts's setup and its paid-for compose gotcha: wait
// for each .canvas-spoke between dot clicks and for
// .canvas-dot-group--compose (Canvas's own compose-mode marker, issue 010) to
// clear before treating a draft as finished (HANDOFF Gotchas). Issue 085
// Phase B retired the Composer strip and its `.composer-bar[data-composing]`
// gate — the canvas's own compose marker is the equivalent signal now.
async function setUpCanvas(page: Page) {
  // 089-P7: dense-spline geometry on the full-size DesignSurface ring, composing
  // via the `New context` button (WorkspaceSurface fallback). Pin to it.
  await forceWorkspaceSurface(page)
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
}

// Composes one context via the draft dot-click flow, cycling through a fixed
// set of dots per dimension so different contexts land on different
// parameters (dot index 0/1/2 within each dimension's 3 dots) — this is what
// produces the "many contexts, many bindings" density the issue describes,
// rather than every context binding the exact same tuple.
async function composeContext(page: Page, dotIndexes: [number, number, number]) {
  await page.getByRole('button', { name: 'New context' }).click()
  await expect(page.locator('.canvas-node--draft')).toHaveCount(1)
  await expect(page.locator('.canvas-dot-group--compose').first()).toBeVisible()

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
  await expect(page.locator('.canvas-dot-group--compose')).toHaveCount(0)
}

test('a dense canvas (many contexts x many bindings) renders legible bundled spline spokes, not a straight-line knot', async ({
  page,
}) => {
  await setUpCanvas(page)

  // Six distinct contexts that all share Value's first parameter (Comfort) but
  // differ in Stake/Process — so hovering the Comfort dot lights every one of
  // them, the dense fan-in the issue targets (issue 039 motivation).
  const tuples: [number, number, number][] = [
    [0, 0, 0],
    [0, 1, 1],
    [0, 2, 2],
    [0, 0, 1],
    [0, 1, 2],
    [0, 2, 0],
  ]
  for (const tuple of tuples) {
    await composeContext(page, tuple)
  }
  await expect(page.locator('.canvas-node')).toHaveCount(tuples.length)

  // Widen so labels are at the full tier (and the dense screenshot is legible).
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForTimeout(200)

  // Clear the selection (the last-composed context) so we see hover-only
  // emphasis, then hover the Comfort dot — Value's first parameter, which all
  // six contexts bind (issue 028a). Every one lights up: 6 contexts x 3 bound
  // dimensions = 18 spokes converging through the interior, the dense fan the
  // issue targets. The painted `.canvas-dot` is the reliable actionable target
  // (a ring-segment arc's bbox centre is empty interior, so it can't be hovered
  // directly).
  await page.locator('.canvas-svg').click({ position: { x: 10, y: 10 } })
  await page.locator('.canvas-dot').first().hover()

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
