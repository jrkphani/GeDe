// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { openDatabase } from '../db/client'
import { addDimension, addParameter, createProject } from '../db/mutations'
import { addWorkspaceMember } from '../db/workspaces'
import { resetAuthStoreForTests, useAuthStore } from '../store/auth'
import { useCommandLogStore } from '../store/commandLog'
import { requireDatabase, setDatabase } from '../store/database'
import { resetCanvasesStore } from '../store/canvases'
import { resetDimensionsStore, useDimensionsStore } from '../store/dimensions'
import { resetParametersStore } from '../store/parameters'
import { resetContextsStore, useContextsStore } from '../store/contexts'
import { useProjectsStore } from '../store/projects'
import { resetTier2Store } from '../store/tier2'
import { useStatusStore } from '../store/status'
import { resetWorkspaceStore } from '../store/workspace'
import { ContextBarProvider, ContextBarSlot } from '../shell/slots'
import { DesignSurface } from './DesignSurface'

// Issue 027 — layout cleanup + navigation clarity. These tests exercise
// DesignSurface directly (it has never had its own test file), covering the
// design brief's four scope items: two-pane mounting, single empty-state
// voice, context-bar grouping, and lineage shown once.
//
// jsdom does apply a real, injected <style> stylesheet to computed style for
// plain class/attribute selectors (verified: no `css: true` needed) — so the
// CSS-driven empty-state suppression (added because Canvas.tsx is out of
// scope for this issue) is verified here against the *actual* shipped
// base.css, not a re-implemented copy of the rule.
let cssInjected = false
function ensureBaseCssInDom() {
  if (cssInjected) return
  const css = fs.readFileSync(path.resolve(__dirname, '../styles/base.css'), 'utf-8')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  cssInjected = true
}

function renderDesignSurface(props: Parameters<typeof DesignSurface>[0]) {
  return render(
    <ContextBarProvider>
      <ContextBarSlot />
      <DesignSurface {...props} />
    </ContextBarProvider>,
  )
}

let projectId: string
let workspaceId: string
let dimAId: string
let dimBId: string
let paramAId: string
let paramBId: string

beforeAll(() => {
  ensureBaseCssInDom()
})

beforeEach(async () => {
  const { db } = await openDatabase('memory://')
  setDatabase(db)
  resetDimensionsStore()
  resetCanvasesStore()
  resetParametersStore()
  resetContextsStore()
  resetTier2Store()
  resetWorkspaceStore()
  resetAuthStoreForTests()
  useCommandLogStore.getState().clear()
  useStatusStore.setState({ message: null, action: null })

  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  workspaceId = project.workspaceId
  // Seeds the projects store (unrelated to this file's own db-driven setup)
  // just far enough for useWorkspaceRole's project→workspaceId lookup to
  // resolve — DesignSurface itself never reads the projects store directly.
  useProjectsStore.setState({ projects: [project], status: 'ready' })
  const dimA = await addDimension(db, project.id)
  const dimB = await addDimension(db, project.id)
  dimAId = dimA.id
  dimBId = dimB.id
  const paramA = await addParameter(db, dimA.id, 'Comfort')
  const paramB = await addParameter(db, dimB.id, 'Users')
  paramAId = paramA.id
  paramBId = paramB.id
})

// Drills into a freshly-composed, complete root context — mirrors the
// recursion e2e's setup (e2e/recursion.spec.ts) but via direct store calls,
// producing exactly the "child canvas, seeded dimensions, zero sub-parameters
// yet" state the design brief calls the needs-parameters case.
async function createCompleteRootContextAndReturnId(): Promise<string> {
  await useDimensionsStore.getState().load(projectId, null)
  await useContextsStore.getState().load(projectId, null)
  const row = await useContextsStore.getState().create()
  if (!row) throw new Error('context creation failed in test setup')
  await useContextsStore.getState().bind(row.id, dimAId, paramAId)
  await useContextsStore.getState().bind(row.id, dimBId, paramBId)
  return row.id
}

