// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { resetFocusedEditor } from '../store/focusedEditor'
import { FormatStrip } from './FormatStrip'
import { openDatabase } from '../db/client'
import { addDimension, addParameter, createProject } from '../db/mutations'
import type { PresenceWireEvent } from '../domain/presence'
import { startPresence, type PresenceChannelFactory, type PresenceChannelLike } from '../presence/presenceChannel'
import { resetAuthStoreForTests, useAuthStore } from '../store/auth'
import { useCommandLogStore } from '../store/commandLog'
import { setDatabase } from '../store/database'
import { resetDimensionsStore, useDimensionsStore } from '../store/dimensions'
import { resetParametersStore } from '../store/parameters'
import { resetContextsStore, useContextsStore } from '../store/contexts'
import { resetPresenceStoreForTests, usePresenceStore } from '../store/presence'
import { useStatusStore } from '../store/status'
import { ContextRegister } from './ContextRegister'

// Shared in-memory bus fixture (mirrors presenceChannel.test.ts/store/
// presence.test.ts) — a raw startPresence() call stands in for "another
// browser tab" in the same workspace, sharing this fake transport. No live
// Electric/AWS/BroadcastChannel in tests (HANDOFF).
function fakeChannelFactory(): PresenceChannelFactory {
  const subscribers = new Set<(event: PresenceWireEvent) => void>()
  const channel: PresenceChannelLike = {
    publish(event) {
      for (const cb of subscribers) cb(event)
    },
    subscribe(callback) {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
  }
  return () => channel
}

// Selects all text in a contentEditable via the real DOM Selection/Range APIs
// jsdom implements (Lexical can't process realistic keyboard input in jsdom —
// see rich-text-editor.test.tsx's header). Used to drive the rich justification
// cell's editor without simulating keystrokes.
function selectAllTextIn(container: Element) {
  const range = document.createRange()
  range.selectNodeContents(container)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

let projectId: string

beforeEach(async () => {
  resetFocusedEditor()
  const { db } = await openDatabase('memory://')
  setDatabase(db)
  resetDimensionsStore()
  resetParametersStore()
  resetContextsStore()
  useCommandLogStore.getState().clear()
  useStatusStore.setState({ message: null, action: null })
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  const value = await addDimension(db, project.id)
  const stake = await addDimension(db, project.id)
  await addParameter(db, value.id, 'Comfort')
  await addParameter(db, stake.id, 'Users')
  await useDimensionsStore.getState().load(project.id)
})

const FIRST_CONTEXT_PLACEHOLDER = /Type to create your first context/

describe('ContextRegister', () => {
  it('generates one column per dimension, in sort order — dynamic columns', async () => {
    render(<ContextRegister projectId={projectId} />)
    await waitFor(() => {
      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Symbol',
        'Documented',
        'Dimension 1',
        'Dimension 2',
        'Justification',
        'Children',
        'Duplicate',
      ])
    })
  })

  it('creating a context via the phantom row assigns the next symbol', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Rationale text')
    await user.keyboard('{Enter}')
    expect(await screen.findByText('α')).toBeInTheDocument()
  })

  it('a context is a draft until every dimension is bound, then complete', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'x')
    await user.keyboard('{Enter}')
    await screen.findByText('α')

    const row = (await screen.findByText('α')).closest('tr') as HTMLElement
    expect(row).toHaveClass('grid-row--draft')

    const buttons = within(row).getAllByRole('button')
    await user.click(buttons[0] as HTMLElement)
    await user.click(screen.getByText('Comfort'))
    await user.click(buttons[1] as HTMLElement)
    await user.click(screen.getByText('Users'))

    await waitFor(() => expect(row).not.toHaveClass('grid-row--draft'))
  })

  it('rejects a symbol collision and announces the reason via the status bar', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = screen.getByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'a')
    await user.keyboard('{Enter}')
    await screen.findByText('α')
    await user.type(phantom, 'b')
    await user.keyboard('{Enter}')
    await screen.findByText('β')

    await user.click(screen.getByText('β'))
    screen.getByDisplayValue('β')
    await user.keyboard('α{Enter}')

    await waitFor(() => expect(useStatusStore.getState().message).toMatch(/already in use/))
    expect(screen.getByText('β')).toBeInTheDocument()
  })

  it('the documented dot reflects draft, complete-unjustified, and documented states', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Reason')
    await user.keyboard('{Enter}')
    await screen.findByText('α')
    const row = (await screen.findByText('α')).closest('tr') as HTMLElement

    expect(within(row).getByTitle('Draft')).toHaveAttribute('data-status', 'draft')

    const buttons = within(row).getAllByRole('button')
    await user.click(buttons[0] as HTMLElement)
    await user.click(screen.getByRole('option', { name: 'Comfort' }))
    await user.click(buttons[1] as HTMLElement)
    await user.click(screen.getByRole('option', { name: 'Users' }))

    await waitFor(() =>
      expect(within(row).getByTitle('Documented')).toHaveAttribute('data-status', 'documented'),
    )

    // Justification is a rich cell now (089 D1 P3): editing swaps to a live
    // contentEditable, not a textarea. Empty it (select-all + Backspace) and
    // commit with Cmd/Ctrl+Enter — the documented dot drops to "complete".
    await user.click(within(row).getByText('Reason'))
    const editable = within(row).getByLabelText('Justification')
    expect(editable).toHaveAttribute('contenteditable', 'true')
    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => expect(editable.textContent).toBe(''))
    fireEvent.keyDown(editable, { key: 'Enter', ctrlKey: true })

    await waitFor(() =>
      expect(within(row).getByTitle('Complete — needs justification')).toHaveAttribute(
        'data-status',
        'complete',
      ),
    )
  })

  it('flags two contexts on the same tuple with a duplicate badge that clears when either rebinds away', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'first')
    await user.keyboard('{Enter}')
    await screen.findByText('α')
    await user.type(phantom, 'second')
    await user.keyboard('{Enter}')
    await screen.findByText('β')

    async function bindBoth(symbol: string) {
      const row = (await screen.findByText(symbol)).closest('tr') as HTMLElement
      const buttons = within(row).getAllByRole('button')
      await user.click(buttons[0] as HTMLElement)
      await user.click(screen.getByRole('option', { name: 'Comfort' }))
      await user.click(buttons[1] as HTMLElement)
      await user.click(screen.getByRole('option', { name: 'Users' }))
    }
    await bindBoth('α')
    await bindBoth('β')

    const rowAlpha = (await screen.findByText('α')).closest('tr') as HTMLElement
    const rowBeta = (await screen.findByText('β')).closest('tr') as HTMLElement

    await waitFor(() => {
      expect(within(rowAlpha).getByTitle(/Same tuple as/)).toBeInTheDocument()
      expect(within(rowBeta).getByTitle(/Same tuple as/)).toBeInTheDocument()
    })

    const betaButtons = within(rowBeta).getAllByRole('button')
    await user.click(betaButtons[0] as HTMLElement)
    await user.click(screen.getByText('— clear —'))

    await waitFor(() => {
      expect(within(rowAlpha).queryByTitle(/Same tuple as/)).not.toBeInTheDocument()
      expect(within(rowBeta).queryByTitle(/Same tuple as/)).not.toBeInTheDocument()
    })
  })

  it('clicking a row selects it in the shared store, and the matching row gets the selected class (issue 009)', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'first')
    await user.keyboard('{Enter}')

    const rowAlpha = (await screen.findByText('α')).closest('tr') as HTMLElement
    await user.click(within(rowAlpha).getByText('α'))

    expect(useContextsStore.getState().selectedContextId).toBe(
      useContextsStore.getState().contexts.find((c) => c.symbol === 'α')?.id,
    )
    await waitFor(() => expect(rowAlpha).toHaveClass('grid-row--selected'))
  })

  it('selecting a context via the store (e.g. from the canvas) highlights its row without requiring a click', async () => {
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    const user = userEvent.setup()
    await user.type(phantom, 'first')
    await user.keyboard('{Enter}')
    const rowAlpha = (await screen.findByText('α')).closest('tr') as HTMLElement
    const alphaId = useContextsStore.getState().contexts.find((c) => c.symbol === 'α')?.id as string

    useContextsStore.getState().select(alphaId)
    await waitFor(() => expect(rowAlpha).toHaveClass('grid-row--selected'))
  })
})

