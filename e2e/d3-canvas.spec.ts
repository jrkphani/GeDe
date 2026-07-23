import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

// ── DEPLOY-GATE CONTRACT (issue 096 → GRADUATED 089-P6) ──────────────────────
// These specs now RUN IN the deploy gate: `npm run e2e` = plain `playwright
// test` (no more `--grep-invert @dev-flag`), so `verify` executes them and a
// real canvas regression blocks a prod deploy again. They earned this by proving
// 22 consecutive green (21 local runs + CI) with zero flakes before the un-tag;
// the sole quarantined `test.fixme` (focus-pan) was converted to a pure unit
// test (src/components/workspaceFocusPan.test.ts), so nothing here is a known
// flaker. The non-gating visibility job (.github/workflows/dev-canvas-e2e.yml)
// is retired — redundant now that these gate directly.
//
// The `@dev-flag` tag is RETAINED on every test, but ONLY as a one-line ROLLBACK
// LEVER: if a canvas spec ever flakes and threatens to freeze the pipeline (the
// original 096 failure: ~8 blocked deploys), re-add `--grep-invert @dev-flag` to
// `package.json`'s `e2e` script to instantly re-exclude this whole file and
// unblock deploys — then fix the flake and drop the flag again. `npm run
// e2e:dev-flag` still runs ONLY these specs (targeted canvas runs / rollback
// verification). NOTE: React Flow is still kept OUT of the prod bundle by
// d3CanvasNav.guard.test.ts — the canvas ships to prod at 089-P7 (the flip).

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

// The React Flow viewport's full inline transform (`translate(x, y) scale(z)`),
// so a test can assert the viewport genuinely moved/zoomed after a pan.
async function viewportTransform(page: Page): Promise<string> {
  return (await page.locator('.react-flow__viewport').getAttribute('style')) ?? ''
}

// Block until the React Flow viewport transform is identical across two
// consecutive polls — i.e. all pending viewport moves have settled. WorkspaceCanvas
// fires a ONE-TIME initial `fitView` once every node is measured/initialized
// (guarded by `useNodesInitialized`), dispatched from a rAF whose timing is
// nondeterministic relative to a test's keystrokes. If a test drives a pan (⌘1/2/3
// or focus-pan) BEFORE that fit lands, the late fit re-frames all lanes and undoes
// the pan (issue 096's residual focus-pan flake). Waiting for a stable transform
// first guarantees the initial fit is done — after which the viewport never moves
// on its own — so subsequent pans are deterministic (reduced-motion makes them
// snap, so each settles within a poll tick).
async function waitForStableViewport(page: Page): Promise<void> {
  let prev = ''
  await expect
    .poll(async () => {
      const cur = await viewportTransform(page)
      const stable = cur !== '' && cur === prev
      prev = cur
      return stable
    })
    .toBe(true)
}

test('EditableGrid keyboard grammar survives inside a React Flow node at zoom ≠ 1', { tag: '@dev-flag' }, async ({
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
  await expect(page.locator('.wc-node--design-register')).toBeVisible()
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
  await expect(page.locator('.wc-node')).toHaveCount(4)
  return projectId as string
}

test('all three tier lanes mount as React Flow nodes, in tier column order', { tag: '@dev-flag' }, async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 })
  await openThreeLaneCanvas(page)

  // Each REAL surface mounts inside its lane node: Foundation + Architecture
  // headings, and the Design surface's own main region.
  await expect(page.getByRole('heading', { name: /1st Tier/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /2nd Tier/ })).toBeVisible()
  await expect(page.locator('.wc-node--design-register .context-register-shell')).toBeVisible({ timeout: 15_000 })

  // Derived layout (LANE_ORDER): foundation left of architecture left of design.
  const f = await page.locator('.wc-node--foundation').boundingBox()
  const a = await page.locator('.wc-node--architecture').boundingBox()
  const d = await page.locator('.wc-node--design-register').boundingBox()
  if (!f || !a || !d) throw new Error('all three lane nodes must have a bounding box')
  expect(f.x).toBeLessThan(a.x)
  expect(a.x).toBeLessThan(d.x)
})

// HARDENED (issue 096) — was CI-rendering-fragile: the Radix popover anchor at
// zoom ≠ 1 landed ~200px off under headless CI. Root cause: clicking the "Use as
// dimension…" trigger focuses it, which fires the canvas's focus-driven pan
// (onFocusCapture → setCenter). Under normal motion that pan ANIMATES for
// FOCUS_PAN_DURATION ms, moving the trigger out from under Radix's already-taken
// popover measurement → the popover anchors to the trigger's stale pre-pan rect.
// Fix: emulate `prefers-reduced-motion: reduce`, which the app honors
// (prefersReducedMotion in d3CanvasNav.ts) to snap every pan to `duration: 0`, so
// the viewport is settled before the popover measures; and assert the (zoom-
// invariant) anchor relationship via expect.poll so it converges as floating-ui
// finishes positioning. Un-quarantined per 096 — see the deploy-gate note in the
// issue: the ?d3rf D3 canvas is dev-flag-only and must never gate prod deploys.
test('the Architecture promote popover anchors at its trigger at viewport scale ≠ 1', { tag: '@dev-flag' }, async ({
  page,
}) => {
  // Reduced motion → the focus-pan setCenter + lane fitView snap to duration 0,
  // removing the animation window this test used to race against.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1920, height: 1400 })
  await openThreeLaneCanvas(page)

  // P3.2 — the Architecture lane is now the header node (add-table phantom) plus
  // one node per table. `.wc-node--architecture` is the header; a created table
  // is a `.wc-node--arch-table`.
  const arch = page.locator('.wc-node--architecture')
  await expect(arch).toBeVisible()

  // The app fit-views all three lanes on load, so the viewport is below 1:1 —
  // the gate-c condition (popovers under a transformed plane).
  await expect.poll(() => viewportScale(page)).not.toBe(1)
  const scale = await viewportScale(page)
  expect(scale).not.toBe(1)

  // Let the initial fit-view settle before interacting: adding a table mounts a
  // new node → re-measure, and clicking the trigger fires a focus-pan; a late fit
  // racing either would move the trigger under the popover's measurement.
  await waitForStableViewport(page)

  // Add a table via the header's add-table phantom; it mounts its own node.
  const tablePhantom = arch.getByPlaceholder('Name a table')
  await tablePhantom.click()
  await page.keyboard.type('Stakeholders')
  await page.keyboard.press('Enter')
  const table = page.locator('.wc-node--arch-table')
  await expect(table.locator('.t2-table__name', { hasText: 'Stakeholders' })).toBeVisible()

  // Build one promotable entry entirely inside the table node.
  const entryPhantom = table.getByPlaceholder('Name an entry')
  await entryPhantom.click()
  await page.keyboard.type('Buyers')
  await page.keyboard.press('Enter')
  await expect(table.getByRole('cell', { name: 'Buyers', exact: true })).toBeVisible()

  await table.getByRole('option', { name: 'Select Buyers' }).click()
  const trigger = table.getByRole('button', { name: 'Use as dimension…' })
  await trigger.click()

  // The Radix promote popover is body-portalled (unscaled) and must anchor at
  // its trigger's on-screen rect — NOT off in a corner — even though the trigger
  // lives inside a scaled node (align="start", sideOffset=4).
  const popover = page.locator('.t2-promote')
  await expect(popover).toBeVisible()

  // Poll the anchor geometry rather than snapshotting it once: floating-ui
  // positions the portalled popover after mount, and with reduced motion the
  // viewport is guaranteed steady, so these converge immediately (and can't be
  // caught mid-animation). Left edges aligned (align="start").
  await expect
    .poll(async () => {
      const tBox = await trigger.boundingBox()
      const pBox = await popover.boundingBox()
      if (!tBox || !pBox) return Number.POSITIVE_INFINITY
      return Math.abs(pBox.x - tBox.x)
    })
    .toBeLessThan(40)
  // Adjacent vertically — just below the trigger, or flipped just above it.
  await expect
    .poll(async () => {
      const tBox = await trigger.boundingBox()
      const pBox = await popover.boundingBox()
      if (!tBox || !pBox) return Number.POSITIVE_INFINITY
      const gapBelow = Math.abs(pBox.y - (tBox.y + tBox.height))
      const gapAbove = Math.abs(pBox.y + pBox.height - tBox.y)
      return Math.min(gapBelow, gapAbove)
    })
    .toBeLessThan(40)
})

test('activeLane gates the Design `c` verb per focused lane node', { tag: '@dev-flag' }, async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1100 })
  await openThreeLaneCanvas(page)

  const design = page.locator('.wc-node--design-register')
  await expect(design.locator('.context-register-shell')).toBeVisible({ timeout: 15_000 })

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

// ── 089-D3 (P4 nav layer) — ⌘1/2/3 pan-to-lane + focus-driven pan ───────────
// The spike-proven navigation, now in the real canvas: ⌘1/2/3 pans the viewport
// to a lane node instead of AppShell's route-navigate (which would rebuild the
// URL via serializeRoute and DROP the `?d3rf` param, exiting the canvas). The
// canvas intercepts the keypress on the CAPTURE phase and stops it reaching
// AppShell's global handler, so `?d3rf` survives.

test('⌘2 pans the viewport toward the Architecture lane and stays on the ?d3rf canvas', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 1000 })
  await openThreeLaneCanvas(page)
  // Wait until every lane surface has mounted and the initial fit-view settled.
  await expect(page.locator('.wc-node--design-register .context-register-shell')).toBeVisible({ timeout: 15_000 })

  const before = await viewportTransform(page)

  // Capture-phase interception must win over AppShell's window-capture ⌘1/2/3
  // handler: it PANS, it does not navigate().
  await page.keyboard.press('Meta+Digit2')

  // The viewport genuinely moved/zoomed toward the lane (RF animates the pan).
  await expect.poll(() => viewportTransform(page)).not.toBe(before)

  // Critically, we did NOT navigate away: AppShell's navigate() would have
  // rebuilt the URL (dropping ?d3rf, leaving the Design route) — instead the URL
  // is untouched, still the Design route, still carrying the dev flag.
  expect(page.url()).toContain('d3rf')
  expect(page.url()).toContain('/design')
  // The canvas is still mounted (a navigate() would have swapped in the normal
  // WorkspaceSurface, unmounting React Flow entirely).
  await expect(page.locator('.react-flow')).toBeVisible()

  // The pan centered the Architecture lane: its on-screen center-x settles near
  // the pane's center-x (fitView framed the single lane node).
  await expect
    .poll(async () => {
      const a = await page.locator('.wc-node--architecture').boundingBox()
      const p = await page.locator('.react-flow').boundingBox()
      if (!a || !p) return Number.POSITIVE_INFINITY
      return Math.abs(a.x + a.width / 2 - (p.x + p.width / 2))
    })
    .toBeLessThan(120)
})