describe('DesignSurface — two-pane layout (issue 027), reworked to editing zone + side canvas (issue 085 Phase C)', () => {
  it('mounts the canvas as a row-level sibling of the editing zone that holds the register, even when both are empty', async () => {
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())
    const row = document.querySelector('.design-surface-row') as HTMLElement
    expect(row).toBeInTheDocument()
    const canvas = row.querySelector('.canvas-shell')
    const register = row.querySelector('.context-register-shell')
    expect(canvas).toBeInTheDocument()
    expect(register).toBeInTheDocument()
    // Issue 085 Phase C — the canvas is a direct child of the row (a side
    // visual panel, Decision 2); the register now lives one level deeper,
    // inside the editing zone it shares with the rail (Decision 1), not
    // directly on the row beside the canvas the way it used to.
    expect(canvas?.parentElement).toBe(row)
    expect(register?.parentElement).not.toBe(row)
    expect(register?.parentElement).toHaveClass('editing-zone')
  })
})

describe('DesignSurface — single empty-state voice (issue 027)', () => {
  it('has-params-no-contexts (root, empty): shows no needs-parameters banner — Canvas owns the one prompt, unsuppressed', async () => {
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())

    expect(document.querySelector('.canvas-seed-hint')).not.toBeInTheDocument()

    const row = document.querySelector('.design-surface-row') as HTMLElement
    expect(row).not.toHaveAttribute('data-suppress-canvas-empty')
    const prompt = document.querySelector('.canvas-empty-prompt') as HTMLElement
    expect(prompt).toBeInTheDocument()
    expect(prompt).toBeVisible()
  })

  it('child-no-params: shows exactly the needs-parameters banner; Canvas mounts but its own empty prompt is suppressed', async () => {
    const alphaId = await createCompleteRootContextAndReturnId()
    renderDesignSurface({ projectId, contextPath: [alphaId], view: 'canvas' })

    await waitFor(() => expect(document.querySelector('.canvas-seed-hint')).toBeInTheDocument())
    expect(document.querySelector('.canvas-seed-hint')).toHaveTextContent(/needs parameters/)

    // Canvas + register both still mount in this state (design brief, test
    // plan #1) — only the *messaging* is consolidated, not the layout.
    const row = document.querySelector('.design-surface-row') as HTMLElement
    expect(row).toHaveAttribute('data-suppress-canvas-empty')
    expect(row.querySelector('.canvas-shell')).toBeInTheDocument()
    expect(row.querySelector('.context-register-shell')).toBeInTheDocument()

    // Never both: Canvas's own "Bind your first context" prompt is present in
    // the DOM (Canvas.tsx is unmodified — SPEC §4.2 always renders it while
    // empty) but suppressed by the real base.css rule scoped to this state.
    const prompt = document.querySelector('.canvas-empty-prompt')
    expect(prompt).toBeInTheDocument()
    expect(prompt).not.toBeVisible()
  })

  it('never renders the canvas-center lineage line — the breadcrumb states the refined tuple once', async () => {
    const alphaId = await createCompleteRootContextAndReturnId()
    renderDesignSurface({ projectId, contextPath: [alphaId], view: 'canvas' })

    await waitFor(() => expect(document.querySelector('.canvas-seed-hint')).toBeInTheDocument())
    // DesignSurface no longer passes `lineage` to Canvas at all, so this
    // element never enters the DOM in the first place — a structural
    // guarantee, not a CSS one.
    expect(document.querySelector('.canvas-empty-lineage')).not.toBeInTheDocument()

    // The breadcrumb bar is the one place the refined tuple is named.
    expect(document.querySelector('.breadcrumbs__dims')).toBeInTheDocument()
  })
})

