import { expect, test, type Page } from '@playwright/test'

// 089-D3 P1 — the gate-(a) regression guard in the REAL app: the EditableGrid
// Numbers-grammar must survive inside a React Flow custom node at viewport scale
// ≠ 1. This mounts the dev-only canvas (`?d3rf`, App.tsx), which renders the REAL
// DesignSurface / ContextRegister inside one node positioned by P0's derived
// laneLayout, zooms the viewport away from 1:1, and drives the register's real
// grammar entirely from the keyboard: click-to-edit, Enter commits + moves down,
// Tab moves right, Esc reverts.
//
// The flag is OFF by default and dead in a production build — see
// design-layout.spec.ts (run without the flag) for the unregressed normal path.

// Read the React Flow viewport's current scale off its inline transform
// (`translate(x, y) scale(z)`), so the test can assert it is genuinely ≠ 1.
async function viewportScale(page: Page): Promise<number> {
  const style = (await page.locator('.react-flow__viewport').getAttribute('style')) ?? ''
  const match = /scale\(([\d.]+)\)/.exec(style)
  if (!match) throw new Error(`no scale in viewport transform: ${style}`)
  return Number.parseFloat(match[1] as string)
}

test('EditableGrid keyboard grammar survives inside a React Flow node at zoom ≠ 1', async ({
  page,
}) => {
  // Project → open it → jump to the Design route WITH the dev flag. The flag
  // isn't a route param, so it can't ride the "Design" tab click (serializeRoute
  // would drop it) — navigate the full URL directly.
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await expect(page).toHaveURL(/\/p\/[^/]+/)
  const projectId = /\/p\/([^/?#]+)/.exec(page.url())?.[1]
  expect(projectId).toBeTruthy()
  await page.goto(`/p/${projectId}/design?d3rf=1`)

  // The React Flow canvas + the Design lane node + the real register all mount.
  // P2 co-mounts three lane nodes, so `.wc-node` is no longer unique — scope to
  // the Design lane's modifier class.
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect(page.locator('.wc-node--design')).toBeVisible()
  const register = page.locator('.context-register-shell')
  await expect(register).toBeVisible({ timeout: 15_000 })

  // Zoom the viewport to scale ≠ 1. Fit-view frames the whole (tall) node into
  // the pane at a fit zoom well below 1:1, so every register cell is on-screen
  // AND the grammar below runs at a non-unity scale — the gate.
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.locator('.react-flow__controls-fitview').click()
  await expect.poll(() => viewportScale(page)).not.toBe(1)
  const scale = await viewportScale(page)
  expect(scale).not.toBe(1)

  // Two real contexts via the register's phantom row — typing + Enter in a node
  // at scale ≠ 1 (phantom-create is part of the grammar the spike proved).
  const phantom = register.getByPlaceholder(/Type to create your first context — it becomes α|New context/)
  await phantom.click()
  await page.keyboard.type('first justification')
  await page.keyboard.press('Enter')
  await expect(register.getByText('α', { exact: true })).toBeVisible()
  await register.getByPlaceholder('New context').click()
  await page.keyboard.type('second justification')
  await page.keyboard.press('Enter')
  await expect(register.getByText('β', { exact: true })).toBeVisible()

  // The two data rows in sort order: α (nth 0), β (nth 1). The Symbol column is
  // the register's one plain `mono` cell — the grammar target.
  const dataRows = register.locator('tbody tr[data-row-id]')
  await expect(dataRows).toHaveCount(2)
  const alphaSymbol = dataRows.nth(0).locator('.grid-cell--mono')
  const betaSymbol = dataRows.nth(1).locator('.grid-cell--mono')

  // Esc reverts — click β's symbol to edit, type a throwaway value, Esc: the
  // committed value is unchanged (still β), the edit is abandoned.
  await betaSymbol.click()
  const betaInput = dataRows.nth(1).locator('.grid-cell__input--mono')
  await expect(betaInput).toBeFocused()
  await page.keyboard.type('ZZ')
  await page.keyboard.press('Escape')
  await expect(register.getByText('β', { exact: true })).toBeVisible()
  await expect(register.getByText('ZZ')).toHaveCount(0)

  // Enter commits + moves DOWN — edit α's symbol, commit a new value with Enter;
  // it persists AND editing advances to the row below (β's symbol cell).
  await alphaSymbol.click()
  await expect(dataRows.nth(0).locator('.grid-cell__input--mono')).toBeFocused()
  await page.keyboard.type('Omega')
  await page.keyboard.press('Enter')
  await expect(dataRows.nth(0).locator('.grid-cell--mono')).toHaveText('Omega')
  await expect(dataRows.nth(1).locator('.grid-cell__input--mono')).toBeFocused()

  // Tab moves RIGHT — from β's now-editing symbol cell, Tab commits (β unchanged)
  // and advances to the next editable cell, leaving the symbol column: no symbol
  // input remains open.
  await page.keyboard.press('Tab')
  await expect(register.locator('.grid-cell__input--mono')).toHaveCount(0)
  await expect(register.getByText('β', { exact: true })).toBeVisible()
})

// ── 089-D3 P2 — three lanes on one canvas ──────────────────────────────────
// P2 adds the Foundation + Architecture adapter nodes beside the P1 Design node,
// so all three real tier surfaces render side-by-side as React Flow nodes. These
// tests guard the P2 gates in the REAL app: (a) all three lanes mount; (b) the
// Architecture promote popover (Radix, body-portalled) anchors at its trigger at
// viewport scale ≠ 1 (the spike's gate-c, now in-app); (c) the D2 `activeLane`
// slice keeps Design's `c` verb scoped to the focused lane.

// Create the example project and open the dev-only canvas at the Design route
// (the `?d3rf` flag can't ride a tab click — navigate the full URL directly, as
// in the P1 test). Returns once the canvas + the three lane nodes are mounted.
async function openThreeLaneCanvas(page: Page): Promise<string> {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await expect(page).toHaveURL(/\/p\/[^/]+/)
  const projectId = /\/p\/([^/?#]+)/.exec(page.url())?.[1]
  expect(projectId).toBeTruthy()
  await page.goto(`/p/${projectId}/design?d3rf=1`)

  await expect(page.locator('.react-flow')).toBeVisible()
  await expect(page.locator('.wc-node')).toHaveCount(3)
  return projectId as string
}

test('all three tier lanes mount as React Flow nodes, in tier column order', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 })
  await openThreeLaneCanvas(page)

  // Each REAL surface mounts inside its lane node: Foundation + Architecture
  // headings, and the Design surface's own main region.
  await expect(page.getByRole('heading', { name: /1st Tier/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /2nd Tier/ })).toBeVisible()
  await expect(page.locator('.wc-node--design .design-main')).toBeVisible({ timeout: 15_000 })

  // Derived layout (LANE_ORDER): foundation left of architecture left of design.
  const f = await page.locator('.wc-node--foundation').boundingBox()
  const a = await page.locator('.wc-node--architecture').boundingBox()
  const d = await page.locator('.wc-node--design').boundingBox()
  if (!f || !a || !d) throw new Error('all three lane nodes must have a bounding box')
  expect(f.x).toBeLessThan(a.x)
  expect(a.x).toBeLessThan(d.x)
})

test('the Architecture promote popover anchors at its trigger at viewport scale ≠ 1', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1400 })
  await openThreeLaneCanvas(page)

  const arch = page.locator('.wc-node--architecture')
  await expect(arch).toBeVisible()

  // The app fit-views all three lanes on load, so the viewport is below 1:1 —
  // the gate-c condition (popovers under a transformed plane).
  await expect.poll(() => viewportScale(page)).not.toBe(1)
  const scale = await viewportScale(page)
  expect(scale).not.toBe(1)

  // Build one promotable entry entirely inside the Architecture lane node.
  const tablePhantom = arch.getByPlaceholder('Name a table')
  await tablePhantom.click()
  await page.keyboard.type('Stakeholders')
  await page.keyboard.press('Enter')
  await expect(arch.locator('.t2-table__name', { hasText: 'Stakeholders' })).toBeVisible()

  const entryPhantom = arch.getByPlaceholder('Name an entry')
  await entryPhantom.click()
  await page.keyboard.type('Buyers')
  await page.keyboard.press('Enter')
  await expect(arch.getByRole('cell', { name: 'Buyers', exact: true })).toBeVisible()

  await arch.getByRole('button', { name: 'Select Buyers' }).click()
  const trigger = arch.getByRole('button', { name: 'Use as dimension…' })
  await trigger.click()

  // The Radix promote popover is body-portalled (unscaled) and must anchor at
  // its trigger's on-screen rect — NOT off in a corner — even though the trigger
  // lives inside a scaled node (align="start", sideOffset=4).
  const popover = page.locator('.t2-promote')
  await expect(popover).toBeVisible()
  const tBox = await trigger.boundingBox()
  const pBox = await popover.boundingBox()
  if (!tBox || !pBox) throw new Error('trigger and popover must have bounding boxes')
  // Left edges aligned (align="start").
  expect(Math.abs(pBox.x - tBox.x)).toBeLessThan(40)
  // Adjacent vertically — just below the trigger, or flipped just above it.
  const gapBelow = Math.abs(pBox.y - (tBox.y + tBox.height))
  const gapAbove = Math.abs(pBox.y + pBox.height - tBox.y)
  expect(Math.min(gapBelow, gapAbove)).toBeLessThan(40)
})