// NOTE: the "focusing a cell in an off-screen lane pans it into view" invariant
// used to live here as a quarantined `test.fixme` — it could not be made e2e-
// deterministic (issue 096: the focus-pan setCenter races a one-time post-
// measurement fitView and no-ops under reduced motion). The app-owned decision
// (pan-if-outside-margin, and to what point) is now unit-tested directly in
// src/components/workspaceFocusPan.test.ts — the race left to React Flow (089-P6).

// ── 089-D3 P3.2 / P3.3 — the Architecture lane decomposed into per-table nodes ─
// P3.2 emits one React Flow node per `tier2` table (plus a small header node with
// the add-table phantom); each table node hosts the REAL TablePanel/EditableGrid,
// positioned by computeLaneLayout using MEASURED heights. P3.3 makes Tab cross
// node boundaries by `sort` order (via the EditableGrid.onExitBoundary seam), not
// DOM/array order — the table nodes are deliberately emitted in reverse-sort DOM
// order so this genuinely proves sort-following (native Tab would go the other
// way / fall out of the canvas).

// Add a table through the Architecture header's add-table phantom. Returns once
// the new table's own node has mounted.
async function addArchTable(page: Page, name: string): Promise<void> {
  const header = page.locator('.wc-node--architecture')
  await header.getByPlaceholder('Name a table').click()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(
    page.locator('.wc-node--arch-table').filter({ hasText: name }),
  ).toBeVisible()
}

test('the Architecture lane mounts N per-table nodes with in-node grammar at zoom ≠ 1', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 })
  await openThreeLaneCanvas(page)

  // Two tables → two per-table nodes (the whole-surface architecture node is gone).
  await addArchTable(page, 'Alpha')
  await addArchTable(page, 'Beta')
  await expect(page.locator('.wc-node--arch-table')).toHaveCount(2)

  // The app fit-views on load, so this runs at a non-unity viewport scale.
  await expect.poll(() => viewportScale(page)).not.toBe(1)

  // In-node grammar works inside a per-table node at zoom ≠ 1: the phantom row
  // creates an entry that renders as a real cell in that node.
  const alpha = page.locator('.wc-node--arch-table').filter({ hasText: 'Alpha' })
  await alpha.getByPlaceholder('Name an entry').click()
  await page.keyboard.type('Buyers')
  await page.keyboard.press('Enter')
  await expect(alpha.getByRole('cell', { name: 'Buyers', exact: true })).toBeVisible()
})

// Issue 102 (canvas variant) — the same "Add child swallowed while a rich-text
// description cell is mid-edit" bug reproduces inside a per-table React Flow node
// (the shared ArchitectureSurface `TablePanel` → EditableGrid → inline add-child
// phantom path is surface-agnostic). The EditableGrid fix (suppress `editing`
// synchronously while the inline add-child row is armed, so the still-mounted
// Lexical editor unmounts before it can re-grab focus and blur-dismiss the
// phantom) must therefore hold on the canvas too.
test('architecture 102 (canvas): Add child works while a description cell is being edited inside a table node', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 })
  await openThreeLaneCanvas(page)

  await addArchTable(page, 'Value')
  const valueNode = page.locator('.wc-node--arch-table').filter({ hasText: 'Value' })
  await valueNode.getByPlaceholder('Name an entry').click()
  await page.keyboard.type('Comfort')
  await page.keyboard.press('Enter')
  await expect(valueNode.getByRole('cell', { name: 'Comfort', exact: true })).toBeVisible()

  const comfortRow = valueNode.locator('tr', {
    has: page.getByRole('cell', { name: 'Comfort', exact: true }),
  })

  // Open + type into the rich-text description cell — do NOT commit/exit first.
  await comfortRow.getByRole('cell').nth(2).click()
  await page.locator('[contenteditable="true"]:focus').pressSequentially('Seating comfort')

  // With the description still mid-edit, open the ⋯ row menu and click Add child
  // (issue 105 P5 — the single-row verbs now live in one gutter menu).
  await comfortRow.hover()
  await valueNode.getByRole('button', { name: 'Row actions for Comfort' }).click()
  await page.locator('.menu').getByRole('button', { name: 'Add child' }).click()

  // The child phantom must appear AND survive the focus fight.
  const childField = page.getByPlaceholder('Name a child of Comfort')
  await expect(childField).toBeVisible({ timeout: 2000 })
  await page.waitForTimeout(500)
  await expect(childField).toBeVisible()

  // And be usable: type a name + Enter creates the child under Comfort.
  await childField.fill('Legroom')
  await childField.press('Enter')
  await expect(valueNode.getByRole('cell', { name: 'Legroom', exact: true })).toBeVisible()
  // The description edit was preserved (committed on blur), not lost.
  await expect(comfortRow.getByText('Seating comfort')).toBeVisible()
})

test('cross-node Tab follows sort order between table nodes (forward + backward)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)

  // Alpha (sort 0) then Beta (sort 1). Give Beta a real first cell so forward Tab
  // lands on a data cell, not just Beta's phantom.
  await addArchTable(page, 'Alpha')
  await addArchTable(page, 'Beta')
  const alpha = page.locator('.wc-node--arch-table').filter({ hasText: 'Alpha' })
  const beta = page.locator('.wc-node--arch-table').filter({ hasText: 'Beta' })

  await beta.getByPlaceholder('Name an entry').click()
  await page.keyboard.type('B-entry')
  await page.keyboard.press('Enter')
  await expect(beta.getByRole('cell', { name: 'B-entry', exact: true })).toBeVisible()

  // Adding two tables re-measures + re-fits the lane; wait for the one-time fit to
  // settle BEFORE the focus handoffs so the cross-node focus-pan isn't racing it
  // (the 096 focus-pan race — this spec flaked under full-suite load without it).
  await waitForStableViewport(page)

  // FORWARD: from Alpha's empty phantom (the grid's forward boundary), Tab hands
  // off to the NEXT-by-sort node (Beta) and lands on its first editable cell —
  // even though Beta is DOM-BEFORE Alpha (reverse-sort DOM order), so native Tab
  // could never reach it this way.
  await alpha.getByPlaceholder('Name an entry').click()
  await page.keyboard.press('Tab')
  // 099 — DETERMINISTIC FOCUS-SETTLE (was retry-mitigated / relied on retries:2).
  // The cross-node handoff focuses Beta's first data cell from inside a rAF (the
  // EditableGrid.onExitBoundary seam), and the focus-pan can re-run it — so a
  // one-shot `toBeFocused()` snapshot can read before the rAF fires and flake
  // (HANDOFF e2e lesson: poll activeElement, never read it once). Poll the SAME
  // invariant the old `toBeFocused()` + `toHaveText('B-entry')` pair asserted:
  // focus crossed to the BETA node and landed on its B-entry grid cell.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.activeElement
          return {
            inGridCell: !!el?.closest('.grid-cell'),
            inBetaNode: (el?.closest('.wc-node--arch-table')?.textContent ?? '').includes('Beta'),
            hasBEntry: (el?.textContent ?? '').includes('B-entry'),
          }
        }),
      { timeout: 3000 },
    )
    .toEqual({ inGridCell: true, inBetaNode: true, hasBEntry: true })

  // BACKWARD: from Beta's first editable cell (its backward boundary), Shift+Tab
  // hands off to the PREV-by-sort node (Alpha) and lands on its last editable
  // position — the phantom "Name an entry" row.
  await beta.getByRole('cell', { name: 'B-entry', exact: true }).click()
  await waitForStableViewport(page)
  await page.keyboard.press('Shift+Tab')
  // Same rAF/focus-pan race on the reverse boundary → poll activeElement rather
  // than a one-shot `toBeFocused()`. Assert focus crossed back to ALPHA and landed
  // on its "Name an entry" phantom input (input OR textarea — read the attribute,
  // don't assume the element kind).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.activeElement
          return {
            isEntryPhantom: el?.getAttribute('placeholder') === 'Name an entry',
            inAlphaNode: (el?.closest('.wc-node--arch-table')?.textContent ?? '').includes('Alpha'),
          }
        }),
      { timeout: 3000 },
    )
    .toEqual({ isEntryPhantom: true, inAlphaNode: true })
})

// ── 089-D3 P3.4 — constrained drag reorders `sort` (persisted, derived pos) ───
// Dragging a table node's header up/down its lane reorders the tables and
// PERSISTS the new `sort` (via the tier2 table-reorder mutation). Position stays
// DERIVED — never a persisted `{x,y}` — so the lane must stay a clean vertical
// column and the new order must survive a reload (a real `sort` write, not just
// in-memory node coords). The table nodes are emitted in reverse-sort DOM order,
// so this is a genuine reorder of `sort`, not of DOM/array order.

// Table names top-to-bottom by each arch-table node's on-screen y, plus their
// rounded left-x — the visual `sort` stack and the lane's column invariant.
// The `|`-joined React Flow transforms of the arch-table nodes — a signature of
// the current derived stack, used to wait until fit-view/measurement has settled
// before dragging (a drag against a still-animating viewport races and flakes).
async function archNodeTransforms(page: Page): Promise<string> {
  return page.locator('.wc-node--arch-table').evaluateAll((els) =>
    els
      .map((el) => {
        const node = el.closest('.react-flow__node')
        return node ? (node as HTMLElement).style.transform : ''
      })
      .join('|'),
  )
}

// Block until the arch-table stack transforms are identical across two
// consecutive polls — i.e. the viewport has stopped moving.
async function waitForStableArchStack(page: Page): Promise<void> {
  let prev = ''
  await expect
    .poll(async () => {
      const cur = await archNodeTransforms(page)
      const stable = cur !== '' && cur === prev
      prev = cur
      return stable
    })
    .toBe(true)
}

async function archTablesByY(
  page: Page,
): Promise<{ names: string[]; xs: number[] }> {
  const items = await page.locator('.wc-node--arch-table').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      const handle = el.querySelector('.wc-node__handle')
      const name = handle ? handle.textContent.trim() : ''
      return { name, y: r.top, x: Math.round(r.left) }
    }),
  )
  items.sort((a, b) => a.y - b.y)
  return { names: items.map((i) => i.name), xs: items.map((i) => i.x) }
}

