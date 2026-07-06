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
    await page.getByRole('button', { name: 'Add dimension' }).click()
    await page.locator('.dim-row input').first().waitFor()
    await page.keyboard.press('Escape')
  }
  await addWithDefaultName()
  await addWithDefaultName()
  await expect(page.getByText('Add at least two dimensions to begin designing.')).toBeHidden()

  await page.getByRole('button', { name: 'Dimensions' }).click()
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
  await page.getByRole('button', { name: 'Dimensions' }).click() // close popover
}

test('at >=640px the register keeps a real min-width beside the canvas; below 640px they stack', async ({
  page,
}) => {
  await setUpTwoDimensionCanvas(page)

  // Wide: side by side, register with a real (not collapsed) width.
  await page.setViewportSize({ width: 1400, height: 900 })
  const canvasBox = await requireBox(page.locator('.canvas-shell'))
  const registerBox = await requireBox(page.locator('.context-register-shell'))
  // Side by side: register starts to the right of where the canvas ends.
  expect(registerBox.x).toBeGreaterThanOrEqual(canvasBox.x + canvasBox.width - 1)
  // A real floor, not a short floating strip (design brief: "sensible
  // min-width") — comfortably above the 320px CSS floor with viewport slack.
  expect(registerBox.width).toBeGreaterThanOrEqual(300)
  // The two panes read as balanced, not "canvas fills the space, register is
  // an afterthought": the register's panel height is within the same order
  // of magnitude as the canvas's (align-items: stretch — issue 027).
  expect(registerBox.height).toBeGreaterThanOrEqual(canvasBox.height * 0.9)

  // Narrow: stacked — register now starts below the canvas, not beside it.
  await page.setViewportSize({ width: 500, height: 900 })
  const canvasBoxNarrow = await requireBox(page.locator('.canvas-shell'))
  const registerBoxNarrow = await requireBox(page.locator('.context-register-shell'))
  expect(registerBoxNarrow.y).toBeGreaterThanOrEqual(canvasBoxNarrow.y + canvasBoxNarrow.height - 1)
})

test('child canvas needing sub-parameters shows exactly one empty-state prompt, not the canvas prompt too', async ({
  page,
}) => {
  await setUpTwoDimensionCanvas(page)

  // Compose + complete α, then drill into its child canvas — a freshly
  // seeded child canvas has dimensions but no sub-parameters yet (design
  // brief's "child, no params" state).
  await page.getByRole('button', { name: 'New context' }).click()
  const dots = page.locator('.canvas-dot-group')
  await expect(dots).toHaveCount(2)
  await dots.nth(0).click()
  await dots.nth(1).click()
  await expect(page.locator('.canvas-node--draft')).toHaveCount(0)
  await page.keyboard.press('Escape') // exit compose

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