describe('DesignSurface — context bar hierarchy (issue 027)', () => {
  // Issue 082 Phase 1 — the "Dimensions" popover trigger that used to live in
  // context-bar__controls is retired: the dimension manager is now an
  // always-open rail on the canvas surface itself (never in the context bar
  // at all), so this test's own "controls: trigger + view toggle" claim is
  // updated to "controls: just the view toggle" and a new assertion covers
  // the rail's stable location instead.
  it('renders breadcrumb (location), the view toggle, and stats as three distinct groups; the dimension rail lives on the canvas surface, not the context bar', async () => {
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())

    const location = document.querySelector('.context-bar__location') as HTMLElement
    const controls = document.querySelector('.context-bar__controls') as HTMLElement
    const stats = document.querySelector('.context-bar__stats') as HTMLElement
    expect(location).toBeInTheDocument()
    expect(controls).toBeInTheDocument()
    expect(stats).toBeInTheDocument()

    // Location: the breadcrumb nav, and only the breadcrumb nav.
    expect(within(location).getByRole('navigation', { name: 'Canvas depth' })).toBeInTheDocument()

    // Controls: just the canvas/coverage toggle now — no "Dimensions" trigger
    // anywhere in the context bar.
    expect(within(controls).getByRole('group', { name: 'Design view' })).toBeInTheDocument()
    expect(within(controls).queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dimensions' })).not.toBeInTheDocument()

    // Stats: documented + draft counts — not controls, not the breadcrumb.
    expect(within(stats).getByText(/documented/)).toBeInTheDocument()
    expect(within(stats).getByText(/draft/)).toBeInTheDocument()

    // The rail is a stable panel on the canvas surface, not the context bar.
    const rail = document.querySelector('.dim-rail')
    expect(rail).toBeInTheDocument()
    expect(within(rail as HTMLElement).getByPlaceholderText('Type to add a dimension')).toBeInTheDocument()
  })

  it('breadcrumb is the primary depth nav: current crumb is not a link, ancestor crumbs are', async () => {
    const alphaId = await createCompleteRootContextAndReturnId()
    renderDesignSurface({ projectId, contextPath: [alphaId], view: 'canvas' })

    const current = await screen.findByText('α', { selector: '.breadcrumb--current' })
    expect(current).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Root' })).toBeInTheDocument()
  })

  // Issue 090 Phase 4c — the root-canvas switcher lives in the location group,
  // and ONLY at depth 0 (at depth>0 the breadcrumb owns navigation).
  it('renders the canvas switcher at depth 0 (default canvas named "Canvas 1")', async () => {
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    const trigger = await screen.findByRole('button', { name: /^Canvas:/ })
    expect(trigger).toHaveTextContent('Canvas 1')
    // It lives in the location group, beside the breadcrumb.
    const location = document.querySelector('.context-bar__location') as HTMLElement
    expect(location).toContainElement(trigger)
  })

  it('does NOT render the canvas switcher at depth>0', async () => {
    const alphaId = await createCompleteRootContextAndReturnId()
    renderDesignSurface({ projectId, contextPath: [alphaId], view: 'canvas' })
    await screen.findByText('α', { selector: '.breadcrumb--current' })
    expect(screen.queryByRole('button', { name: /^Canvas:/ })).not.toBeInTheDocument()
  })
})

describe('DesignSurface — viewer read-only affordance (issue 035)', () => {
  it('a signed-in viewer sees no "New context" affordance and no register phantom row', async () => {
    const db = requireDatabase()
    await addWorkspaceMember(db, workspaceId, 'sub-viewer', 'viewer')
    useAuthStore.setState({
      status: 'authenticated',
      configured: true,
      user: { sub: 'sub-viewer', email: null },
    })

    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New context' })).not.toBeInTheDocument())
    expect(document.querySelector('.grid-row--phantom')).not.toBeInTheDocument()
  })

  it('an editor still sees the full write surface', async () => {
    const db = requireDatabase()
    await addWorkspaceMember(db, workspaceId, 'sub-editor', 'editor')
    useAuthStore.setState({
      status: 'authenticated',
      configured: true,
      user: { sub: 'sub-editor', email: null },
    })

    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'New context' })).toBeInTheDocument())
    expect(document.querySelector('.grid-row--phantom')).toBeInTheDocument()
  })
})

