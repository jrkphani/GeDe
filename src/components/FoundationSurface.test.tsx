// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { openDatabase } from '../db/client'
import { addTier1Prop, createProject, getTier1Purpose, setTier1ExistingScenario } from '../db/mutations'
import { addWorkspaceMember } from '../db/workspaces'
import { RICH_TEXT_NODES } from '../domain/richText'

// Builds a real Lexical EditorState JSON containing plain text, the same way
// rich-text-editor.test.tsx does — used to seed a project with pre-existing
// scenario content so a test can select and format REAL text without relying
// on simulated character-by-character typing (unreliable in jsdom's
// contentEditable — see rich-text-editor.test.tsx's file-level comment).
function plainTextEditorStateJson(text: string): string {
  const editor = createEditor({
    namespace: 'test',
    nodes: RICH_TEXT_NODES,
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode(text))
      $getRoot().append(paragraph)
    },
    { discrete: true },
  )
  return JSON.stringify(editor.getEditorState().toJSON())
}

function selectAllTextIn(container: Element) {
  const range = document.createRange()
  range.selectNodeContents(container)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}
import { resetAuthStoreForTests, useAuthStore } from '../store/auth'
import { useCommandLogStore } from '../store/commandLog'
import { setDatabase } from '../store/database'
import { useProjectsStore } from '../store/projects'
import { resetSyncStore, useSyncStore } from '../store/sync'
import { resetTier1Store } from '../store/tier1'
import { resetWorkspaceStore } from '../store/workspace'
import { FoundationSurface } from './FoundationSurface'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string
let workspaceId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetTier1Store()
  resetWorkspaceStore()
  resetAuthStoreForTests()
  resetSyncStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  workspaceId = project.workspaceId
  useProjectsStore.setState({ projects: [project], status: 'ready' })
})

describe('FoundationSurface', () => {
  it('renders the 1st-tier header microcopy', async () => {
    render(<FoundationSurface projectId={projectId} />)
    expect(await screen.findByText('1st Tier · Foundation')).toBeInTheDocument()
  })

  it('shows ghost purpose copy when the project has no purpose yet', async () => {
    render(<FoundationSurface projectId={projectId} />)
    expect(await screen.findByText('What is this system for?')).toBeInTheDocument()
  })

  it('reuses EditableGrid — the propositions render in an .editable-grid table', async () => {
    await addTier1Prop(db, projectId, 'Seating-status comfort')
    const { container } = render(<FoundationSurface projectId={projectId} />)
    await waitFor(() => {
      expect(container.querySelector('table.editable-grid')).toBeInTheDocument()
    })
    expect(await screen.findByText('Seating-status comfort')).toBeInTheDocument()
  })

  it('renders degree notation 1° 2° from integer ranks', async () => {
    await addTier1Prop(db, projectId, 'Seating-status comfort')
    await addTier1Prop(db, projectId, 'Mobility fluidity')
    render(<FoundationSurface projectId={projectId} />)
    expect(await screen.findByText('1°')).toBeInTheDocument()
    expect(await screen.findByText('2°')).toBeInTheDocument()
  })

  it('offers a phantom row to name a value proposition', async () => {
    render(<FoundationSurface projectId={projectId} />)
    expect(await screen.findByPlaceholderText('Name a value proposition')).toBeInTheDocument()
  })

  it('typing in the phantom row creates a proposition through the store', async () => {
    const user = userEvent.setup()
    render(<FoundationSurface projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText('Name a value proposition')
    await user.type(phantom, 'Age-spectrum compatibility')
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Age-spectrum compatibility')).toBeInTheDocument()
    expect(await screen.findByText('1°')).toBeInTheDocument()
  })

  it('a viewer sees no phantom row and cannot open the purpose editor (issue 035)', async () => {
    await addTier1Prop(db, projectId, 'Seating-status comfort')
    await addWorkspaceMember(db, workspaceId, 'sub-viewer', 'viewer')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-viewer', email: null } })
    const user = userEvent.setup()

    const { container } = render(<FoundationSurface projectId={projectId} />)
    await screen.findByText('Seating-status comfort')

    expect(screen.queryByPlaceholderText('Name a value proposition')).not.toBeInTheDocument()
    await user.click(screen.getByText('What is this system for?'))
    // Purpose's editor is a real <textarea> (multiline-editor.tsx) — clicking
    // its ghost text never opens one for a viewer. Queried by tag rather than
    // role="textbox": issue 081's Existing Scenario field is a Lexical
    // contentEditable div that is ALSO always mounted with role="textbox"
    // (even read-only — it renders formatted content, just not editable —
    // see the dedicated assertion below), so role alone can no longer
    // distinguish "no purpose editor" from "the existing-scenario panel is
    // present but non-editable".
    expect(container.querySelector('textarea')).not.toBeInTheDocument()
  })

  // Issue 081 — mirrors Purpose's own readOnly contract (issue 035): a
  // viewer sees the Existing Scenario panel's rendered content with no
  // toolbar and no edit affordance (the contentEditable region itself stays
  // mounted — read-only rendering reuses the same restricted Lexical
  // instance as the editable path — but is never contentEditable=true).
  it('a viewer sees the existing-scenario panel rendered but not editable, with no toolbar (issue 035)', async () => {
    await addWorkspaceMember(db, workspaceId, 'sub-viewer', 'viewer')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-viewer', email: null } })

    const { container } = render(<FoundationSurface projectId={projectId} />)
    await screen.findByText('1st Tier · Foundation')

    const scenarioField = await screen.findByLabelText('Existing scenario')
    expect(scenarioField).toHaveAttribute('contenteditable', 'false')
    expect(container.querySelector('.rich-text-editor__toolbar')).not.toBeInTheDocument()
  })
})

// Issue 083 — Cause A. `members` going non-empty (someone else's row
// streamed in) never guaranteed the signed-in caller's OWN workspace_members
// row arrived first (a 067-class materialization race). Before this fix,
// that snapshot alone collapsed `role` to a hard 'viewer', so a legitimate
// owner/editor lost the phantom "add a value proposition" row for as long as
// their own membership row hadn't yet streamed — with no error and no
// visible cause. The surface must stay interactive while role is still
// resolving, not silently collapse to read-only.
describe('FoundationSurface — add affordance survives role-still-resolving (issue 083 Cause A)', () => {
  it('keeps the phantom "add a value proposition" row while the caller\'s own membership row has not yet streamed in', async () => {
    await addWorkspaceMember(db, workspaceId, 'sub-owner', 'owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-new-member', email: null } })
    // Sync is on, but workspace_members hasn't reported "up-to-date" yet —
    // exactly the window where the signed-in caller's own row may still be
    // in flight, indistinguishable from a single snapshot from "confirmed
    // not a member".
    useSyncStore.setState({ enabled: true, upToDateTables: new Set() })

    render(<FoundationSurface projectId={projectId} />)
    await screen.findByText('1st Tier · Foundation')

    expect(await screen.findByPlaceholderText('Name a value proposition')).toBeInTheDocument()
  })
})