test('dragging a table node down its lane reorders + persists sort, and the lane stays a clean vertical column', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  const projectId = await openThreeLaneCanvas(page)

  // Three tables → derived stack Alpha (sort 0), Beta (1), Gamma (2).
  await addArchTable(page, 'Alpha')
  await addArchTable(page, 'Beta')
  await addArchTable(page, 'Gamma')
  await expect(page.locator('.wc-node--arch-table')).toHaveCount(3)

  // Frame all three table nodes into the pane so the drag origin + drop target
  // are both on-screen, then wait for the fit-view pan to settle before dragging.
  await page.locator('.react-flow__controls-fitview').click()
  await waitForStableArchStack(page)

  const before = await archTablesByY(page)
  expect(before.names).toEqual(['Alpha', 'Beta', 'Gamma'])
  // Clean vertical column: every table node shares one left-x.
  expect(new Set(before.xs).size).toBe(1)

  // Drag Alpha's HEADER (the only drag origin — `dragHandle`) down past Gamma.
  const alphaHandle = page
    .locator('.wc-node--arch-table')
    .filter({ hasText: 'Alpha' })
    .locator('.wc-node__handle')
  const gammaNode = page.locator('.wc-node--arch-table').filter({ hasText: 'Gamma' })
  const start = await alphaHandle.boundingBox()
  const gammaBox = await gammaNode.boundingBox()
  if (!start || !gammaBox) throw new Error('drag handle + gamma node must have boxes')
  const startX = start.x + start.width / 2
  const startY = start.y + start.height / 2
  const dropY = gammaBox.y + gammaBox.height + 24 // below Gamma's center → last

  // React Flow's node-drag needs a real pointer sequence with an initial nudge.
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY + 12, { steps: 4 })
  await page.mouse.move(startX, dropY, { steps: 12 })
  await page.mouse.up()

  // Reordered: Alpha is now last. The dropped node snapped to its DERIVED slot
  // (never kept its dragged coords), and the column is still a single x.
  await expect
    .poll(async () => (await archTablesByY(page)).names)
    .toEqual(['Beta', 'Gamma', 'Alpha'])
  const afterDrop = await archTablesByY(page)
  expect(new Set(afterDrop.xs).size).toBe(1) // x invariant — lane stays vertical

  // PERSISTED — a reload re-reads `sort` from PGlite; the new order survives.
  // If a `{x,y}` had been persisted instead of `sort`, the reload's derived
  // layout would fall back to creation-order — this proves `sort` was written.
  await page.goto(`/p/${projectId}/design?d3rf=1`)
  await expect(page.locator('.wc-node--arch-table')).toHaveCount(3)
  await expect
    .poll(async () => (await archTablesByY(page)).names)
    .toEqual(['Beta', 'Gamma', 'Alpha'])
  const afterReload = await archTablesByY(page)
  expect(new Set(afterReload.xs).size).toBe(1)
})

// ── 089-D3 graduation P1 — DECOMPOSE the Foundation lane into per-item nodes ──
// Where P2 mounted Foundation as ONE whole-surface `lane` node, the Foundation
// column now emits a header node (`.wc-node--foundation`: heading + Purpose +
// Existing-Scenario rich editors + the add-prop phantom) plus one node PER
// `tier1_props` value-prop (`.wc-node--foundation-item`, id = prop id), each
// hosting the real name/description EditableGrid. This mirrors the Architecture
// decomposition exactly — the one difference is Foundation reorders by RANK
// (`reorderProp`), not `sort`. Positions stay DERIVED (never a persisted x/y).

async function addFoundationProp(page: Page, name: string): Promise<void> {
  const header = page.locator('.wc-node--foundation')
  await header.getByPlaceholder('Name a value proposition').click()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(
    page.locator('.wc-node--foundation-item').filter({ hasText: name }),
  ).toBeVisible()
}

// Value-prop names top-to-bottom by each foundation-item node's on-screen y,
// plus their rounded left-x — the visual `rank` stack and the column invariant.
// The name is read from the item's first editable grid cell (the name column).
async function foundationPropsByY(
  page: Page,
): Promise<{ names: string[]; xs: number[] }> {
  const items = await page.locator('.wc-node--foundation-item').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      const cell = el.querySelector('tbody tr[data-row-id] .grid-cell[tabindex]')
      const name = cell ? cell.textContent.trim() : ''
      return { name, y: r.top, x: Math.round(r.left) }
    }),
  )
  items.sort((a, b) => a.y - b.y)
  return { names: items.map((i) => i.name), xs: items.map((i) => i.x) }
}

async function foundationItemTransforms(page: Page): Promise<string> {
  return page.locator('.wc-node--foundation-item').evaluateAll((els) =>
    els
      .map((el) => {
        const node = el.closest('.react-flow__node')
        return node ? (node as HTMLElement).style.transform : ''
      })
      .join('|'),
  )
}

async function waitForStableFoundationStack(page: Page): Promise<void> {
  let prev = ''
  await expect
    .poll(async () => {
      const cur = await foundationItemTransforms(page)
      const stable = cur !== '' && cur === prev
      prev = cur
      return stable
    })
    .toBe(true)
}

test('the Foundation lane decomposes into a header + per-prop nodes, editable at zoom ≠ 1', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)

  // The header node keeps the `1st Tier` heading + the Purpose rich editor.
  await expect(page.locator('.wc-node--foundation')).toBeVisible()
  await expect(page.getByRole('heading', { name: /1st Tier/ })).toBeVisible()

  // Two value props → two per-prop nodes (the whole-surface Foundation node is gone).
  await addFoundationProp(page, 'Comfort')
  await addFoundationProp(page, 'Mobility')
  await expect(page.locator('.wc-node--foundation-item')).toHaveCount(2)

  // The app fit-views on load, so this runs at a non-unity viewport scale.
  await expect.poll(() => viewportScale(page)).not.toBe(1)

  // Let the create-focus (onPropCreated rAF) + its focus-pan settle before the
  // next interaction, so a delayed programmatic focus can't steal our typing.
  await waitForStableViewport(page)

  // Purpose is editable in the header node at zoom ≠ 1 (the proven foundation.spec
  // interaction: the role=textbox rich editor, click + type, commit-agnostic).
  const purpose = page
    .locator('.wc-node--foundation')
    .getByRole('textbox', { name: 'System purpose' })
  await purpose.click()
  await page.keyboard.type('Move people comfortably')
  await expect(purpose).toContainText('Move people comfortably')

  // In-node grid grammar works at zoom ≠ 1: clicking a prop's name cell opens an
  // editable input inside that per-prop node.
  const comfort = page.locator('.wc-node--foundation-item').filter({ hasText: 'Comfort' })
  const nameCell = comfort.locator('tbody tr[data-row-id] .grid-cell[tabindex]').first()
  await nameCell.click()
  await expect(comfort.locator('input, textarea, [contenteditable="true"]').first()).toBeVisible()
})

test('dragging a value-prop node down its lane reorders + persists rank, and the lane stays a clean vertical column', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  const projectId = await openThreeLaneCanvas(page)

  // Three props → derived rank stack Comfort (1°), Mobility (2°), Speed (3°).
  await addFoundationProp(page, 'Comfort')
  await addFoundationProp(page, 'Mobility')
  await addFoundationProp(page, 'Speed')
  await expect(page.locator('.wc-node--foundation-item')).toHaveCount(3)

  await page.locator('.react-flow__controls-fitview').click()
  await waitForStableFoundationStack(page)

  const before = await foundationPropsByY(page)
  expect(before.names).toEqual(['Comfort', 'Mobility', 'Speed'])
  expect(new Set(before.xs).size).toBe(1) // clean vertical column

  // Drag Comfort's HEADER (its only drag origin) down past Speed → it becomes last.
  const comfortHandle = page
    .locator('.wc-node--foundation-item')
    .filter({ hasText: 'Comfort' })
    .locator('.wc-node__handle')
  const speedNode = page.locator('.wc-node--foundation-item').filter({ hasText: 'Speed' })
  const start = await comfortHandle.boundingBox()
  const speedBox = await speedNode.boundingBox()
  if (!start || !speedBox) throw new Error('drag handle + speed node must have boxes')
  const startX = start.x + start.width / 2
  const startY = start.y + start.height / 2
  const dropY = speedBox.y + speedBox.height + 24

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY + 12, { steps: 4 })
  await page.mouse.move(startX, dropY, { steps: 12 })
  await page.mouse.up()

  await expect
    .poll(async () => (await foundationPropsByY(page)).names)
    .toEqual(['Mobility', 'Speed', 'Comfort'])
  const afterDrop = await foundationPropsByY(page)
  expect(new Set(afterDrop.xs).size).toBe(1) // x invariant — lane stays vertical

  // PERSISTED — a reload re-reads `rank` from PGlite; the new order survives (a
  // real rank write via reorderProp, not in-memory node coords).
  await page.goto(`/p/${projectId}/design?d3rf=1`)
  await expect(page.locator('.wc-node--foundation-item')).toHaveCount(3)
  await expect
    .poll(async () => (await foundationPropsByY(page)).names)
    .toEqual(['Mobility', 'Speed', 'Comfort'])
  const afterReload = await foundationPropsByY(page)
  expect(new Set(afterReload.xs).size).toBe(1)
})

// 089-D3 graduation P0 — the `?d3rf` opt-in now persists in the canvasMode store
// (seeded once from the initial URL), so an in-app navigate() that rebuilds the
// URL and DROPS the flag no longer exits the canvas. Every test above has to
// `page.goto` the full `?d3rf` URL precisely because a tab click used to drop it
// mid-flow; this guards that persistence directly. It is the prerequisite for
// the satellite phases (recursion drill-in / coverage toggle), which all navigate.
test('the ?d3rf canvas survives an in-app navigate that drops the flag (P0 — canvasMode store)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await expect(page).toHaveURL(/\/p\/[^/]+/)
  const projectId = /\/p\/([^/?#]+)/.exec(page.url())?.[1]
  expect(projectId).toBeTruthy()

  // Enter the canvas on Architecture WITH the dev flag — a full load, so
  // canvasMode seeds `canvasEnabled` from `?d3rf`.
  await page.goto(`/p/${projectId}/architecture?d3rf=1`)
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 15_000 })

  // A REAL in-app navigate(): click the Design tab. serializeRoute rebuilds the
  // URL and DROPS `?d3rf` — but the store persists `canvasEnabled`, so the canvas
  // stays mounted (pre-P0 it unmounted to WorkspaceSurface).
  await page.getByRole('link', { name: 'Design' }).click()
  await expect(page).toHaveURL(/\/p\/[^/]+\/design$/)
  expect(new URL(page.url()).searchParams.has('d3rf')).toBe(false)
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect(page.locator('.wc-node--design-register')).toBeVisible()
})