test('activeLane gates the Design `c` verb per focused lane node', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 })
  await openThreeLaneCanvas(page)

  const design = page.locator('.wc-node--design')
  await expect(design.locator('.design-main')).toBeVisible({ timeout: 15_000 })

  // Give Design two dimensions so a compose draft renders as a canvas draft node.
  const dimPhantom = design.getByPlaceholder('Type to add a dimension')
  await dimPhantom.click()
  await page.keyboard.type('Value')
  await page.keyboard.press('Enter')
  await dimPhantom.click()
  await page.keyboard.type('Stake')
  await page.keyboard.press('Enter')
  await expect(design.locator('.dim-row')).toHaveCount(2)

  await expect(page.locator('.canvas-node--draft')).toHaveCount(0)

  // Foundation lane active — press `c`. The Design-scoped verb must NOT fire, so
  // no compose draft appears (the spike's "c from Foundation → no Design draft").
  await page.getByRole('heading', { name: /1st Tier/ }).click()
  await page.keyboard.press('c')
  await expect(page.locator('.canvas-node--draft')).toHaveCount(0)

  // Design lane active — press `c`. The verb fires; a draft is composed and
  // renders on the canvas.
  await design.locator('.coverage-stat').click()
  await page.keyboard.press('c')
  await expect(page.locator('.canvas-node--draft')).toHaveCount(1)
})
