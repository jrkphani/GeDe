// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

let projectId: string

beforeEach(async () => {
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

    await user.click(within(row).getByText('Reason'))
    const textarea = screen.getByDisplayValue('Reason')
    await user.clear(textarea)
    await user.keyboard('{Enter}')

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
