// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { openDatabase } from '../db/client'
import { addDimension, addParameter, createProject } from '../db/mutations'
import { addWorkspaceMember } from '../db/workspaces'
import { resetAuthStoreForTests, useAuthStore } from '../store/auth'
import { useCommandLogStore } from '../store/commandLog'
import { requireDatabase, setDatabase } from '../store/database'
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

describe('DesignSurface — two-pane layout (issue 027)', () => {
  it('mounts the canvas and register side by side in the same two-pane row, even when both are empty', async () => {
    renderDesignSurface({ projectId, contextPath: [], view: 'canvas' })
    await waitFor(() => expect(document.querySelector('.canvas-shell')).toBeInTheDocument())
    const row = document.querySelector('.design-surface-row') as HTMLElement
    expect(row).toBeInTheDocument()
    const canvas = row.querySelector('.canvas-shell')
    const register = row.querySelector('.context-register-shell')
    expect(canvas).toBeInTheDocument()
    expect(register).toBeInTheDocument()
    // Structural balance: both panes are direct children of the same row —
    // the register is not a floating panel outside the canvas's layout.
    expect(canvas?.parentElement).toBe(row)
    expect(register?.parentElement).toBe(row)
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
  it('renders breadcrumb (location), dimension/view controls, and stats as three distinct groups', async () => {
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
    expect(within(location).queryByRole('button', { name: 'Dimensions' })).not.toBeInTheDocument()

    // Controls: dimension manager trigger + the canvas/coverage toggle — not
    // the breadcrumb, not the stats.
    expect(within(controls).getByRole('button', { name: 'Dimensions' })).toBeInTheDocument()
    expect(within(controls).getByRole('group', { name: 'Design view' })).toBeInTheDocument()
    expect(within(controls).queryByRole('navigation')).not.toBeInTheDocument()

    // Stats: documented + draft counts — not controls, not the breadcrumb.
    expect(within(stats).getByText(/documented/)).toBeInTheDocument()
    expect(within(stats).getByText(/draft/)).toBeInTheDocument()
    expect(within(stats).queryByRole('button', { name: 'Dimensions' })).not.toBeInTheDocument()
  })

  it('breadcrumb is the primary depth nav: current crumb is not a link, ancestor crumbs are', async () => {
    const alphaId = await createCompleteRootContextAndReturnId()
    renderDesignSurface({ projectId, contextPath: [alphaId], view: 'canvas' })

    const current = await screen.findByText('α', { selector: '.breadcrumb--current' })
    expect(current).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Root' })).toBeInTheDocument()
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