// Issue 081 test-first plan item 9.
describe('FoundationSurface — existing scenario (issue 081)', () => {
  it('shows ghost copy when the project has no existing scenario yet', async () => {
    render(<FoundationSurface projectId={projectId} />)
    expect(await screen.findByText('Describe the existing scenario…')).toBeInTheDocument()
  })

  it('mounts the existing-scenario panel strictly between Purpose and the value-propositions table', async () => {
    await addTier1Prop(db, projectId, 'Seating-status comfort')
    const { container } = render(<FoundationSurface projectId={projectId} />)
    await screen.findByText('Seating-status comfort')

    const purposeSection = container.querySelector('.tier1-purpose')
    const scenarioSection = container.querySelector('.tier1-existing-scenario')
    const propsSection = container.querySelector('.tier1-props')
    expect(purposeSection).toBeInTheDocument()
    expect(scenarioSection).toBeInTheDocument()
    expect(propsSection).toBeInTheDocument()

    // DOCUMENT_POSITION_FOLLOWING (4): purpose precedes scenario precedes props.
    expect(purposeSection?.compareDocumentPosition(scenarioSection as Node) as number).toBe(4)
    expect(scenarioSection?.compareDocumentPosition(propsSection as Node) as number).toBe(4)
  })

  it('committing a formatting edit (blur) persists through the mutation layer exactly once, not per keystroke', async () => {
    await setTier1ExistingScenario(db, projectId, plainTextEditorStateJson('Comfort, on demand.'))
    render(<FoundationSurface projectId={projectId} />)
    const editable = await screen.findByLabelText('Existing scenario')
    await waitFor(() => expect(editable.textContent).toBe('Comfort, on demand.'))

    editable.focus()
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'b', ctrlKey: true }) // Ctrl+B — the toolbar's own keyboard shortcut
    await waitFor(() => expect(editable.querySelector('strong')).toBeInTheDocument())
    // Not committed yet — bold/italic/underline toggles never blur the
    // editor by themselves; only the blur gesture at the end commits.
    expect((await getTier1Purpose(db, projectId))?.existingScenario).not.toContain('"format":1')

    fireEvent.blur(editable)
    await waitFor(async () => {
      const persisted = (await getTier1Purpose(db, projectId))?.existingScenario ?? ''
      expect(persisted).toContain('"format":1')
    })
    // Exactly one write reached the row for this gesture: the persisted body
    // is unaffected (shared-row independence, already covered at the store
    // level) and the text itself is unchanged — only formatting landed.
    expect((await getTier1Purpose(db, projectId))?.existingScenario).toContain('Comfort, on demand.')
  })

  it('a viewer sees no toolbar and the region is not editable, mirroring Purpose (issue 035)', async () => {
    await addWorkspaceMember(db, workspaceId, 'sub-viewer', 'viewer')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-viewer', email: null } })

    render(<FoundationSurface projectId={projectId} />)
    const editable = await screen.findByLabelText('Existing scenario')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(editable).toHaveAttribute('contenteditable', 'false')
  })
})