// ── 089-D3 graduation P2 — DECOMPOSE the Design lane into a {register + ring} core
// The Design lane is now TWO React Flow nodes — a register body (rail +
// ContextRegister + header, the authoring surface) stacked OVER a ring body
// (Canvas, the derived glance). They are separate React trees, so the compose
// draft they share lives in the `canvasCompose` store: `c` in the register ENTERS
// compose, and the draft dot renders in the SEPARATE ring node. Selection is
// shared via the contexts store. 085 holds: no on-ring authoring.
test('the Design lane is a register node stacked over a ring node, with cross-node compose at zoom ≠ 1', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)

  const register = page.locator('.wc-node--design-register')
  const ring = page.locator('.wc-node--design-ring')
  await expect(register).toBeVisible()
  await expect(ring).toBeVisible()

  // The register hosts the ContextRegister grid; the ring hosts the Canvas svg.
  await expect(register.locator('.context-register-shell')).toBeVisible({ timeout: 15_000 })
  await expect(ring.locator('.canvas-svg')).toBeVisible({ timeout: 15_000 })

  // Register stacked OVER ring (owner "register over ring" layout).
  const rBox = await register.boundingBox()
  const gBox = await ring.boundingBox()
  if (!rBox || !gBox) throw new Error('both design nodes must have a bounding box')
  expect(rBox.y).toBeLessThan(gBox.y)

  // Give Design two dimensions via the rail (in the register node) so a compose
  // draft can render on the canvas.
  const dimPhantom = register.getByPlaceholder('Type to add a dimension')
  await dimPhantom.click()
  await page.keyboard.type('Value')
  await page.keyboard.press('Enter')
  await dimPhantom.click()
  await page.keyboard.type('Stake')
  await page.keyboard.press('Enter')
  await expect(register.locator('.dim-row')).toHaveCount(2)

  // The app fit-views on load, so the cross-node interaction below runs at a
  // non-unity viewport scale.
  await expect.poll(() => viewportScale(page)).not.toBe(1)

  // `c` in the register (Design lane active) ENTERS compose → the draft dot
  // renders in the SEPARATE ring node — proving the two nodes share the compose
  // draft via the canvasCompose store (a plain useState couldn't cross the trees).
  await register.locator('.coverage-stat').click()
  await page.keyboard.press('c')
  await expect(ring.locator('.canvas-node--draft')).toHaveCount(1)

  // The draft is selected (enterCompose selects it); selection is shared via the
  // contexts store, so the register reflects it as a selected row.
  await expect(register.locator('.grid-row--selected')).toHaveCount(1)
})

// ── Issue 093 — the D3 register extends RIGHT + LOD tuple-summary collapse ─────
// On the canvas the Design register grows to its content width (no clip behind
// the frozen symbol column, no inner horizontal scrollbar) so far proof columns
// are reached by panning; the stranded top "New context" button is gone (the
// phantom row is the sole create); and below ~0.6 zoom the per-dimension columns
// collapse to one tuple-summary column for overview legibility.
test('the D3 register extends right, drops the New-context button, and LOD-collapses when zoomed out', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)

  const register = page.locator('.wc-node--design-register')
  await expect(register.locator('.context-register-shell')).toBeVisible({ timeout: 15_000 })

  // The stranded top "New context" button is removed (the register body no longer
  // renders `.canvas-toolbar`); the phantom row is the sole create affordance.
  await expect(register.locator('.canvas-toolbar')).toHaveCount(0)

  // Add six dimensions so the register is wider than the old fixed 960px node.
  const dimPhantom = register.getByPlaceholder('Type to add a dimension')
  for (const name of ['Dim1', 'Dim2', 'Dim3', 'Dim4', 'Dim5', 'Dim6']) {
    await dimPhantom.click()
    await page.keyboard.type(name)
    await page.keyboard.press('Enter')
  }
  await expect(register.locator('.dim-row')).toHaveCount(6)

  // Zoom IN past the LOD threshold (0.6) so the full per-dimension columns show.
  const zoomIn = page.locator('.react-flow__controls-zoomin')
  for (let i = 0; i < 8; i++) await zoomIn.click()

  // EXPANDED: every per-dimension column header is present, no Tuple summary.
  await expect(register.getByRole('columnheader', { name: 'Dim1', exact: true })).toBeVisible()
  await expect(register.getByRole('columnheader', { name: 'Dim6', exact: true })).toBeVisible()
  await expect(register.getByRole('columnheader', { name: 'Tuple', exact: true })).toHaveCount(0)

  // EXTEND-RIGHT: the register node's own (unscaled) DOM width exceeds the old
  // 960px cap — it grew to content instead of clipping (6 dims stays under the
  // 089-P5 1600px cap, so no inner scroll here). Past the cap the register
  // inner-scrolls (P5 changed overflow-x from `visible` to `auto` so a wide
  // register can't grow without bound or overlap the satellite/twin clearance).
  const nodeWidth = await register.evaluate((el) => (el as HTMLElement).offsetWidth)
  expect(nodeWidth).toBeGreaterThan(960)
  expect(nodeWidth).toBeLessThanOrEqual(1600)
  const overflowX = await register
    .locator('.register-scroll')
    .evaluate((el) => getComputedStyle(el).overflowX)
  expect(overflowX).toBe('auto')

  // Zoom OUT below the LOD threshold → the per-dimension columns COLLAPSE to one
  // tuple-summary column (overview legibility).
  const zoomOut = page.locator('.react-flow__controls-zoomout')
  for (let i = 0; i < 12; i++) await zoomOut.click()

  await expect(register.getByRole('columnheader', { name: 'Tuple', exact: true })).toBeVisible()
  await expect(register.getByRole('columnheader', { name: 'Dim1', exact: true })).toHaveCount(0)
})

// ── Issue 100 Phase D — recursion drills to a LIVE child core ────────────────
// Drilling into a context PROMOTES its child canvas from a summary STUB to a
// second LIVE {register + ring} core mounted beside the parent, editable in
// place, backed by its OWN INDEPENDENT store instance (keyed by the parent
// context id). Adding a context inside the child core must appear THERE ONLY,
// never in the parent — the proof that the two cores hold separate stores. The
// parent→child edge connects the two cores; collapse (×) tears down the child
// store and unmounts both child bodies, leaving the parent byte-unchanged.

test('drilling α promotes a LIVE child core with an INDEPENDENT store (parent unaffected)', { tag: '@dev-flag' }, async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)

  const parentRegister = page.locator('.wc-node--design-register').nth(0)
  const parentShell = parentRegister.locator('.context-register-shell')
  await expect(parentShell).toBeVisible({ timeout: 15_000 })

  // Seed a dimension + one parameter + one context (α) in the ROOT core.
  const dimPhantom = parentRegister.getByPlaceholder('Type to add a dimension')
  await dimPhantom.click()
  await page.keyboard.type('Value')
  await page.keyboard.press('Enter')
  await expect(parentRegister.locator('.dim-row__name', { hasText: 'Value' })).toBeVisible()
  const paramPhantom = parentRegister.getByPlaceholder('Type to add a parameter').first()
  await paramPhantom.click({ force: true })
  await paramPhantom.pressSequentially('Comfort')
  await page.keyboard.press('Enter')
  await expect(parentRegister.getByText('Comfort', { exact: true })).toBeVisible()

  const parentPhantom = parentShell.getByPlaceholder(/it becomes α|New context/)
  await parentPhantom.click()
  await page.keyboard.type('root-alpha justification')
  await page.keyboard.press('Enter')
  await expect(parentShell.getByText('α', { exact: true })).toBeVisible()

  // Before drilling: exactly the four primary lane nodes, one Design register.
  await expect(page.locator('.wc-node')).toHaveCount(4)
  await expect(page.locator('.wc-node--design-register')).toHaveCount(1)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)

  // Drill α ("Open ▸") → a SECOND live {register + ring} core mounts beside the
  // parent (NOT a summary stub): two registers, two rings, six .wc-node total.
  await waitForStableViewport(page)
  await parentShell.locator('.children-drill').first().click()

  await expect(page.locator('.wc-node--design-register')).toHaveCount(2)
  await expect(page.locator('.wc-node--design-ring')).toHaveCount(2)
  await expect(page.locator('.wc-node')).toHaveCount(6)
  // The parent→child edge connects the two cores.
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  const childRegister = page.locator('.wc-node--design-register').nth(1)
  const childShell = childRegister.locator('.context-register-shell')
  await expect(childShell).toBeVisible({ timeout: 15_000 })
  // 100-D flake hardening — the child core mounts async and, under full-suite CI
  // load, its register + phantom settle slowly; the α1 render can exceed the
  // default expect timeout (this spec was losing all retries to it). Wait for the
  // viewport to settle and the child phantom to be interactable before typing, and
  // give the α1 render a generous timeout so it never loses to mount-timing.
  await waitForStableViewport(page)

  // Add a context in the CHILD core. Its child canvas starts empty, so the first
  // context becomes α1 (child-of-α, SPEC §3). INDEPENDENT-STORE PROOF: this must
  // land in the child core ONLY — a shared singleton store would leak it into the
  // parent register too.
  const childPhantom = childShell.getByPlaceholder(/Type to create the first context on this canvas|New context/)
  await expect(childPhantom).toBeVisible({ timeout: 15_000 })
  await childPhantom.click()
  await page.keyboard.type('child-beta justification')
  await page.keyboard.press('Enter')
  await expect(childShell.getByText('α1', { exact: true })).toBeVisible({ timeout: 30_000 })

  // Parent core STILL shows α and does NOT show α1 (independent stores).
  await expect(parentShell.getByText('α', { exact: true })).toBeVisible()
  await expect(parentShell.getByText('α1', { exact: true })).toHaveCount(0)
  // Child core shows its own α1.
  await expect(childShell.getByText('α1', { exact: true })).toBeVisible()

  // Collapse the child core (×) → tears down its store + unmounts both bodies;
  // the parent core is byte-unchanged (still α, four nodes, one register, no edge).
  await waitForStableViewport(page)
  await childRegister.locator('.wc-child-collapse').click()
  await expect(page.locator('.wc-node--design-register')).toHaveCount(1)
  await expect(page.locator('.wc-node')).toHaveCount(4)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await expect(parentShell.getByText('α', { exact: true })).toBeVisible()
})

