import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { forceWorkspaceSurface } from './workspaceSurface'

// Issue 014, test-first plan item 5: build the example's Architecture tables,
// promote them into 3rd-Tier dimensions, and confirm the link is live in both
// directions — the register combobox offers the promoted parameters, and
// renaming a 2nd-Tier entry propagates to its parameter (invariant 7).

function tablePanel(page: Page, tableName: string) {
  return page.locator('.t2-table', {
    has: page.locator('.t2-table__name', { hasText: tableName }),
  })
}

async function addTable(page: Page, name: string) {
  // Issue 084 (D1): the create control is the stable top add-row's typed
  // input ("Name a table"), no longer the trailing "Add table" ghost.
  const ghost = page.getByPlaceholder('Name a table')
  await ghost.fill(name)
  await ghost.press('Enter')
  await expect(page.locator('.t2-table__name', { hasText: name })).toBeVisible()
}

async function addEntry(page: Page, tableName: string, entryName: string) {
  const panel = tablePanel(page, tableName)
  const phantom = panel.getByPlaceholder('Name an entry')
  await phantom.fill(entryName)
  await phantom.press('Enter')
  await expect(panel.getByRole('cell', { name: entryName, exact: true })).toBeVisible()
}

async function promoteTable(page: Page, tableName: string, entryNames: string[], dimensionName: string) {
  const panel = tablePanel(page, tableName)
  for (const name of entryNames) {
    await panel.getByRole('option', { name: `Select ${name}` }).click()
  }
  await expect(panel.getByText(`${entryNames.length} selected`)).toBeVisible()
  await panel.getByRole('button', { name: 'Use as dimension…' }).click()
  const nameField = page.getByLabel('New dimension name')
  await nameField.fill(dimensionName)
  await expect(
    page.getByText(new RegExp(`Creates ${entryNames.length} parameters? on ${dimensionName}`)),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Promote' }).click()
  await expect(page.getByText(`${entryNames.length} selected`)).toBeHidden()
}

test('architecture: build tables, promote to dimensions, register offers params, rename propagates', async ({
  page,
}) => {
  // 089-P7: builds/promotes tables on the stacked `.t2-table` Architecture
  // surface and reads the Design register — WorkspaceSurface flow. Pin to it.
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()

  await page.getByRole('link', { name: 'Architecture' }).click()
  await expect(page.getByText('2nd Tier · Architecture')).toBeVisible()

  // A canvas needs ≥ 2 dimensions, so promote two tables (Value + Stakeholders).
  await addTable(page, 'Value')
  await addEntry(page, 'Value', 'Comfort')
  await promoteTable(page, 'Value', ['Comfort'], 'Value')

  await addTable(page, 'Stakeholders')
  await addEntry(page, 'Stakeholders', 'Buyers')
  await addEntry(page, 'Stakeholders', 'Maintainer')
  await addEntry(page, 'Stakeholders', 'Users')
  await promoteTable(page, 'Stakeholders', ['Buyers', 'Maintainer', 'Users'], 'Stake')

  // The promoted entries carry the mirrored source badge (both sides visible).
  await expect(tablePanel(page, 'Stakeholders').getByText('→ Stake').first()).toBeVisible()

  // Design tab: two dimensions exist, so the register renders. Its Stake column
  // combobox now offers the promoted parameters.
  await page.getByRole('link', { name: 'Design' }).click()
  const registerPhantom = page.getByPlaceholder(/Type to create your first context — it becomes α|New context/)
  await registerPhantom.click()
  await page.keyboard.type('Stake reflects the primary beneficiaries')
  await page.keyboard.press('Enter')

  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  // Column order: Symbol(0) · Documented(1) · Value(2) · Stake(3) · …
  const stakeCell = row.locator('td').nth(3)
  await stakeCell.getByRole('button').click()
  await expect(page.getByPlaceholder('Type to filter…')).toBeVisible()
  // `exact` targets the cmdk combobox items precisely: the co-mounted
  // Architecture lane (084-D3 P4) now exposes `role="option"` select controls
  // named "Select Buyers"/… which a substring match would also catch.
  await expect(page.getByRole('option', { name: 'Buyers', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Maintainer', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Users', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  // Rename "Users" in the Architecture tab → propagates to its parameter.
  await page.getByRole('link', { name: 'Architecture' }).click()
  const usersCell = tablePanel(page, 'Stakeholders').getByRole('cell', { name: 'Users', exact: true })
  await usersCell.click()
  await page.locator('input:focus').fill('People')
  await page.keyboard.press('Enter')
  await expect(tablePanel(page, 'Stakeholders').getByRole('cell', { name: 'People', exact: true })).toBeVisible()
  await expect(page.locator('.status-bar')).toContainText(/parameter updated/)

  // Back on Design: the register's Stake combobox now offers "People" — live,
  // with NO reload. In the 089 D2 co-mount model the Design lane is already
  // mounted, so the Architecture-lane rename's invariant-7 parameter update
  // refreshes it through the local-apply signal (tier2.renameEntry →
  // useSyncStore.notifyLocalApply), not a remount.
  await page.getByRole('link', { name: 'Design' }).click()
  const rowAfter = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await rowAfter.locator('td').nth(3).getByRole('button').click()
  await expect(page.getByPlaceholder('Type to filter…')).toBeVisible()
  // `exact` again isolates the cmdk items from the co-mounted Architecture
  // lane's "Select …" options (084-D3 P4).
  await expect(page.getByRole('option', { name: 'People', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Users', exact: true })).toBeHidden()
})

// Issue 025, test-first plan item 3: the selection bar/promote trigger must
// stay reachable near the top of a tall table without scrolling to its end.
test('architecture: selection bar stays in view (sticky) on a tall table without scrolling to the bottom', async ({
  page,
}) => {
  // Pin to WorkspaceSurface: `position: sticky` + in-viewport on native page
  // scroll is a WorkspaceSurface-fallback behavior; the canvas pans/zooms rather
  // than native-scrolls (issue 025 guard belongs on the fallback surface).
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()

  await page.getByRole('link', { name: 'Architecture' }).click()
  await expect(page.getByText('2nd Tier · Architecture')).toBeVisible()

  await addTable(page, 'Stakeholders')
  // A tall table — enough rows that end-of-list flow would push the
  // selection bar far below the fold (design brief, done/025).
  const entryNames = Array.from({ length: 30 }, (_, i) => `Entry ${i + 1}`)
  for (const name of entryNames) await addEntry(page, 'Stakeholders', name)

  const panel = tablePanel(page, 'Stakeholders')
  // Select the first entry — at the very top of a table dozens of rows tall
  // — without scrolling the page at all.
  await panel.getByRole('option', { name: 'Select Entry 1', exact: true }).click()

  const promoteTrigger = page.getByRole('button', { name: 'Use as dimension…' })
  await expect(promoteTrigger).toBeVisible()
  // The sticky positioning (base.css `.t2-selection-bar { position: sticky }`)
  // means this is reachable without any scroll — assert it's actually within
  // the viewport, not merely present in the DOM off-screen.
  await expect(promoteTrigger).toBeInViewport()
})

// ───────────────────────────────────────────────────────────────────────────
// Issue 084 Direction 3 — P6: e2e + a11y sweep. The stacked-per-table grid
// threaded by one outer chain (P1/P2) must be fully keyboard-operable end to
// end, its promote multi-select must expose real listbox/option semantics
// (P4), the quiet shortcut hints must reveal on focus and hide at rest (P5),
// and the whole structure must stay responsive at volume (risk 3).
// ───────────────────────────────────────────────────────────────────────────

/** Fresh empty project on the Architecture route (typed create, no seed). */
async function openArchitecture(page: Page, projectName: string) {
  // 089-P7: these P6 specs assert the stacked `.t2-table` Architecture panels
  // (forward cross-table keyboard threading, the promote listbox + `<main>` axe
  // scope, `.key-hint` reveal-on-focus) — the WorkspaceSurface tier surface. The
  // canvas decomposes Architecture into per-table RF nodes (covered by
  // d3-canvas.spec.ts). Pin to the fallback surface.
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill(projectName)
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: `Open ${projectName}` }).click()
  await page.getByRole('link', { name: 'Architecture' }).click()
  await expect(page.getByText('2nd Tier · Architecture')).toBeVisible()
}

/**
 * A valid FORMAT_VERSION 5 `.gede.json` envelope with `nTables` Architecture
 * tables, each holding `nEntries` top-level entries. Ids are opaque strings —
 * the importer remaps every id/FK via uuidv7 and stamps the target workspace —
 * so they only need to be internally consistent (FK checks pass). All ten
 * envelope arrays must be present; the unused layers are empty. (Schema:
 * src/domain/projectEnvelope.ts.)
 */
function makeVolumeFixture(nTables: number, nEntries: number) {
  const now = new Date().toISOString()
  const tier2_tables: unknown[] = []
  const tier2_entries: unknown[] = []
  for (let t = 0; t < nTables; t++) {
    const tableId = `tbl-${t}`
    tier2_tables.push({
      id: tableId,
      projectId: 'proj-0',
      workspaceId: null,
      name: `Table ${t + 1}`,
      sort: t,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    for (let e = 0; e < nEntries; e++) {
      tier2_entries.push({
        id: `${tableId}-e${e}`,
        tableId,
        workspaceId: null,
        parentId: null,
        name: `T${t + 1} Entry ${e + 1}`,
        description: null,
        sort: e,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
    }
  }
  return {
    formatVersion: 5,
    tables: {
      projects: [
        {
          id: 'proj-0',
          workspaceId: null,
          name: 'Volume',
          description: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      ],
      canvases: [],
      tier1_purpose: [],
      tier1_props: [],
      tier2_tables,
      tier2_entries,
      dimensions: [],
      parameters: [],
      contexts: [],
      bindings: [],
    },
  }
}

test('architecture P6: builds tables and threads focus across them entirely from the keyboard', async ({
  page,
}) => {
  await openArchitecture(page, 'Keys')

  // Enter the grammar with no mouse: focus the trailing add-table phantom and
  // create two tables with Enter (commit + self-refocus).
  const addTable = page.getByPlaceholder('Name a table')
  await addTable.focus()
  await expect(addTable).toBeFocused()
  await page.keyboard.type('Alpha')
  await page.keyboard.press('Enter')
  await expect(page.locator('.t2-table__name', { hasText: 'Alpha' })).toBeVisible()
  await page.keyboard.type('Beta')
  await page.keyboard.press('Enter')
  await expect(page.locator('.t2-table__name', { hasText: 'Beta' })).toBeVisible()

  const alpha = tablePanel(page, 'Alpha')
  const beta = tablePanel(page, 'Beta')

  // Fill one entry in Alpha from its add-entry phantom, which then clears +
  // refocuses (Numbers grammar) — leaving the empty phantom at Alpha's boundary.
  await alpha.getByPlaceholder('Name an entry').focus()
  await page.keyboard.type('a1')
  await page.keyboard.press('Enter')
  await expect(alpha.getByRole('cell', { name: 'a1', exact: true })).toBeVisible()

  // Tab off Alpha's (now empty) add-entry phantom → forward exit boundary →
  // Beta's first editable position (Beta is empty, so its add-entry phantom).
  await expect(alpha.getByPlaceholder('Name an entry')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(beta.getByPlaceholder('Name an entry')).toBeFocused()

  // Tab off the LAST table's phantom → the trailing add-table phantom.
  await page.keyboard.press('Tab')
  await expect(addTable).toBeFocused()

  // Type a name + Tab in the add-table phantom → creates the table AND lands
  // focus inside the freshly-created (empty) table's first entry phantom.
  await page.keyboard.type('Gamma')
  await page.keyboard.press('Tab')
  const gamma = tablePanel(page, 'Gamma')
  await expect(page.locator('.t2-table__name', { hasText: 'Gamma' })).toBeVisible()
  await expect(gamma.getByPlaceholder('Name an entry')).toBeFocused()
  // (The reverse Shift+Tab chain — first-data-cell → previous table's phantom —
  // is covered on the canvas by d3-canvas.spec.ts; the forward add-table →
  // fill → next-table → add-table → new-table sequence above is the P2/P6
  // headline for the normal surface.)
})

test('architecture P6: the promote multi-select is a labeled listbox of options with real aria-selected, and axe-clean', async ({
  page,
}) => {
  await openArchitecture(page, 'Roles')
  await addTable(page, 'Roles')
  await addEntry(page, 'Roles', 'Admin')
  await addEntry(page, 'Roles', 'Editor')

  const panel = tablePanel(page, 'Roles')

  // The multi-select semantics: a labeled listbox owning per-entry options.
  const listbox = panel.getByRole('listbox', { name: 'Select Roles entries to promote' })
  await expect(listbox).toBeAttached()
  await expect(listbox).toHaveAttribute('aria-multiselectable', 'true')

  const adminOption = panel.getByRole('option', { name: 'Select Admin' })
  const editorOption = panel.getByRole('option', { name: 'Select Editor' })
  // aria-selected is a real boolean, present on both — false at rest.
  await expect(adminOption).toHaveAttribute('aria-selected', 'false')
  await expect(editorOption).toHaveAttribute('aria-selected', 'false')

  // Selecting flips only that option's aria-selected to true.
  await adminOption.click()
  await expect(adminOption).toHaveAttribute('aria-selected', 'true')
  await expect(editorOption).toHaveAttribute('aria-selected', 'false')
  await expect(panel.getByText('1 selected')).toBeVisible()

  // No serious/critical a11y violations on the composed Architecture surface
  // (with a live selection + the promote affordance shown).
  const results = await new AxeBuilder({ page })
    .include('main')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  expect(blocking, JSON.stringify(blocking.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([])
})

test('architecture P6: the quiet keyboard hints reveal on focus and are hidden at rest', async ({
  page,
}) => {
  await openArchitecture(page, 'Hints')
  await addTable(page, 'Roles')
  await addEntry(page, 'Roles', 'Admin')

  const panel = tablePanel(page, 'Roles')

  // Add-table phantom: its ⏎ hint is hidden at rest (visibility:hidden), shown
  // only on focus-within (the .row-action reveal pattern) — the chips are
  // aria-hidden either way, so this is CSS visibility, asserted via computed style.
  const addTableHint = page.locator('.t2-add-table .key-hint')
  await expect
    .poll(() => addTableHint.evaluate((el) => getComputedStyle(el).visibility))
    .toBe('hidden')
  await page.getByPlaceholder('Name a table').focus()
  await expect(page.locator('.t2-add-table .key-hint__cap', { hasText: '⏎' })).toBeVisible()

  // Editing a text cell shows the Tab →/Esc chips inline at the cell's end.
  await panel.getByRole('cell', { name: 'Admin', exact: true }).click()
  await expect(page.locator('input:focus')).toBeVisible()
  const editHints = page.locator('.grid-cell__editing .key-hint__cap')
  await expect(editHints.filter({ hasText: 'Tab' })).toBeVisible()
  await expect(editHints.filter({ hasText: '→' })).toBeVisible()
  await expect(editHints.filter({ hasText: 'Esc' })).toBeVisible()

  // Escape commits/cancels back to the display cell → the editing chips are gone.
  await page.keyboard.press('Escape')
  await expect(page.locator('.grid-cell__editing')).toHaveCount(0)
})

test('architecture P6: renders and stays operable at volume (~20 tables × ~50 entries)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  // 089-P7: asserts all 20 `.t2-table` panels mount (no LOD summarisation) and
  // cross-table keyboard threading — the WorkspaceSurface Architecture surface.
  // Pin to it (canvas volume/LOD is covered by d3-canvas.spec.ts).
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  // Bulk-seed via the supported import path — 1000 entries via the UI would be
  // prohibitively slow. The fixture is a valid v5 envelope (import remaps ids).
  await page.locator('input[type="file"]').setInputFiles({
    name: 'Volume.gede.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(makeVolumeFixture(20, 50))),
  })
  await page.getByRole('button', { name: 'Open Volume' }).click()
  await page.getByRole('link', { name: 'Architecture' }).click()
  await expect(page.getByText('2nd Tier · Architecture')).toBeVisible()

  // All 20 tables mount (one stacked EditableGrid each — D3 adds no per-row
  // mount over today's N TablePanels, only one O(tables) chain provider).
  await expect(page.locator('.t2-table')).toHaveCount(20, { timeout: 30_000 })
  const last = tablePanel(page, 'Table 20')
  await expect(last.getByRole('cell', { name: 'T20 Entry 50', exact: true })).toBeVisible()

  // Opening a cell deep in the last table is responsive (editor mounts fast) —
  // the perf-at-volume risk (risk 3) retired against the real surface.
  const cell = last.getByRole('cell', { name: 'T20 Entry 50', exact: true })
  const t0 = Date.now()
  await cell.click()
  await expect(page.locator('input:focus')).toBeVisible()
  const openMs = Date.now() - t0
  expect(openMs, `cell-open at volume took ${openMs}ms`).toBeLessThan(3_000)
  await page.keyboard.press('Escape')

  // Cross-table keyboard focus still threads at volume: Tab off table 20's
  // add-entry phantom lands on the trailing add-table phantom (last boundary).
  await last.getByPlaceholder('Name an entry').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByPlaceholder('Name a table')).toBeFocused()
})

// Issue 102 — "Add child does nothing" when a rich-text DESCRIPTION cell in the
// same table is mid-edit. RichTextCell deliberately keeps `editing` on blur (so
// clicking the FormatStrip doesn't collapse the cell), so its Lexical editor
// stays mounted and fights the add-child phantom's autoFocus; the phantom's
// blur-cancel then dismisses it in the same frame. The fix exits any active edit
// when the phantom arms. RED before the fix (the phantom never appears / vanishes
// instantly), GREEN after.
// FIXME(102): RED — reproduces the reported bug. "Add child" produces no child
// phantom while a rich-text DESCRIPTION cell in the same table is mid-edit
// (exiting the edit first restores it). `test.fixme` so the repro is captured
// but does not fail CI until the fix lands. See docs/issues/102.
test('architecture 102: Add child works even while a description cell is being edited', async ({ page }) => {
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Repro102')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Repro102' }).click()
  await page.getByRole('link', { name: 'Architecture' }).click()
  await addTable(page, 'Value')
  await addEntry(page, 'Value', 'Comfort')

  const panel = tablePanel(page, 'Value')
  const comfortRow = panel.locator('tr', { has: page.getByRole('cell', { name: 'Comfort', exact: true }) })

  // Open + type into the rich-text description cell — do NOT commit/exit first.
  await comfortRow.getByRole('cell').nth(2).click()
  await page.locator('[contenteditable="true"]:focus').pressSequentially('Seating comfort')

  // With the description still in edit mode, click Add child.
  await comfortRow.hover()
  await panel.getByRole('button', { name: 'Add child to Comfort' }).click()

  // The child phantom must appear AND survive (the focus fight used to kill it).
  const childField = page.getByPlaceholder('Name a child of Comfort')
  await expect(childField).toBeVisible({ timeout: 2000 })
  await page.waitForTimeout(500)
  await expect(childField).toBeVisible()

  // And it must be usable: type a name + Enter creates the child under Comfort.
  await childField.fill('Legroom')
  await childField.press('Enter')
  await expect(panel.getByRole('cell', { name: 'Legroom', exact: true })).toBeVisible()
  // The description edit was preserved (committed on blur), not lost.
  await expect(comfortRow.getByText('Seating comfort')).toBeVisible()
})

// Issue 102 (adversarial-review follow-up) — the SAME "phantom flashes then
// vanishes" class also reached the plain-text NAME cell via a different path: a
// changed text value commits ASYNC on blur, so its `advance(null)` runs a tick
// later and queues a focus target (`pendingFocus`) that steals focus from the
// just-mounted add-child phantom. The arm effect clears the queued-focus refs, so
// add-child must survive being clicked while a CHANGED name cell is mid-edit too.
test('architecture 102b: Add child works while a CHANGED name cell is being edited', async ({ page }) => {
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Repro102b')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Repro102b' }).click()
  await page.getByRole('link', { name: 'Architecture' }).click()
  await addTable(page, 'Value')
  await addEntry(page, 'Value', 'Comfort')

  const panel = tablePanel(page, 'Value')
  // Locate the row positionally — the name cell becomes an input mid-edit, so a
  // by-cell-text locator would stop matching once we type into it.
  const comfortRow = panel.locator('tbody tr').first()

  // Open the NAME cell and CHANGE it (async commit-on-blur) — do NOT commit first.
  await panel.getByRole('cell', { name: 'Comfort', exact: true }).click()
  const nameInput = page.locator('input:focus')
  await nameInput.fill('Comfortable')

  // With the changed name still mid-edit, click Add child (name uncommitted, so
  // the entry — and the button's aria-label — is still "Comfort").
  await comfortRow.hover()
  await panel.getByRole('button', { name: /Add child to Comfort/ }).click()

  const childField = page.getByPlaceholder(/Name a child of Comfort/)
  await expect(childField).toBeVisible({ timeout: 2000 })
  await page.waitForTimeout(500)
  await expect(childField).toBeVisible()
  // The name edit committed, not lost.
  await expect(panel.getByRole('cell', { name: 'Comfortable', exact: true })).toBeVisible()
})

// Issue 104 — shared setup: a project on the Architecture surface with one table
// ("Value") holding one entry ("Comfort"). Returns the table panel + the Comfort
// row locator, ready for the add-child / edit-height assertions below.
async function setup104(page: Page, projectName: string) {
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill(projectName)
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: `Open ${projectName}` }).click()
  await page.getByRole('link', { name: 'Architecture' }).click()
  await addTable(page, 'Value')
  await addEntry(page, 'Value', 'Comfort')
  const panel = tablePanel(page, 'Value')
  const comfortRow = panel.locator('tr', {
    has: page.getByRole('cell', { name: 'Comfort', exact: true }),
  })
  return { panel, comfortRow }
}

// Issue 104 Facet 3(a) — CONTINUOUS, NON-BLOCKING add-child (owner decision C):
// with the add-child phantom armed, clicking ANOTHER cell must cleanly DISMISS the
// phantom and edit that cell (no dead click). Before the fix, 102's `armed`
// suppression blocked all editing while the phantom was up. "Whichever the user
// did LAST wins": here the click wins, so the phantom goes and the cell edits.
test('architecture 104 (facet 3a): clicking a cell while add-child is armed dismisses it and edits that cell', async ({
  page,
}) => {
  const { panel, comfortRow } = await setup104(page, 'Repro104a')

  // Arm the add-child phantom under Comfort.
  await comfortRow.hover()
  await panel.getByRole('button', { name: 'Add child to Comfort' }).click()
  const childField = page.getByPlaceholder('Name a child of Comfort')
  await expect(childField).toBeVisible()

  // Click Comfort's Description cell — the add-child phantom must dismiss…
  await comfortRow.getByRole('cell').nth(2).click()
  await expect(childField).toBeHidden()

  // …and that cell must edit normally (its live editor is up + typeable).
  const editor = page.locator('[contenteditable="true"]:focus')
  await expect(editor).toBeVisible({ timeout: 2000 })
  await editor.pressSequentially('Seating')
  // Commit the rich-text edit (⌘/Ctrl+Enter is the richtext seam) and verify.
  await editor.press('ControlOrMeta+Enter')
  await expect(comfortRow.getByText('Seating')).toBeVisible()
})

// Issue 104 Facet 3(b) — Tab from the add-child field must rotate WITHIN the grid
// (commit the current input, then land focus in a grid cell), not fall through to
// browser-default focus movement. Before the fix the add-child PhantomInput had no
// chain wiring, so Tab left the grid entirely.
test('architecture 104 (facet 3b): Tab from the add-child field lands in a grid cell, not the browser chrome', async ({
  page,
}) => {
  const { panel, comfortRow } = await setup104(page, 'Repro104b')

  await comfortRow.hover()
  await panel.getByRole('button', { name: 'Add child to Comfort' }).click()
  const childField = page.getByPlaceholder('Name a child of Comfort')
  await expect(childField).toBeFocused()

  // Type a name, then Tab: the continuous-non-blocking contract is "Tab COMMITS
  // the current input (creates the child) and moves into the grid". Browser-
  // default Tab would instead drop the typed value uncommitted.
  await childField.fill('Legroom')
  await childField.press('Tab')

  // The child was created (the input committed, not lost to a native tab-out).
  await expect(panel.getByRole('cell', { name: 'Legroom', exact: true })).toBeVisible()
  // Focus landed on a grid cell/field inside THIS table panel — never on <body>
  // (the browser-default fallthrough).
  const focus = await page.evaluate(() => {
    const el = document.activeElement
    return {
      isBody: el === document.body || el === null,
      inPanel: !!el?.closest('.t2-table'),
    }
  })
  expect(focus.isBody).toBe(false)
  expect(focus.inPanel).toBe(true)
  // The phantom exited add mode.
  await expect(childField).toBeHidden()
})

// Issue 104 Facet 1 — a description cell in edit mode must NOT balloon to the
// register-justification 72px floor; it starts near the row's rest height (one
// line) and grows with content. Assert the editing rich-text cell stays well under
// the old 72px jump for short/empty content.
test('architecture 104 (facet 1): editing a short description does not balloon the row to ~72px', async ({
  page,
}) => {
  const { comfortRow } = await setup104(page, 'Repro104c')

  const descCell = comfortRow.getByRole('cell').nth(2)
  await descCell.click()
  // The live editor is up; measure the editing rich-text cell height.
  const editingCell = comfortRow.locator('.grid-cell--richtext')
  await expect(editingCell).toBeVisible()
  const box = await editingCell.boundingBox()
  if (!box) throw new Error('editing rich-text cell has no bounding box')
  // One line + padding is well under the old 72px min-height floor.
  expect(box.height).toBeLessThan(60)
})

// Issue 104 LOW-polish edge tests (from the adversarial review). These lock in the
// four boundary behaviors of the continuous-non-blocking add-child phantom so a
// future refactor of the arm/edit mutual-exclusion (102) or the dismissOnBlur
// blur-cancel decoupling (104 Facet 3a) can't silently regress them.

// (a) Escape must still dismiss the phantom even though dismissOnBlur=false removed
// the blur→cancel path (104 Facet 3a). Escape routes through PhantomInput's own
// keydown → onCancel, independent of blur.
test('architecture 104 (edge a): Escape dismisses the add-child phantom with dismissOnBlur=false', async ({
  page,
}) => {
  const { panel, comfortRow } = await setup104(page, 'Repro104d')

  await comfortRow.hover()
  await panel.getByRole('button', { name: 'Add child to Comfort' }).click()
  const childField = page.getByPlaceholder('Name a child of Comfort')
  await expect(childField).toBeFocused()

  // Type a partial name, then Escape — the phantom dismisses and nothing is created.
  await childField.fill('Draft')
  await childField.press('Escape')
  await expect(childField).toBeHidden()
  await expect(panel.getByRole('cell', { name: 'Draft', exact: true })).toBeHidden()
})

// (b) Clicking a PLAIN-TEXT cell (the Name column, kind: 'text') while armed must
// also dismiss+edit — the same "last action wins" contract as the rich-text case
// (3a), but through the input editor path rather than the Lexical one.
test('architecture 104 (edge b): clicking a plain-text cell while armed dismisses it and edits that cell', async ({
  page,
}) => {
  const { panel, comfortRow } = await setup104(page, 'Repro104e')

  await comfortRow.hover()
  await panel.getByRole('button', { name: 'Add child to Comfort' }).click()
  const childField = page.getByPlaceholder('Name a child of Comfort')
  await expect(childField).toBeVisible()

  // Click Comfort's Name cell (index 1: tree=0, name=1, description=2). The phantom
  // dismisses and the name cell opens its plain-text editor, focused with the value.
  await comfortRow.getByRole('cell').nth(1).click()
  await expect(childField).toBeHidden()
  const nameInput = page.locator('input:focus')
  await expect(nameInput).toBeVisible({ timeout: 2000 })
  await expect(nameInput).toHaveValue('Comfort')
})

// (c) Shift+Tab from the add-child field must exit add mode and land focus on the
// table's FIRST editable cell (the backward branch of onTab → firstEditableCell),
// without committing a child (Shift+Tab never creates).
test('architecture 104 (edge c): Shift+Tab from the add-child field lands on the first grid cell', async ({
  page,
}) => {
  const { panel, comfortRow } = await setup104(page, 'Repro104f')

  await comfortRow.hover()
  await panel.getByRole('button', { name: 'Add child to Comfort' }).click()
  const childField = page.getByPlaceholder('Name a child of Comfort')
  await expect(childField).toBeFocused()

  // Shift+Tab: exit add mode, focus the first editable grid cell — never <body>.
  await childField.press('Shift+Tab')
  await expect(childField).toBeHidden()
  // The focus handoff lands inside a requestAnimationFrame (see ArchitectureSurface
  // onTab), so poll rather than reading activeElement once — the rAF may not have
  // fired by the time press() resolves, especially under parallel-worker load.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.activeElement
          return {
            isBody: el === document.body || el === null,
            inGridCell: !!el?.closest('.grid-cell'),
            inPanel: !!el?.closest('.t2-table'),
          }
        }),
      { timeout: 3000 },
    )
    .toEqual({ isBody: false, inGridCell: true, inPanel: true })
})

// (d) Clicking a NON-cell region (the table title, outside the grid) must LEAVE the
// phantom armed — there is no outside-pointerdown dismiss (dismissOnBlur=false, and
// only beginEditing on a real cell drives onDismiss). Documents the intended wart:
// empty-space clicks don't dismiss; use Esc or click a cell. If a future change adds
// an outside-pointerdown dismiss, this test is the signal to revisit the contract.
test('architecture 104 (edge d): clicking outside the grid cells leaves the add-child phantom armed', async ({
  page,
}) => {
  const { panel, comfortRow } = await setup104(page, 'Repro104g')

  await comfortRow.hover()
  await panel.getByRole('button', { name: 'Add child to Comfort' }).click()
  const childField = page.getByPlaceholder('Name a child of Comfort')
  await expect(childField).toBeVisible()

  // Click the table title (a non-cell region inside the panel). blur fires but is
  // decoupled from dismissal, and no beginEditing seam runs — so the phantom stays.
  await panel.locator('.t2-table__name').click()
  await expect(childField).toBeVisible()
})
