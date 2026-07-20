import { expect, test, type Page } from '@playwright/test'
import { forceWorkspaceSurface } from './workspaceSurface'

// Issue 011 — reproduce the Numbers drill-down (SPEC §6 M3 done-when): a complete
// root context α opens as a child canvas whose dimensions are α's bound
// parameters; sub-parameters populate it; child contexts α1… live inside;
// breadcrumbs (and browser back) return to an unchanged root.
//
// Two dimensions (Value/Stake, one parameter each) keep the setup fast while
// still exercising the full recursion path.
async function setUpBoundAlpha(page: Page) {
  // 089-P7: this recursion model is breadcrumb-based drill-in (`.children-drill`
  // → `.breadcrumb--current`) and composes via the `New context` button — the
  // WorkspaceSurface DesignSurface flow. The canvas models recursion as
  // edge-connected satellites (covered by d3-canvas.spec.ts). Pin to the fallback.
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

  // Compose α on the canvas: bind both dots (waiting for each spoke so the
  // binding is deterministic), then exit compose keeping the complete draft.
  await page.getByRole('button', { name: 'New context' }).click()
  await expect(page.locator('.canvas-node--draft')).toHaveCount(1) // compose ready
  await expect(page.locator('.canvas-dot-group--compose').first()).toBeVisible()
  const dots = page.locator('.canvas-dot-group')
  await expect(dots).toHaveCount(2)
  await dots.nth(0).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(1)
  await dots.nth(1).click()
  await expect(page.locator('.canvas-spoke')).toHaveCount(2)
  await expect(page.locator('.canvas-node--draft')).toHaveCount(0) // α is complete
  await page.keyboard.press('Escape') // exit compose
  await expect(page.locator('.canvas-dot-group--compose')).toHaveCount(0)
}

test('drill into α, refine it, create children, and breadcrumb back to an unchanged root', async ({
  page,
}) => {
  await setUpBoundAlpha(page)

  // Drill into α via the register's "Open ▸" affordance. The URL gains a depth
  // segment and the breadcrumb trail reads Root ▸ α.
  await page.locator('.children-drill').first().click()
  await expect(page).toHaveURL(/\/design\/[^/]+$/)
  await expect(page.locator('.breadcrumb--current')).toHaveText('α')
  await expect(page.locator('.breadcrumbs')).toContainText('Root')

  // First-open seeding: the child canvas needs sub-parameters, so the dimension
  // manager opened on its own, showing the two seeded dimensions (Comfort, Users)
  // named after α's bound parameters.
  await expect(page.locator('.canvas-seed-hint')).toBeVisible()
  const usersSection = page.locator('.dim-section', {
    has: page.locator('.dim-row__name', { hasText: 'Users' }),
  })
  await expect(usersSection).toBeVisible()
  await expect(
    page.locator('.dim-section', { has: page.locator('.dim-row__name', { hasText: 'Comfort' }) }),
  ).toBeVisible()

  // Add sub-parameters under the Users child dimension (the recursion payload).
  async function addSubParam(name: string) {
    const phantom = usersSection.getByPlaceholder('Type to add a parameter')
    await phantom.fill(name)
    await phantom.press('Enter')
    await expect(usersSection.getByText(name, { exact: true })).toBeVisible()
  }
  await addSubParam('Inner Circle')
  await addSubParam('Outer Circle')

  // Create child contexts α1, α2 via the register phantom row.
  const registerPhantom = page.getByPlaceholder(/first context on this canvas|New context/)
  await registerPhantom.fill('Refines the inner circle')
  await registerPhantom.press('Enter')
  await expect(page.locator('.editable-grid tbody').getByText('α1', { exact: true })).toBeVisible()
  const registerPhantom2 = page.getByPlaceholder('New context')
  await registerPhantom2.fill('Refines the outer circle')
  await registerPhantom2.press('Enter')
  await expect(page.locator('.editable-grid tbody').getByText('α2', { exact: true })).toBeVisible()

  // Breadcrumb back to the root canvas via the Root crumb.
  await page.locator('.breadcrumb--link', { hasText: 'Root' }).click()
  await expect(page).toHaveURL(/\/design$/)
  await expect(page.locator('.breadcrumb--current')).toHaveText('Root')

  // Root is unchanged: α is still there, complete, and now shows a child badge.
  await expect(page.locator('.editable-grid tbody').getByText('α', { exact: true })).toBeVisible()
  await expect(page.locator('.canvas-node')).toHaveCount(1)
  await expect(page.locator('.canvas-node-badge')).toHaveText('2')
})

test('browser back mirrors breadcrumb navigation exactly', async ({ page }) => {
  await setUpBoundAlpha(page)

  await page.locator('.children-drill').first().click()
  await expect(page.locator('.breadcrumb--current')).toHaveText('α')
  const childUrl = page.url()

  // Browser back returns to root; forward returns to α's canvas.
  await page.goBack()
  await expect(page).toHaveURL(/\/design$/)
  await expect(page.locator('.breadcrumb--current')).toHaveText('Root')

  await page.goForward()
  await expect(page).toHaveURL(childUrl)
  await expect(page.locator('.breadcrumb--current')).toHaveText('α')
})