test('a live child core clears a 093-widened parent register — no overlap (review HIGH guard)', { tag: '@dev-flag' }, async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)
  const parentRegister = page.locator('.wc-node--design-register').nth(0)
  await expect(parentRegister.locator('.context-register-shell')).toBeVisible({ timeout: 15_000 })

  // Widen the parent register well past the nominal 960px lane width (093 made it
  // width:max-content, uncapped). Six dimensions push it past 960 + coreGap.
  const dimPhantom = parentRegister.getByPlaceholder('Type to add a dimension')
  for (const name of ['Dim1', 'Dim2', 'Dim3', 'Dim4', 'Dim5', 'Dim6']) {
    await dimPhantom.click()
    await page.keyboard.type(name)
    await page.keyboard.press('Enter')
  }
  await expect(parentRegister.locator('.dim-row')).toHaveCount(6)
  expect(await parentRegister.evaluate((el) => (el as HTMLElement).offsetWidth)).toBeGreaterThan(1080)

  // One context, then drill to promote its child canvas to a live child core.
  const shell = parentRegister.locator('.context-register-shell')
  const phantom = shell.getByPlaceholder(/it becomes α|New context/)
  await phantom.click()
  await page.keyboard.type('first justification')
  await page.keyboard.press('Enter')
  await expect(shell.getByText('α', { exact: true })).toBeVisible()

  await waitForStableViewport(page)
  await shell.locator('.children-drill').first().click()
  await expect(page.locator('.wc-node--design-register')).toHaveCount(2)
  const childRegister = page.locator('.wc-node--design-register').nth(1)
  await expect(childRegister.locator('.context-register-shell')).toBeVisible({ timeout: 15_000 })
  await waitForStableViewport(page)

  // NO OVERLAP: the child core's left edge is at/after the parent register node's
  // right edge (screen coords — both share the viewport transform, so the relative
  // check is scale-invariant). The clearance is derived from the WIDEST measured
  // primary design-column node, so a 093-widened parent never overlaps its child.
  const regBox = await parentRegister.boundingBox()
  const childBox = await childRegister.boundingBox()
  expect(regBox).not.toBeNull()
  expect(childBox).not.toBeNull()
  if (regBox && childBox) {
    expect(childBox.x).toBeGreaterThanOrEqual(regBox.x + regBox.width - 1)
  }
})

// ── 089-D3 P4 — coverage (012) as an edge-connected analytical twin ──────────
// The `v` key (and the header Coverage toggle) now OPEN a coverage TWIN node
// below the Design core + a ring→twin edge, instead of the old route swap that
// REPLACED the ring. The twin is FULLY LIVE (CoverageMatrix reads the same
// current-canvas stores the ring reads). A gap-cell click composes pre-filled +
// pans back along the edge to the ring. routes.ts `?view=` grammar is preserved.

// Open the ?d3rf canvas + seed 3 dimensions × 2 parameters (tuple space = 8),
// mirroring the flag-off coverage.spec so the same gap-cell selectors apply.
async function openCanvasWithCoverageData(page: Page): Promise<void> {
  await openThreeLaneCanvas(page)
  const register = page.locator('.wc-node--design-register')
  await expect(register.locator('.context-register-shell')).toBeVisible({ timeout: 15_000 })
  async function addDim(name: string) {
    const p = register.getByPlaceholder('Type to add a dimension')
    await p.fill(name)
    await p.press('Enter')
    await expect(register.locator('.dim-row__name', { hasText: name })).toBeVisible()
  }
  await addDim('Value')
  await addDim('Stake')
  await addDim('Process')
  // Each dimension has exactly one "Type to add a parameter" phantom, in dim order
  // (Value=0, Stake=1, Process=2) — target by index (a nested .filter({has}) is not
  // reliably actionable at canvas scale) and force-click past the transformed pane.
  async function addParam(dimIndex: number, param: string) {
    const p = register.getByPlaceholder('Type to add a parameter').nth(dimIndex)
    await p.click({ force: true })
    await p.pressSequentially(param)
    await page.keyboard.press('Enter')
    await expect(register.getByText(param, { exact: true })).toBeVisible()
  }
  await addParam(0, 'Comfort')
  await addParam(0, 'Cost')
  await addParam(1, 'Users')
  await addParam(1, 'Admins')
  await addParam(2, 'Engagement')
  await addParam(2, 'Onboarding')
}

test('the `v` key opens an edge-connected coverage twin (not a route swap); v again collapses it', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openCanvasWithCoverageData(page)

  // Nothing spatial before: four lane nodes, no twin, no edge.
  await expect(page.locator('.wc-node--coverage-twin')).toHaveCount(0)
  await expect(page.locator('.wc-node')).toHaveCount(4)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)

  // Focus the ring surface (not a text field) so `v` fires; settle the viewport.
  await page.locator('.wc-node--design-ring .canvas-svg').click()
  await waitForStableViewport(page)
  const urlBefore = page.url()
  const beforeOpen = await viewportTransform(page)

  // `v` opens the twin + the ring→twin edge — NOT a route swap: URL unchanged, the
  // ring still shows the Canvas (not replaced), the twin is a 5th `.wc-node`.
  await page.keyboard.press('v')
  const twin = page.locator('.wc-node--coverage-twin')
  await expect(twin).toHaveCount(1)
  await expect(twin.locator('.coverage-matrix')).toBeVisible()
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect(page.locator('.wc-node')).toHaveCount(5)
  await expect(page.locator('.wc-node--design-ring .canvas-svg')).toBeVisible()
  expect(page.url()).toBe(urlBefore)

  // Pan-to-twin: the viewport moved to frame it.
  await expect.poll(async () => (await viewportTransform(page)) !== beforeOpen).toBe(true)

  // `v` again collapses the twin + its edge; back to four lane nodes.
  await page.locator('.wc-node--design-ring .canvas-svg').click()
  await waitForStableViewport(page)
  await page.keyboard.press('v')
  await expect(page.locator('.wc-node--coverage-twin')).toHaveCount(0)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await expect(page.locator('.wc-node')).toHaveCount(4)
})

test('a coverage-twin gap cell composes pre-filled and pans back to the ring; the stat is live', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openCanvasWithCoverageData(page)

  await page.locator('.wc-node--design-ring .canvas-svg').click()
  await waitForStableViewport(page)
  await page.keyboard.press('v')

  const twin = page.locator('.wc-node--coverage-twin')
  await expect(twin.locator('.coverage-matrix')).toBeVisible()
  // Live stat derived from the 3×2 tuple space (8), 0 documented yet — a stub
  // would not know the real total.
  await expect(twin.locator('.coverage-stat--lead')).toHaveText('0 / 8 documented')

  // A hollow gap cell → compose pre-filled with that tuple, then pan back to the
  // ring (the draft's compose dot group is now in the ring, which was NOT replaced).
  const gap = twin.getByRole('gridcell', { name: 'Unexplored — Comfort · Users · Engagement' })
  await expect(gap).toHaveAttribute('data-documented', 'false')
  await gap.click()
  await expect(page.locator('.wc-node--design-ring .canvas-dot-group--compose').first()).toBeVisible()
})

// ── 089-D3 P5 — LOD + perf at volume ────────────────────────────────────────
// A volume project (12 value-props + 12 tables for the lane LOD, 20 dimensions ×
// 50 contexts for the register) imported via the .gede.json file input. At
// overview zoom (below LANE_LOD_ZOOM) the per-item lane nodes render `.wc-lane-summary`
// cards, NOT full `.editable-grid`s; zooming back in near 1:1 remounts the real
// grids. Guards no console errors across import + pan/zoom.

// Build a minimal but valid FORMAT_VERSION 5 envelope (fixed timestamps, no
// Date.now — deterministic). Root canvas only; all dimensions/contexts on it.
function volumeEnvelopeJson(): string {
  const TS = '2020-01-01T00:00:00.000Z'
  const base = { workspaceId: null, createdAt: TS, updatedAt: TS, deletedAt: null }
  const projects = [{ id: 'p1', name: 'VolumeProj', description: null, ...base }]
  const canvases = [
    { id: 'cv-root', projectId: 'p1', parentContextId: null, name: 'Canvas 1', sort: 0, ...base },
  ]
  const tier1_purpose = [{ id: 'tp1', projectId: 'p1', body: '', existingScenario: null, ...base }]
  const tier1_props = Array.from({ length: 12 }, (_, i) => ({
    id: `prop-${i}`, projectId: 'p1', rank: i, name: `Prop ${i}`, description: null, sort: i, ...base,
  }))
  const tier2_tables = Array.from({ length: 12 }, (_, i) => ({
    id: `tbl-${i}`, projectId: 'p1', name: `Table ${i}`, sort: i, ...base,
  }))
  const dimensions = Array.from({ length: 20 }, (_, i) => ({
    id: `dim-${i}`, projectId: 'p1', canvasId: 'cv-root', contextId: null, sourceParamId: null,
    name: `Dim ${i}`, color: '#888888', sort: i, ...base,
  }))
  const parameters = dimensions.flatMap((d, i) =>
    Array.from({ length: 2 }, (_, j) => ({
      id: `param-${i}-${j}`, dimensionId: d.id, parentParamId: null, sourceEntryId: null,
      name: `P${i}-${j}`, sort: j, ...base,
    })),
  )
  const contexts = Array.from({ length: 50 }, (_, i) => ({
    id: `ctx-${i}`, projectId: 'p1', canvasId: 'cv-root', parentId: null,
    symbol: `x${i}`, name: null, justification: null, sort: i, ...base,
  }))
  return JSON.stringify({
    formatVersion: 5,
    tables: {
      projects, canvases, tier1_purpose, tier1_props, tier2_tables,
      tier2_entries: [], dimensions, parameters, contexts, bindings: [],
    },
  })
}