// Issue 085 Phase B, test-first plan items 7-8. Decision 4 rehomes the
// Composer's one non-redundant capability (a roomier prose editor than a
// cramped cell) directly into the register's own justification cell; Decision
// 3's compose flow (per-dimension binds + justification-first phantom row)
// already lives in the row, with no Composer pickers needed.
describe('justification expand-on-focus (issue 085 Phase B, Decision 4)', () => {
  it('focusing/editing the justification cell swaps it to the rich editor; Cmd+Enter commits and collapses back to a clamped summary', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Reason')
    await user.keyboard('{Enter}')
    const row = (await screen.findByText('α')).closest('tr') as HTMLElement
    const alphaId = useContextsStore.getState().contexts.find((c) => c.symbol === 'α')?.id as string

    // Idle: a clamped summary, not yet the live editor.
    const summary = within(row).getByText('Reason')
    expect(summary).toHaveClass('grid-cell__clamp')

    // Focusing swaps the cell into the live rich editor (089 D1 P3): a
    // contentEditable seeded from the legacy plain string, NOT a textarea.
    await user.click(summary)
    const editable = within(row).getByLabelText('Justification')
    expect(editable).toHaveAttribute('contenteditable', 'true')
    expect(editable).toHaveTextContent('Reason')

    // Empty it and commit with Cmd/Ctrl+Enter — the edit persisted via the same
    // setJustification mutation, and the cell collapses back to a clamped read.
    fireEvent.focus(editable)
    selectAllTextIn(editable)
    fireEvent.keyDown(editable, { key: 'Backspace' })
    await waitFor(() => expect(editable.textContent).toBe(''))
    fireEvent.keyDown(editable, { key: 'Enter', metaKey: true })

    await waitFor(() =>
      expect(useContextsStore.getState().contexts.find((c) => c.id === alphaId)?.justification ?? '').toBe(
        '',
      ),
    )
    // Back to a read-mode display (no live editor lingering in the row).
    await waitFor(() => expect(within(row).queryByLabelText('Justification')).not.toBeInTheDocument())
  })

  it('bold via the global FormatStrip applies to the focused justification cell (089 D1 P3)', async () => {
    const user = userEvent.setup()
    render(
      <>
        <FormatStrip />
        <ContextRegister projectId={projectId} />
      </>,
    )
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Reason')
    await user.keyboard('{Enter}')
    const row = (await screen.findByText('α')).closest('tr') as HTMLElement

    const bold = screen.getByRole('button', { name: 'Bold' })
    expect(bold).toHaveAttribute('aria-disabled', 'true')

    // Focusing the justification cell's editor lights the global strip (the P1
    // focused-editor registry binds it to whichever rich editor is focused).
    await user.click(within(row).getByText('Reason'))
    const editable = within(row).getByLabelText('Justification')
    fireEvent.focus(editable)
    await waitFor(() => expect(bold).not.toHaveAttribute('aria-disabled'))

    // Selecting the prose and clicking Bold wraps it — the strip acts on the
    // focused justification cell, not the (retired) existing_scenario editor.
    selectAllTextIn(editable)
    await user.click(bold)
    await waitFor(() => expect(editable.querySelector('strong')).toBeInTheDocument())
  })

  it('the collapsed summary clamps to a single line; the editor carries a comfortable min-width/height floor (Decision 4)', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles/base.css'), 'utf-8')
    expect(css).toMatch(/\.grid-cell__clamp\s*\{[^}]*-webkit-line-clamp:\s*1;/)
    expect(css).toMatch(/\.grid-cell__input--multiline\s*\{[^}]*min-height:/)
    expect(css).toMatch(/\.grid-cell__input--multiline\s*\{[^}]*min-width:/)
  })

  it('composes a new context justification-first via the phantom row, then binds each dimension via its own combobox — no Composer strip needed', async () => {
    const user = userEvent.setup()
    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Composed inline')
    await user.keyboard('{Enter}')

    const row = (await screen.findByText('α')).closest('tr') as HTMLElement
    expect(row).toHaveClass('grid-row--draft')
    expect(within(row).getByText('Composed inline')).toBeInTheDocument()

    const buttons = within(row).getAllByRole('button')
    await user.click(buttons[0] as HTMLElement)
    await user.click(screen.getByRole('option', { name: 'Comfort' }))
    await user.click(buttons[1] as HTMLElement)
    await user.click(screen.getByRole('option', { name: 'Users' }))

    await waitFor(() => expect(row).not.toHaveClass('grid-row--draft'))
  })
})