// Issue 082 Phase 1, test-first plan item 1 — Decision 3 (soft-hint floor):
// delete the guided/populated bifurcation (DesignSurface.tsx used to render
// an entirely different tree — DimensionManagerPanel alone behind a hard
// placeholder wall — below n=2, then swap to the popover-based tree at n=2).
// One tree now renders at every dimension count; the rail's own DOM node
// must never remount crossing the floor.
describe('DesignSurface — soft-hint floor, no bifurcation (issue 082 Phase 1)', () => {
  it('the rail is the same DOM node at 0, 1, and 2+ dimensions; no hard placeholder wall at any count', async () => {
    const db = requireDatabase()
    const bare = await createProject(db, { name: 'Bare' })
    useProjectsStore.setState({ projects: [bare], status: 'ready' })
    resetDimensionsStore()
    resetParametersStore()
    resetContextsStore()

    renderDesignSurface({ projectId: bare.id, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())
    // Issue 085 Phase C — the rail is now a child of the editing zone, not
    // directly of the row (the row's direct children are the editing zone
    // and the side canvas).
    const railAt0 = document.querySelector('.editing-zone > .dim-rail')
    expect(railAt0).toBeInTheDocument()
    // The old guided branch replaced the whole surface with
    // `<p className="placeholder">Add at least two dimensions…</p>` — gone.
    expect(document.querySelector('.placeholder')).not.toBeInTheDocument()
    expect(screen.getByText('Add a second dimension to start binding contexts.')).toBeInTheDocument()

    await act(async () => {
      await addDimension(db, bare.id)
      await useDimensionsStore.getState().load(bare.id, null)
    })
    const railAt1 = document.querySelector('.editing-zone > .dim-rail')
    expect(railAt1).toBe(railAt0) // same node — no remount crossing 0 -> 1
    expect(document.querySelector('.placeholder')).not.toBeInTheDocument()

    await act(async () => {
      await addDimension(db, bare.id)
      await useDimensionsStore.getState().load(bare.id, null)
    })
    const railAt2 = document.querySelector('.editing-zone > .dim-rail')
    // The crossing gesture the old `guided` flip fired on exactly here
    // (dimensions.length >= 2) — the rail must still be the very same node.
    expect(railAt2).toBe(railAt0)
    expect(document.querySelector('.placeholder')).not.toBeInTheDocument()
    // The soft hint itself is gone once the floor is met — it's a hint, not
    // permanent chrome.
    expect(screen.queryByText('Add a second dimension to start binding contexts.')).not.toBeInTheDocument()
  })
})

// Issue 082 Phase 1, test-first plan item 4.
describe("DesignSurface — `d` focus shortcut (issue 082 Phase 1)", () => {
  it("focuses the rail's dimension-add phantom; ignores a modifier and never fires while a text field has focus", async () => {
    const user = userEvent.setup()
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())

    await user.keyboard('d')
    const dimPhantom = screen.getByPlaceholderText('Type to add a dimension')
    expect(dimPhantom).toHaveFocus()

    // Modifier guard (⌘/Ctrl/Alt): move focus elsewhere first, then confirm
    // a modified "d" is a no-op rather than stealing focus back.
    const paramPhantom = screen.getAllByPlaceholderText('Type to add a parameter')[0] as HTMLInputElement
    paramPhantom.focus()
    await user.keyboard('{Meta>}d{/Meta}')
    expect(paramPhantom).toHaveFocus()

    // Text-field guard: typing a literal "d" inside an already-focused field
    // must not hijack focus back to the dimension phantom.
    await user.clear(paramPhantom)
    await user.type(paramPhantom, 'd')
    expect(paramPhantom).toHaveFocus()
    expect(paramPhantom).toHaveValue('d')
  })
})