test('at volume, overview renders lane summary cards (not full grids); zooming in remounts the real grids', { tag: '@dev-flag' }, async ({
  page,
}) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  // Import the volume project via the hidden .gede.json file input.
  await page.locator('input[type="file"]').setInputFiles({
    name: 'VolumeProj.gede.json',
    mimeType: 'application/json',
    buffer: Buffer.from(volumeEnvelopeJson()),
  })
  await expect(page.getByRole('button', { name: 'Open VolumeProj' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Open VolumeProj' }).click()
  await expect(page).toHaveURL(/\/p\/[^/]+/)
  const projectId = /\/p\/([^/?#]+)/.exec(page.url())?.[1]
  await page.goto(`/p/${projectId}/design?d3rf=1`)
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect(page.locator('.wc-node--design-register')).toBeVisible({ timeout: 15_000 })
  await waitForStableViewport(page)

  // OVERVIEW: zoom out below LANE_LOD_ZOOM (0.35) so the lane items summarize.
  const zoomOut = page.locator('.react-flow__controls-zoomout')
  await expect.poll(async () => {
    if ((await viewportScale(page)) >= 0.35) {
      await zoomOut.click()
      return false
    }
    return true
  }, { timeout: 20_000 }).toBe(true)

  // Lane items are summary cards, NOT full grids.
  await expect(page.locator('.wc-lane-summary').first()).toBeVisible()
  expect(await page.locator('.wc-lane-summary').count()).toBeGreaterThan(0)
  await expect(page.locator('.wc-node--foundation-item .editable-grid')).toHaveCount(0)
  await expect(page.locator('.wc-node--arch-table .editable-grid')).toHaveCount(0)

  // ZOOM IN near 1:1: the real grids remount, the summaries disappear.
  const zoomIn = page.locator('.react-flow__controls-zoomin')
  await expect.poll(async () => {
    if ((await viewportScale(page)) < 0.5) {
      await zoomIn.click()
      return false
    }
    return true
  }, { timeout: 20_000 }).toBe(true)

  await expect(page.locator('.wc-lane-summary')).toHaveCount(0)
  expect(await page.locator('.wc-node--foundation-item .editable-grid').count()).toBeGreaterThan(0)

  // No console errors across import + pan/zoom (Gate: interactive, no render loop).
  expect(consoleErrors).toEqual([])
})

// 089-P5 review-fix guards ───────────────────────────────────────────────────
// (1) A lane node being edited must NOT LOD-collapse on zoom-out (an EditableGrid
// cell commits on blur, so unmounting the grid mid-edit could drop keystrokes —
// the review HIGH). The focus-within guard keeps an edited node expanded.
test('a lane node being edited does NOT collapse on zoom-out (no lost edit)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)
  await addFoundationProp(page, 'Comfort')
  await waitForStableViewport(page)

  const item = page.locator('.wc-node--foundation-item').filter({ hasText: 'Comfort' })
  const nameCell = item.locator('tbody tr[data-row-id] .grid-cell[tabindex]').first()
  await nameCell.click()
  const input = item.locator('input, textarea, [contenteditable="true"]').first()
  await expect(input).toBeVisible()
  await input.fill('Comfort-EDIT')

  // Zoom out well below LANE_LOD_ZOOM (0.35) via the mouse WHEEL over the pane
  // background — the review's actual hazard (wheel/pinch/trackpad zoom does NOT
  // blur the focused cell, unlike clicking the zoom-out button which would blur +
  // commit first). Wheel over a background point (not a node — node bodies are
  // `nowheel`), keeping the in-flight edit focused throughout.
  await page.mouse.move(800, 120)
  await expect
    .poll(async () => {
      if ((await viewportScale(page)) >= 0.3) {
        await page.mouse.wheel(0, 300)
        return false
      }
      return true
    })
    .toBe(true)

  // The edited node stayed EXPANDED (focus-within guard) — no summary card, the
  // real grid + the in-flight input are still mounted, so no keystroke is lost.
  await expect(item.locator('.wc-lane-summary')).toHaveCount(0)
  await expect(item.locator('input, textarea, [contenteditable="true"]').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(item).toContainText('Comfort-EDIT')
  // (That unfocused per-item lane nodes DO summarize at this overview zoom is
  // covered by the volume test above; here the point is the edited node did not.)
})

// (2) Guided compose must force the register's full per-dimension columns even when
// zoomed out (the collapse would otherwise hide the binding comboboxes the flow
// needs — the review HIGH). The width-cap supersedes the >8-col collapse.
test('entering compose expands the register even when zoomed-out-collapsed', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)
  const register = page.locator('.wc-node--design-register')
  await expect(register.locator('.context-register-shell')).toBeVisible({ timeout: 15_000 })
  const dimPhantom = register.getByPlaceholder('Type to add a dimension')
  for (const name of ['Value', 'Stake']) {
    await dimPhantom.click()
    await page.keyboard.type(name)
    await page.keyboard.press('Enter')
  }
  await expect(register.locator('.dim-row')).toHaveCount(2)

  // Zoom out below the register LOD (0.6) → the per-dimension columns collapse to
  // the single tuple-summary column.
  const zoomOut = page.locator('.react-flow__controls-zoomout')
  await expect
    .poll(async () => {
      if ((await viewportScale(page)) >= 0.55) {
        await zoomOut.click()
        return false
      }
      return true
    })
    .toBe(true)
  await expect(register.getByRole('columnheader', { name: 'Tuple', exact: true })).toBeVisible()
  await expect(register.getByRole('columnheader', { name: 'Value', exact: true })).toHaveCount(0)

  // Enter compose (`c`) — the register must EXPAND to the full per-dimension
  // columns despite still being zoomed out, so the guided binding is usable.
  await page.locator('.wc-node--design-ring .canvas-svg').click()
  await waitForStableViewport(page)
  await page.keyboard.press('c')
  await expect(register.getByRole('columnheader', { name: 'Value', exact: true })).toBeVisible()
  await expect(register.getByRole('columnheader', { name: 'Tuple', exact: true })).toHaveCount(0)
})

// 089-P7 — the canvas is now the DEFAULT surface, so it gets the automated a11y
// regression coverage the fallback (WorkspaceSurface / architecture.spec.ts) has
// always had. Scoped to the canvas `main` landmark (role="main" on
// .workspace-canvas), serious/critical WCAG 2 A/AA only — the same bar the
// Architecture axe scan uses.
test('the canvas surface is axe-clean (no serious/critical WCAG 2 A/AA violations)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 })
  await openThreeLaneCanvas(page)
  await expect(page.locator('.wc-node--design-register .context-register-shell')).toBeVisible({ timeout: 15_000 })

  const results = await new AxeBuilder({ page })
    .include('[role="main"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking, JSON.stringify(blocking.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([])
})

// 099 — extend the canvas a11y smoke beyond the EMPTY design view to a POPULATED
// register (3 dims × 2 params) — the data-rich authoring surface the empty smoke
// above doesn't reach.
test('the populated canvas register is axe-clean (WCAG 2 A/AA serious/critical)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openCanvasWithCoverageData(page)
  await waitForStableViewport(page)
  const results = await new AxeBuilder({ page }).include('[role="main"]').withTags(['wcag2a', 'wcag2aa']).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking, JSON.stringify(blocking.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([])
})

// 099-2b — the coverage TWIN's matrix, scanned on the CANVAS host. Deferred at
// 099b because `CoverageMatrix` had a pre-existing invalid ARIA grid (absolutely
// -positioned `role="gridcell"`s with no `role="row"` parent) on BOTH surfaces;
// now that the rows are real (`display: contents`), the twin is in the a11y
// regression net. Twin on the canvas here; fallback in coverage.spec.ts.
test('the canvas coverage twin is axe-clean (WCAG 2 A/AA serious/critical)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openCanvasWithCoverageData(page)
  await page.locator('.wc-node--design-ring .canvas-svg').click()
  await waitForStableViewport(page)
  await page.keyboard.press('v')

  const twin = page.locator('.wc-node--coverage-twin')
  await expect(twin.locator('.coverage-matrix')).toBeVisible()
  await waitForStableViewport(page)

  const results = await new AxeBuilder({ page })
    .include('.wc-node--coverage-twin')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking, JSON.stringify(blocking.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([])
})

// 099 — DEDICATED per-lane axe scans on the CANVAS. The whole-`main` scans above
// (empty canvas-surface + populated register) leave the Foundation and
// Architecture LANES empty — their populated authoring surfaces (the header's
// rich Purpose/Existing-Scenario editors + per-prop grids; the add-table phantom +
// per-table TablePanel grids) never enter the a11y regression net. These populate
// each lane and scan it dedicated at the SAME bar as the twin scan above:
// serious/critical WCAG 2 A/AA only, identical AxeBuilder config. Chained
// `.include()` unions the header node with its item nodes.
test('the populated Foundation lane is axe-clean (WCAG 2 A/AA serious/critical)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)
  await expect(page.locator('.wc-node--foundation')).toBeVisible()

  // Populate the lane: the header keeps its Purpose editor; one value prop mounts a
  // per-prop item node with its real name/description grid.
  await addFoundationProp(page, 'Comfort')
  await waitForStableViewport(page)

  const results = await new AxeBuilder({ page })
    .include('.wc-node--foundation')
    .include('.wc-node--foundation-item')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking, JSON.stringify(blocking.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([])
})

test('the populated Architecture lane is axe-clean (WCAG 2 A/AA serious/critical)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)
  await expect(page.locator('.wc-node--architecture')).toBeVisible()

  // Populate: one table (its own node) with one entry, so the TablePanel grid + the
  // add-table / add-entry phantoms are all inside the scanned surface.
  await addArchTable(page, 'Stakeholders')
  const table = page.locator('.wc-node--arch-table').filter({ hasText: 'Stakeholders' })
  await table.getByPlaceholder('Name an entry').click()
  await page.keyboard.type('Buyers')
  await page.keyboard.press('Enter')
  await expect(table.getByRole('cell', { name: 'Buyers', exact: true })).toBeVisible()
  await waitForStableViewport(page)

  const results = await new AxeBuilder({ page })
    .include('.wc-node--architecture')
    .include('.wc-node--arch-table')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking, JSON.stringify(blocking.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([])
})

// 099 — a keyboard-reachability / LANDMARK invariant across the React Flow lane
// nodes, complementing the static axe scans. Asserts (a) the canvas exposes
// exactly ONE `main` landmark that CONTAINS all three tier lanes (landmark
// uniqueness — the same guarantee the fallback WorkspaceSurface has), and (b)
// forward Tab from a known register field keeps focus INSIDE that landmark — it
// never falls through to <body> / browser chrome. activeElement is read via
// expect.poll: a focus-pan can land focus in a rAF, so a one-shot read flakes
// (HANDOFF e2e lesson). The invariant is deliberately tolerant (in-main, not-body)
// rather than a brittle exact-next-element assertion.
test('the canvas is one main landmark containing all lanes, and Tab keeps focus inside it', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 })
  await openThreeLaneCanvas(page)

  const main = page.getByRole('main')
  await expect(main).toHaveCount(1)
  const register = main.locator('.wc-node--design-register')
  await expect(register.locator('.context-register-shell')).toBeVisible({ timeout: 15_000 })

  // All three tier lanes live inside the single main landmark.
  await expect(main.locator('.wc-node--foundation')).toHaveCount(1)
  await expect(main.locator('.wc-node--architecture')).toHaveCount(1)
  await expect(register).toHaveCount(1)

  await waitForStableViewport(page)

  // Focus a known, on-screen register field, then Tab forward: focus must stay
  // within the main landmark (the RF controls also live inside it) and never reach
  // <body> — the focus-order integrity the keyboard user depends on.
  await register.getByPlaceholder('Type to add a dimension').click()
  await page.keyboard.press('Tab')
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.activeElement
          return {
            isBody: el === document.body || el === null,
            inMain: !!el?.closest('[role="main"]'),
          }
        }),
      { timeout: 3000 },
    )
    .toEqual({ isBody: false, inMain: true })
})

