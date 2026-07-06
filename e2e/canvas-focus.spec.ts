import { expect, test, type Page } from '@playwright/test'

// Issue 028(a) — canvas hover/focus adjacency emphasis (STYLE_GUIDE §7/§8,
// amended). Mirrors canvas.spec.ts / recursion.spec.ts's setup (three
// dimensions, one parameter each to start) and the paid-for compose gotcha:
// wait for each .canvas-spoke between dot clicks and for
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

// Composes a complete context (all three dimensions bound) directly on the
// canvas so both contexts share a parameter for the "who uses this" hover
// test. Waits for each spoke and the composer bar clearing, per the gotcha.
async function composeContext(page: Page) {
  await page.getByRole('button', { name: 'New context' }).click()
  await expect(page.locator('.canvas-node--draft')).toHaveCount(1)
  await expect(page.locator('.composer-bar[data-composing="true"]')).toBeVisible()

  const dots = page.locator('.canvas-dot-group')
  await expect(dots).toHaveCount(3)
  await dots.nth(0).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(1)
  await dots.nth(1).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(2)
  await dots.nth(2).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(3)
  await expect(page.locator('.canvas-node--draft')).toHaveCount(0)

  await page.keyboard.press('Escape') // exit compose, keep the draft
  await expect(page.locator('.composer-bar[data-composing="true"]')).toHaveCount(0)
}

test('hovering a parameter dot emphasizes the contexts bound to it and mutes an unrelated arc', async ({ page }) => {
  await setUpCanvas(page)
  await composeContext(page) // α — binds Comfort/Users/Engagement

  // A second context sharing the same Comfort binding as α, on a different
  // Users/Engagement pair — the "who else uses Comfort" read.
  await page.getByRole('button', { name: 'New context' }).click()
  await expect(page.locator('.composer-bar[data-composing="true"]')).toBeVisible()
  const dots = page.locator('.canvas-dot-group')
  await expect(dots).toHaveCount(3)
  // Comfort has only one parameter seeded so far, so dot 0 (Value's arc) is
  // shared with α; the other two dimensions have their own single parameter
  // too in this setup, so bind all three to complete the draft.
  await dots.nth(0).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(1)
  await dots.nth(1).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(2)
  await dots.nth(2).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(page.locator('.composer-bar[data-composing="true"]')).toHaveCount(0)

  // Clear selection (click-away) so we're testing hover-only emphasis, not a
  // locked selection's own view.
  await page.locator('.canvas-svg').click({ position: { x: 10, y: 10 } })
  await expect(page.locator('.canvas--muted')).toHaveCount(0)

  // Hover the Comfort dot (Value's single parameter) — both contexts bind it.
  // Hover the painted `.canvas-dot` itself: it's the topmost element at the dot
  // centre (the invisible ≥44px `.canvas-dot-hit` sibling sits under it, so
  // hovering the hit circle's centre is obstructed by the dot). Entering either
  // fires the group's onMouseEnter — a real pointer over the 44px ring works
  // the same way; this is just the actionable target for Playwright.
  const comfortDot = page.locator('.canvas-dot').first()
  await comfortDot.hover()

  // Both context nodes stay unmuted (both bind Comfort — the "who uses this"
  // read). The parameter role lights no arcs, so every arc mutes (3 of 3).
  await expect(page.locator('.canvas-node.canvas--muted')).toHaveCount(0)
  await expect(page.locator('.canvas-arc-group.canvas--muted')).toHaveCount(3)

  await page.mouse.move(10, 10) // move off the canvas entirely
  await expect(page.locator('.canvas--muted')).toHaveCount(0)
})

test('hovering a context node mutes the unrelated context and both arcs; leaving clears it', async ({ page }) => {
  await setUpCanvas(page)
  await composeContext(page) // α, fully bound

  // β — draft, unbound (nothing composed for it), so it's a distinct node
  // with no shared bindings to α.
  await page.getByRole('button', { name: 'New context' }).click()
  await expect(page.locator('.composer-bar[data-composing="true"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.composer-bar[data-composing="true"]')).toHaveCount(0)

  await page.locator('.canvas-svg').click({ position: { x: 10, y: 10 } }) // clear selection
  await expect(page.locator('.canvas--muted')).toHaveCount(0)

  const nodes = page.locator('.canvas-node[data-context-id]')
  await expect(nodes).toHaveCount(2)
  // α is the fully-bound (non-draft) node.
  const alpha = page.locator('.canvas-node[data-context-id]:not(.canvas-node--draft)')
  await alpha.hover()

  await expect(page.locator('.canvas-node.canvas--muted')).toHaveCount(1) // β mutes, α does not
  await expect(page.locator('.canvas-arc-group.canvas--muted')).toHaveCount(3) // context role lights no arcs
  await expect(page.locator('.canvas-dot-group.canvas--muted')).toHaveCount(0) // α binds all 3 seeded dots

  await page.mouse.move(10, 10)
  await expect(page.locator('.canvas--muted')).toHaveCount(0)
})

test('the resting canvas (no hover, no selection) never carries .canvas--muted', async ({ page }) => {
  await setUpCanvas(page)
  await composeContext(page)
  await page.locator('.canvas-svg').click({ position: { x: 10, y: 10 } }) // clear selection
  await expect(page.locator('.canvas--muted')).toHaveCount(0)
})

test('existing canvas/selection/compose behaviour is unaffected: selecting still shows spokes and the accent ring', async ({
  page,
}) => {
  await setUpCanvas(page)
  await composeContext(page)

  await page.locator('.canvas-node[data-context-id]').first().click()
  await expect(page.locator('.canvas-node[aria-pressed="true"]')).toHaveCount(1)
  await expect(page.locator('.canvas-spoke')).toHaveCount(3)
  await expect(page.locator('.composer-bar')).toBeVisible()
})