// Issue 082 Phase 1, test-first plan item 5 (Decision 4 — tablet). jsdom does
// not evaluate `@container` queries (no real layout engine), so — mirroring
// this codebase's own convention for CSS-only assertions (e.g.
// src/test/commandButtonAudit.test.ts's row-hover-actions grep) — this reads
// the real, shipped base.css rather than asserting computed style.
describe('DesignSurface — tablet stack (issue 082 Phase 1, Decision 4)', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../styles/base.css'), 'utf-8')

  it('below 640px the editing zone stacks (rail -> register), the row stacks the zone above the canvas, all at full width', () => {
    const match = /@container \(max-width: 640px\) \{([^]*?)\n\}\n/.exec(css)
    expect(match).not.toBeNull()
    const body = (match as RegExpMatchArray)[1] as string
    expect(body).toMatch(/\.design-surface-row\s*\{\s*\n\s*flex-direction:\s*column;/)
    // Issue 085 Phase C — the editing zone itself also stacks internally
    // (rail -> register) once narrow, and the rail (now a child of the
    // editing zone, not the row) goes full width within that stack.
    expect(body).toMatch(/\.design-surface-row > \.editing-zone\s*\{\s*\n\s*flex-direction:\s*column;/)
    expect(body).toMatch(/\.editing-zone > \.dim-rail\s*\{\s*\n\s*flex:\s*none;\s*\n\s*width:\s*100%;/)
  })

  it('the editing zone is a direct child of .design-surface-row (rail/register stack together, above the canvas)', async () => {
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())
    const row = document.querySelector('.design-surface-row') as HTMLElement
    const zone = row.querySelector(':scope > .editing-zone')
    expect(zone).toBeInTheDocument()
    expect(zone?.parentElement).toBe(row)
    const rail = (zone as HTMLElement).querySelector(':scope > .dim-rail')
    expect(rail).toBeInTheDocument()
    expect(rail?.parentElement).toBe(zone)
  })
})

// Issue 082 Phase 1, test-first plan item 6 — the three original complaints,
// closed together in one place. Each is unit-tested in depth elsewhere
// (inline-editor.test.tsx for #3's grammar, DimensionManager.test.tsx /
// canvasLayout.test.ts for the rest); this is the cross-cutting regression
// guard at the DesignSurface level the spec calls for.
describe('DesignSurface — complaint regression guards (issue 082 Phase 1, test 6)', () => {
  it('#1 the add-dimension affordance is stable across n=1<->2 (covered above: same DOM node, no bifurcation)', () => {
    // See "soft-hint floor, no bifurcation" above — kept as a named pointer
    // so this guard is discoverable from the complaint list, not duplicated.
    expect(true).toBe(true)
  })

  it('#2 dimensions, parameters, and contexts all add via a phantom row — no persistent "Add X" button for any of them', async () => {
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())

    expect(screen.queryByRole('button', { name: 'Add dimension' })).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Type to add a dimension')).toBeInTheDocument()
    expect(screen.getAllByPlaceholderText('Type to add a parameter').length).toBeGreaterThan(0)
    expect(document.querySelector('.grid-row--phantom')).toBeInTheDocument()
  })

  it('#3 the dimension name editor has the register keyboard contract: Enter commits and advances', async () => {
    const user = userEvent.setup()
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())

    // Scoped to the rail — "Dimension 1" also appears as a context-register
    // column header, which getByText would otherwise ambiguously match too.
    const rail = document.querySelector('.dim-rail') as HTMLElement
    await user.click(within(rail).getByText('Dimension 1'))
    const input = within(rail).getByDisplayValue('Dimension 1')
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.keyboard('{Enter}')

    expect(await within(rail).findByText('Renamed')).toBeInTheDocument()
    // Enter advanced focus into the next field in the chain rather than
    // dead-stopping (inline-editor.tsx `InlineEdit` pre-082: Enter just
    // called setEditing(false), leaving focus nowhere).
    expect(document.activeElement).not.toBe(document.body)
  })
})