// 099 (LOW) — the canvas label tier is ZOOM-INVARIANT. `labelTierForWidth`
// (canvasResponsive.ts) derives the tier from the ring's ResizeObserver
// `contentRect` width, which is LAYOUT width and therefore UNCHANGED by React
// Flow's `transform: scale()` (the explicit 099-2c contract in canvasResponsive.ts
// and Canvas.tsx's `data-label-tier`). So changing the RF viewport zoom must NOT
// change the tier. Zoom IN from fit (scale < 1) to scale > 1 and assert the
// `.canvas-shell[data-label-tier]` on the design ring node is byte-stable.
test('the canvas label tier is stable across zoom (derived from layout width, not RF scale)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openThreeLaneCanvas(page)

  const shell = page.locator('.wc-node--design-ring .canvas-shell')
  await expect(shell).toBeVisible({ timeout: 15_000 })
  await waitForStableViewport(page)

  const tierBefore = await shell.getAttribute('data-label-tier')
  if (!tierBefore) throw new Error('design ring must expose a data-label-tier')

  // Zoom IN well past 1:1 (fit frames below 1:1). The layout width is untouched by
  // the transform, so the tier must not move off its fit-zoom value.
  const zoomIn = page.locator('.react-flow__controls-zoomin')
  for (let i = 0; i < 8; i++) await zoomIn.click()
  await expect.poll(() => viewportScale(page)).toBeGreaterThan(1)

  await expect(shell).toBeVisible()
  await expect(shell).toHaveAttribute('data-label-tier', tierBefore)
})

// 101 — the focus-pan is KEYBOARD-only: CLICKING an element the user can already
// see must NOT pan/center the viewport (only Tab/⌘-jump focus, which can target
// an off-screen cell, pans). NORMAL motion here on purpose so a real pan actually
// animates the transform (a reduced-motion duration-0 setCenter no-ops on an idle
// zoom — issue 096 — and would HIDE a regression).
const FOCUS_PAN_MARGIN_PX = 88

interface Box {
  x: number
  y: number
  width: number
  height: number
}
async function boxOf(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox()
  if (!b) throw new Error('element has no bounding box (not visible / not laid out)')
  return b
}

// Open the canvas and deterministically place the Foundation "Name a value
// proposition" phantom INSIDE the left pan-margin band (still hittable) by panning
// the empty pane the measured distance — the regime where the OLD focus-pan
// centred on interaction. (Zooming overshoots the phantom off-screen; native
// scroll can't reach it on a transformed plane.) All offsets are RELATIVE:
//   • land at HALF the margin from the edge → provably inside the band AND hittable;
//   • drag from ABOVE the measured lane row (midway pane-top → Foundation-top) →
//     reliably empty graph-paper, so the drag pans the pane, not a node.
// Returns the phantom locator, sitting in the margin, ready to click/tap.
async function panFoundationPhantomIntoLeftMargin(page: Page): Promise<Locator> {
  await openThreeLaneCanvas(page)
  await waitForStableViewport(page)
  const foundation = page.locator('.wc-node--foundation')
  const target = foundation.getByPlaceholder('Name a value proposition')
  await expect(target).toBeVisible()
  const pbox = await boxOf(page.locator('.workspace-canvas'))
  const fbox = await boxOf(foundation)
  const landingX = pbox.x + FOCUS_PAN_MARGIN_PX / 2
  const emptyY = pbox.y + (fbox.y - pbox.y) / 2
  const grabX = pbox.x + pbox.width / 2
  const panDx = (await boxOf(target)).x - landingX
  await page.mouse.move(grabX, emptyY)
  await page.mouse.down()
  await page.mouse.move(grabX - panDx, emptyY, { steps: 8 })
  await page.mouse.up()
  await waitForStableViewport(page)
  const tbox = await boxOf(target)
  const inLeftMargin = tbox.x < pbox.x + FOCUS_PAN_MARGIN_PX && tbox.x >= pbox.x
  expect(inLeftMargin, 'precondition: target must sit inside the left pan margin so the OLD code would pan').toBe(true)
  return target
}

// A focus-pan (if it wrongly fired) animates over FOCUS_PAN_DURATION (320ms);
// wait past it, then assert the viewport transform never moved.
async function expectNoPan(page: Page, before: string): Promise<void> {
  await page.waitForTimeout(650)
  expect(await viewportTransform(page), 'the interaction must not pan the canvas').toBe(before)
}

test('clicking a cell does NOT pan the viewport (focus-pan is keyboard-only)', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const target = await panFoundationPhantomIntoLeftMargin(page)
  const before = await viewportTransform(page)
  await target.click()
  await expectNoPan(page, before)
})

test('tapping a cell (touch) does NOT pan the viewport — the tablet-first case', { tag: '@dev-flag' }, async ({
  browser,
}) => {
  // Touch was the exact case a timer-based gate would misclassify (tap→focus can
  // span >1 frame); the persistent modality ref sets pointer on ANY pointerdown,
  // including touch. Needs a touch-enabled context.
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true })
  const page = await context.newPage()
  try {
    const target = await panFoundationPhantomIntoLeftMargin(page)
    const before = await viewportTransform(page)
    const b = await boxOf(target)
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2)
    await expectNoPan(page, before)
  } finally {
    await context.close()
  }
})

// ── 099 item #4 — TOUCH / TABLET (emulated). The canvas is the DEFAULT surface
// on iPad-landscape-class devices (~1024 CSS px, touch) by design (089 tablet-
// first), yet only ONE touch spec existed (`tapping a cell … does NOT pan`).
// These cover the faithfully-emulable touch slices — a single-finger touch-drag
// PANS the pane, a touch-drag on a table-node HEADER reorders it, and a tap
// FOCUSES an editable target — mirroring the existing passing mouse specs (the
// pan geometry of `panFoundationPhantomIntoLeftMargin`, the arch drag-reorder at
// its mouse twin above, the `page.touchscreen.tap` of the tap-no-pan spec).
// REAL multi-touch PINCH-ZOOM cannot be emulated with fidelity (it needs two
// tracked contact points + platform gesture recognition) — that stays the
// irreducible real-device manual remainder (see the 099 doc).

// A single-finger touch drag via CDP `Input.dispatchTouchEvent` — the high-
// fidelity path d3-zoom (React Flow's pan/drag engine) actually listens to.
// Playwright's `page.touchscreen` only exposes `tap`, so a swipe/drag needs the
// raw protocol. Coordinates are viewport CSS px (same basis as `boundingBox()`).
// touchEnd carries an empty touchPoints list (the sole contact is released).
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x, y: from.y }],
    })
    for (let i = 1; i <= steps; i++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * i) / steps,
            y: from.y + ((to.y - from.y) * i) / steps,
          },
        ],
      })
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await client.detach()
  }
}

// 099 item 4 — HELD (test.fixme) despite passing in CI: these 3 emulated-touch
// specs each spin up a fresh hasTouch browser context (two also open CDP sessions),
// which raised peak e2e-suite load enough to tip the documented, load-sensitive
// 100-D child-core mount-timing flake (`drilling α promotes a LIVE child core`,
// α1 toBeVisible) into losing all 3 retries two runs in a row. The CDP-touch
// approach is PROVEN to work in headless (all 3 passed); re-enable them in a
// dedicated/serial touch e2e lane so they don't contend with the canvas specs.
test.fixme('a single-finger touch-drag on the empty canvas pane pans the viewport', { tag: '@dev-flag' }, async ({
  browser,
}) => {
  // Touch counterpart of the mouse pan inside `panFoundationPhantomIntoLeftMargin`
  // (same empty-graph-paper grab region: midway between the pane top and the
  // Foundation lane row, horizontally centred). A one-finger drag on empty pane
  // must pan — proving the canvas is navigable by touch, not just mouse.
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true })
  const page = await context.newPage()
  try {
    await openThreeLaneCanvas(page)
    await waitForStableViewport(page)
    const pbox = await boxOf(page.locator('.workspace-canvas'))
    const fbox = await boxOf(page.locator('.wc-node--foundation'))
    const grabX = pbox.x + pbox.width / 2
    const grabY = pbox.y + (fbox.y - pbox.y) / 2 // provably-empty band above the lane
    const before = await viewportTransform(page)
    await touchDrag(page, { x: grabX, y: grabY }, { x: grabX + 260, y: grabY }, 14)
    await waitForStableViewport(page)
    expect(await viewportTransform(page), 'a single-finger touch-drag on empty pane must pan the viewport').not.toBe(
      before,
    )
  } finally {
    await context.close()
  }
})