describe('presence cues (issue 038, test-first plan #2/#3)', () => {
  beforeEach(() => {
    resetAuthStoreForTests()
    resetPresenceStoreForTests()
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
  })

  afterEach(() => {
    resetPresenceStoreForTests()
    resetAuthStoreForTests()
    vi.unstubAllEnvs()
  })

  it('a remote collaborator selecting this context renders a hollow presence cue naming them', async () => {
    const user = userEvent.setup()
    const channelFactory = fakeChannelFactory()
    useAuthStore.setState({ status: 'authenticated', user: { sub: 'self-sub', email: 'me@x.test' }, configured: true })
    usePresenceStore.getState().start('ws1', { channelFactory })

    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Reason')
    await user.keyboard('{Enter}')
    const row = (await screen.findByText('α')).closest('tr') as HTMLElement
    const alphaId = useContextsStore.getState().contexts.find((c) => c.symbol === 'α')?.id as string

    expect(within(row).queryByTitle(/is here|is editing/)).not.toBeInTheDocument()

    const peer = startPresence('ws1', { userSub: 'bob-sub', label: 'bob@x.test' }, { channelFactory })
    peer.setSelection(alphaId)

    await waitFor(() => {
      const cue = within(row).getByTitle('bob@x.test is here')
      expect(cue).toHaveAttribute('data-presence', 'selected')
    })

    peer.stop()
  })

  it('a remote collaborator editing this context renders a filled "editing" cue, distinct from just-selected', async () => {
    const user = userEvent.setup()
    const channelFactory = fakeChannelFactory()
    useAuthStore.setState({ status: 'authenticated', user: { sub: 'self-sub', email: 'me@x.test' }, configured: true })
    usePresenceStore.getState().start('ws1', { channelFactory })

    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Reason')
    await user.keyboard('{Enter}')
    const row = (await screen.findByText('α')).closest('tr') as HTMLElement
    const alphaId = useContextsStore.getState().contexts.find((c) => c.symbol === 'α')?.id as string

    const peer = startPresence('ws1', { userSub: 'bob-sub', label: 'bob@x.test' }, { channelFactory })
    peer.setSelection(alphaId)
    peer.setFocusedCell({ contextId: alphaId, field: 'justification' })

    await waitFor(() => {
      const cue = within(row).getByTitle('bob@x.test is editing')
      expect(cue).toHaveAttribute('data-presence', 'editing')
    })

    peer.stop()
  })

  it('this client editing a cell publishes its own focus over the presence channel (feeds a peer\'s hint)', async () => {
    const user = userEvent.setup()
    const channelFactory = fakeChannelFactory()
    useAuthStore.setState({ status: 'authenticated', user: { sub: 'self-sub', email: 'me@x.test' }, configured: true })
    usePresenceStore.getState().start('ws1', { channelFactory })

    const seenByPeer: PresenceWireEvent[] = []
    const peer = startPresence(
      'ws1',
      { userSub: 'bob-sub', label: 'bob' },
      { channelFactory, onEvent: (e) => seenByPeer.push(e) },
    )

    render(<ContextRegister projectId={projectId} />)
    const phantom = await screen.findByPlaceholderText(FIRST_CONTEXT_PLACEHOLDER)
    await user.type(phantom, 'Reason')
    await user.keyboard('{Enter}')
    const alphaId = useContextsStore.getState().contexts.find((c) => c.symbol === 'α')?.id as string

    await user.click(await screen.findByText('Reason'))

    await waitFor(() => {
      const latest = seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'self-sub').pop()
      expect(latest).toMatchObject({ focusedCell: { contextId: alphaId, field: 'justification' } })
    })

    peer.stop()
  })
})