// Issue 085 Phase B, test-first plan item 6 — the Composer strip is a
// redundant echo of the register row (Decision 3); it's removed outright and
// selection re-points at scrolling/highlighting the matching register row
// instead of surfacing a second element.
describe('DesignSurface — Composer strip removed, selection highlights the register row (issue 085 Phase B)', () => {
  it('never mounts the Composer strip, selected or not', async () => {
    await createCompleteRootContextAndReturnId()
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())
    const register = document.querySelector('.context-register-shell') as HTMLElement
    await within(register).findByText('α')

    expect(document.querySelector('.composer-bar')).not.toBeInTheDocument()

    const node = document.querySelector('.canvas-node[data-context-id]') as HTMLElement
    const user = userEvent.setup()
    await user.click(node)
    expect(document.querySelector('.composer-bar')).not.toBeInTheDocument()
  })

  it('selecting a context on the canvas highlights and scrolls to its register row (Decision 3)', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const alphaId = await createCompleteRootContextAndReturnId()
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())
    const register = document.querySelector('.context-register-shell') as HTMLElement
    await within(register).findByText('α')

    const node = document.querySelector(`.canvas-node[data-context-id="${alphaId}"]`) as HTMLElement
    expect(node).toBeInTheDocument()
    const user = userEvent.setup()
    scrollSpy.mockClear()
    await user.click(node)

    const row = document.querySelector(`[data-row-id="${alphaId}"]`) as HTMLElement
    await waitFor(() => expect(row).toHaveClass('grid-row--selected'))
    // Non-color-only (STYLE_GUIDE §10): an aria signal accompanies the visual
    // left rule, and the row is scrolled into view rather than requiring the
    // user to hunt for it.
    await waitFor(() => expect(row).toHaveAttribute('aria-selected', 'true'))
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    scrollSpy.mockRestore()
  })
})

// Issue 085 Phase C, test-first plan item 9 — Decision 1: the rail and
// register are grouped into ONE bordered editing-zone container; the canvas
// is outside it (not between them), at every dimension count (including
// below the n=2 floor, where the rail/register still both render — 082
// Phase 1's soft-hint floor).
describe('DesignSurface — one editing zone, canvas outside it (issue 085 Phase C, test 9)', () => {
  it('rail and register share one editing-zone container; the canvas is a sibling of that zone, not between them', async () => {
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())

    const row = document.querySelector('.design-surface-row') as HTMLElement
    const zone = row.querySelector(':scope > .editing-zone') as HTMLElement
    expect(zone).toBeInTheDocument()

    const rail = zone.querySelector(':scope > .dim-rail')
    const register = zone.querySelector(':scope > .context-register-shell')
    expect(rail).toBeInTheDocument()
    expect(register).toBeInTheDocument()
    expect(rail?.parentElement).toBe(zone)
    expect(register?.parentElement).toBe(zone)

    // The canvas is a sibling of the editing zone (a row-level child), never
    // nested inside it, and — critically — it is not positioned between the
    // rail and the register in DOM order: it comes AFTER the whole zone.
    const canvas = row.querySelector(':scope > .canvas-shell') as HTMLElement
    expect(canvas).toBeInTheDocument()
    expect(canvas.parentElement).toBe(row)
    expect(zone.contains(canvas)).toBe(false)
    const rowChildren = Array.from(row.children)
    expect(rowChildren.indexOf(zone)).toBeLessThan(rowChildren.indexOf(canvas))
  })

  it('holds below the n=2 floor too (0 dimensions) — same editing-zone/canvas split', async () => {
    const db = requireDatabase()
    const bare = await createProject(db, { name: 'Bare' })
    useProjectsStore.setState({ projects: [bare], status: 'ready' })
    resetDimensionsStore()
    resetParametersStore()
    resetContextsStore()

    renderDesignSurface({ projectId: bare.id, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())

    const row = document.querySelector('.design-surface-row') as HTMLElement
    const zone = row.querySelector(':scope > .editing-zone') as HTMLElement
    expect(zone.querySelector(':scope > .dim-rail')).toBeInTheDocument()
    expect(zone.querySelector(':scope > .context-register-shell')).toBeInTheDocument()
    const canvas = row.querySelector(':scope > .canvas-shell')
    expect(canvas).toBeInTheDocument()
    expect(zone.contains(canvas)).toBe(false)
  })
})