test.fixme('a touch-drag on a table-node header reorders + persists sort (touch twin of the mouse drag-reorder)', { tag: '@dev-flag' }, async ({
  browser,
}) => {
  // Exact touch mirror of the mouse `dragging a table node down its lane reorders
  // + persists sort` spec above — same seed, same fit + settle, same drop target
  // (below Gamma → last), same derived-slot + column-invariant + reload-persist
  // assertions. The only difference is the drag is dispatched as touch events.
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, hasTouch: true })
  const page = await context.newPage()
  try {
    const projectId = await openThreeLaneCanvas(page)
    await addArchTable(page, 'Alpha')
    await addArchTable(page, 'Beta')
    await addArchTable(page, 'Gamma')
    await expect(page.locator('.wc-node--arch-table')).toHaveCount(3)

    await page.locator('.react-flow__controls-fitview').click()
    await waitForStableArchStack(page)

    const before = await archTablesByY(page)
    expect(before.names).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(new Set(before.xs).size).toBe(1)

    const alphaHandle = page
      .locator('.wc-node--arch-table')
      .filter({ hasText: 'Alpha' })
      .locator('.wc-node__handle')
    const gammaNode = page.locator('.wc-node--arch-table').filter({ hasText: 'Gamma' })
    const start = await boxOf(alphaHandle)
    const gammaBox = await boxOf(gammaNode)
    const startX = start.x + start.width / 2
    const startY = start.y + start.height / 2
    const dropY = gammaBox.y + gammaBox.height + 24 // below Gamma's center → last

    // A touch drag from the header, past Gamma. The interpolated moves cross React
    // Flow's node-drag threshold on the first few steps (as the mouse nudge does).
    await touchDrag(page, { x: startX, y: startY }, { x: startX, y: dropY }, 18)

    await expect
      .poll(async () => (await archTablesByY(page)).names)
      .toEqual(['Beta', 'Gamma', 'Alpha'])
    const afterDrop = await archTablesByY(page)
    expect(new Set(afterDrop.xs).size).toBe(1) // x invariant — lane stays vertical

    // PERSISTED — reload re-reads `sort` from PGlite; the touch reorder survives.
    await page.goto(`/p/${projectId}/design?d3rf=1`)
    await expect(page.locator('.wc-node--arch-table')).toHaveCount(3)
    await expect
      .poll(async () => (await archTablesByY(page)).names)
      .toEqual(['Beta', 'Gamma', 'Alpha'])
    const afterReload = await archTablesByY(page)
    expect(new Set(afterReload.xs).size).toBe(1)
  } finally {
    await context.close()
  }
})

test.fixme('tapping the Foundation phantom (touch) focuses it — tap-to-activate on the canvas', { tag: '@dev-flag' }, async ({
  browser,
}) => {
  // The positive counterpart of the `tapping a cell … does NOT pan` spec: same
  // `panFoundationPhantomIntoLeftMargin` setup + `page.touchscreen.tap`, asserting
  // the tap lands ON the target (it becomes the focused editing surface). Proves
  // tap-to-select/activate reaches a node's editable content through touch.
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true })
  const page = await context.newPage()
  try {
    const target = await panFoundationPhantomIntoLeftMargin(page)
    const b = await boxOf(target)
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2)
    await expect(target).toBeFocused()
  } finally {
    await context.close()
  }
})

// ── 099 — port two behaviours that today only run on the WorkspaceSurface
// fallback onto the REAL React Flow canvas wiring. Both use the canvas register
// (the `?d3rf` authoring surface) to seed contexts, since the on-ring compose
// flow the fallback specs rely on was dropped in 093.

// Open the canvas + seed exactly two dimensions, each with one parameter, via
// the Design register node — the minimum a bound context needs (one bindable
// parameter per dimension). Mirrors `openCanvasWithCoverageData`'s register
// seeding (force-click past the transformed pane, index the param phantoms in
// dim order), trimmed to a 2×1 space. Returns the projectId.
async function openCanvasTwoDimsOneParam(page: Page): Promise<string> {
  const projectId = await openThreeLaneCanvas(page)
  const register = page.locator('.wc-node--design-register')
  await expect(register.locator('.context-register-shell')).toBeVisible({ timeout: 15_000 })
  async function addDim(name: string) {
    const p = register.getByPlaceholder('Type to add a dimension')
    await p.fill(name)
    await p.press('Enter')
    await expect(register.locator('.dim-row__name', { hasText: name })).toBeVisible()
  }
  await addDim('Value')
  await addDim('Stake')
  async function addParam(dimIndex: number, param: string) {
    const p = register.getByPlaceholder('Type to add a parameter').nth(dimIndex)
    await p.click({ force: true })
    await p.pressSequentially(param)
    await page.keyboard.press('Enter')
    await expect(register.getByText(param, { exact: true })).toBeVisible()
  }
  await addParam(0, 'Comfort')
  await addParam(1, 'Users')
  return projectId
}

// Create a fully-bound context α on the CURRENT canvas via GUIDED COMPOSE. At
// fit-view zoom the register is LOD-collapsed to a single Tuple column (093), so
// its per-dimension combobox columns don't exist — but entering compose (`c`)
// force-expands the register to the full per-dimension columns regardless of
// zoom (the 089-P5 review-fix, its own test above) WITHOUT re-zooming, so the
// ring stays framed. `c` composes the draft α; bind both dimensions via their
// combobox cells (column order Symbol=0, Documented=1, Value=2, Stake=3 — the
// combobox binding mirrors canvas-selection.spec.ts's `createAndBindAlpha`),
// then Escape keeps the draft. A fully-bound α is required so its child canvas
// seeds dimensions from α's bindings (openChildCanvas).
async function createBoundAlpha(page: Page): Promise<void> {
  const ring = page.locator('.wc-node--design-ring')
  const register = page.locator('.wc-node--design-register')
  await ring.locator('.canvas-svg').click()
  await waitForStableViewport(page)
  await page.keyboard.press('c')

  // Compose force-expands the register to the per-dimension combobox columns.
  await expect(register.getByRole('columnheader', { name: 'Value', exact: true })).toBeVisible()
  const row = register.locator('.editable-grid tbody tr.grid-row--selected')
  await expect(row).toHaveCount(1)

  async function bind(cellIndex: number, paramName: string) {
    const cell = row.locator('td').nth(cellIndex)
    await cell.getByRole('button').click({ force: true })
    await page.getByPlaceholder('Type to filter…').fill(paramName)
    await page.keyboard.press('Enter')
    await expect(cell).toContainText(paramName)
  }
  await bind(2, 'Comfort')
  await bind(3, 'Users')
  await page.keyboard.press('Escape') // exit compose, keep the (now-bound) draft
  await expect(register.getByText('α', { exact: true })).toBeVisible()
}

// 099 (canvas) — the child-canvas dual-empty-state suppression, ported from the
// fallback (design-layout.spec.ts "child canvas needing sub-parameters shows
// exactly one empty-state prompt"). On the canvas the wiring lives across two
// nodes: the register node renders the `.canvas-seed-hint` (DesignRegisterBody)
// and the ring node stamps `data-suppress-canvas-empty` on `.design-core-ring`
// (DesignRingBody), which the base.css rule uses to hide Canvas's own always-on
// `.canvas-empty-prompt`. Never both voices at once. Issue 100 Phase D — drilling
// α now mounts a LIVE child core in place (no navigate); the child inherits α's
// two dimensions but has no sub-parameters yet (the needs-seeding state), so the
// assertions run against the CHILD core (the second register/ring pair).
test('child core (canvas): the child ring suppresses its own empty prompt while the child register shows the seed-hint', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openCanvasTwoDimsOneParam(page)
  await createBoundAlpha(page)

  // Drill α → a LIVE child core mounts beside the parent (its canvas seeds α's two
  // dimensions from α's bindings, but has zero sub-parameters yet).
  await waitForStableViewport(page)
  const parentRegister = page.locator('.wc-node--design-register').nth(0)
  await parentRegister.locator('.children-drill').first().click()
  await expect(page.locator('.wc-node--design-register')).toHaveCount(2)

  // The CHILD core's register node speaks the ONE calm empty-state voice: seed-hint.
  const childRegister = page.locator('.wc-node--design-register').nth(1)
  await expect(childRegister.locator('.canvas-seed-hint')).toBeVisible()

  // The CHILD core's ring node suppresses Canvas's own always-on prompt:
  // `.design-core-ring` carries the suppress flag, so the prompt is present in the
  // DOM (Canvas.tsx always renders it while there are no contexts) but HIDDEN.
  const childRing = page.locator('.wc-node--design-ring').nth(1)
  await expect(childRing.locator('.design-core-ring')).toHaveAttribute('data-suppress-canvas-empty', 'true')
  await expect(childRing.locator('.canvas-empty-prompt')).toHaveCount(1)
  await expect(childRing.locator('.canvas-empty-prompt')).toBeHidden()
  // The lineage line was dropped outright (DesignRingBody never passes `lineage`
  // to Canvas) — it never enters the DOM at all.
  await expect(childRing.locator('.canvas-empty-lineage')).toHaveCount(0)
})

// 099 (canvas) — hover-emphasis/mute on the canvas RING at node scale, ported
// from the fallback (canvas-focus.spec.ts "hovering a context node mutes the
// unrelated context and both arcs"). The fallback drove the on-ring `New
// context` compose flow that 093 removed, so contexts are seeded via the
// register instead: α fully bound, β left unbound (shares no binding with α, so
// α's context-emphasis mutes it). Context-role emphasis lights no arcs, so every
// arc mutes; α binds both seeded dots, so no dot-group mutes. All assertions are
// scoped under `.wc-node--design-ring` — this is the canvas wiring, not the
// fallback surface.
test('hover-mute works on the canvas ring: hovering a context mutes the unrelated context and both arcs', { tag: '@dev-flag' }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await openCanvasTwoDimsOneParam(page)
  await createBoundAlpha(page)

  // A second context β via the register phantom — left UNBOUND, so it shares no
  // binding with the fully-bound α (α's adjacency won't include it).
  const register = page.locator('.wc-node--design-register')
  await register.getByPlaceholder('New context').click()
  await page.keyboard.type('second justification')
  await page.keyboard.press('Enter')
  await expect(register.getByText('β', { exact: true })).toBeVisible()

  const ring = page.locator('.wc-node--design-ring')
  await expect(ring.locator('.canvas-svg')).toBeVisible()
  // Both contexts render as ring nodes.
  await expect(ring.locator('.canvas-node[data-context-id]')).toHaveCount(2)

  // Settle the initial fitView before any hover — the race the helper guards.
  await waitForStableViewport(page)

  // Resting state: clear any selection (click the ring background corner) so we
  // test hover-only emphasis, not a locked selection's own view.
  await ring.locator('.canvas-svg').click({ position: { x: 8, y: 8 } })
  await expect(ring.locator('.canvas--muted')).toHaveCount(0)

  // Hover α's node (the fully-bound one, symbol α). Both contexts stay in the
  // DOM; α's context emphasis mutes the unrelated β and every arc, but no dot
  // (α binds both seeded dots).
  const alphaNode = ring.locator('.canvas-node[data-context-id]', {
    has: page.getByText('α', { exact: true }),
  })
  await alphaNode.hover()
  await expect(ring.locator('.canvas-node.canvas--muted')).toHaveCount(1) // β mutes, α does not
  await expect(ring.locator('.canvas-arc-group.canvas--muted')).toHaveCount(2) // context role lights no arcs
  await expect(ring.locator('.canvas-dot-group.canvas--muted')).toHaveCount(0) // α binds both seeded dots

  // Leaving clears every mute.
  await page.mouse.move(8, 8)
  await expect(ring.locator('.canvas--muted')).toHaveCount(0)
})