// Issue 085 Phase C, test-first plan item 10 — Decision 1: dimensions ->
// parameters -> contexts is one uninterrupted tab order. PhantomInput's own
// 082 Phase 1 grammar lets Tab escape natively out of an EMPTY phantom
// (inline-editor.tsx, "let native Tab move focus out"); before this issue
// that escape landed on the canvas (it used to sit between the rail and the
// register — 085's own #1 complaint). This suite proves the bridge lands on
// the register's "new context" phantom row instead — even when existing rows
// would otherwise put themselves first in native DOM tab order — and that
// focus never strands on the now-side canvas.
describe('DesignSurface — continuous tab order: rail -> register, never the canvas (issue 085 Phase C, test 10)', () => {
  it("Tab out of the rail's last (empty) phantom lands in the register's new-context row, not the first existing row or the canvas", async () => {
    // An existing, complete context — proves the bridge beats native
    // row-before-phantom DOM order (EditableGrid renders existing rows
    // before the phantom row).
    await createCompleteRootContextAndReturnId()
    const user = userEvent.setup()
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())
    const register = document.querySelector('.context-register-shell') as HTMLElement
    await within(register).findByText('α')

    const dimPhantom = screen.getByPlaceholderText('Type to add a dimension')
    dimPhantom.focus()
    expect(dimPhantom).toHaveValue('')

    await user.tab()

    const registerPhantomInput = document.querySelector('.grid-row--phantom input') as HTMLElement
    expect(registerPhantomInput).toBeInTheDocument()
    expect(document.activeElement).toBe(registerPhantomInput)
    // Never the first existing row (α) and never the canvas.
    expect(document.activeElement?.closest('.canvas-shell')).toBeNull()
    expect(document.activeElement?.closest(`[data-row-id]`)).toBeNull()
  })

  it('Tab across register cells keeps working, and continues past the bridged phantom row without ever landing on the canvas', async () => {
    const user = userEvent.setup()
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())

    const dimPhantom = screen.getByPlaceholderText('Type to add a dimension')
    dimPhantom.focus()
    await user.tab()

    const registerPhantomInput = document.activeElement as HTMLInputElement
    expect(registerPhantomInput.closest('.grid-row--phantom')).not.toBeNull()

    // Tab-with-content on the phantom row creates the context and continues
    // into the newly created row's next editable cell (existing EditableGrid
    // grammar, issue 022) — still inside the register, never the canvas.
    await user.type(registerPhantomInput, 'because reasons')
    await user.tab()
    expect(document.activeElement?.closest('.canvas-shell')).toBeNull()
    expect(document.activeElement?.closest('.context-register-shell')).not.toBeNull()
  })

  it('a modified Tab (e.g. Shift+Tab) is left alone — the bridge only redirects a plain forward Tab', async () => {
    const user = userEvent.setup()
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())

    const dimPhantom = screen.getByPlaceholderText('Type to add a dimension')
    dimPhantom.focus()
    await user.tab({ shift: true })
    expect(document.activeElement?.closest('.context-register-shell')).toBeNull()
  })
})
