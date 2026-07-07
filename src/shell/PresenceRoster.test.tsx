// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { openDatabase } from '../db/client'
import { createProject } from '../db/mutations'
import { applyPresenceEvent, emptyRoster } from '../domain/presence'
import { setDatabase } from '../store/database'
import { useProjectsStore } from '../store/projects'
import { resetPresenceStoreForTests, usePresenceStore } from '../store/presence'
import { resetWorkspaceStore } from '../store/workspace'
import { PresenceRoster } from './PresenceRoster'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string
let workspaceId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetWorkspaceStore()
  resetPresenceStoreForTests()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  workspaceId = project.workspaceId
  useProjectsStore.setState({ projects: [project], status: 'ready' })
})

afterEach(() => {
  resetPresenceStoreForTests()
})

// Mirrors SyncIndicator.test.tsx's own convention: presentational assertions
// drive usePresenceStore's already-derived state directly (the roster
// reducer itself is unit-tested in src/domain/presence.test.ts; the channel
// wiring in src/presence/presenceChannel.test.ts and src/store/presence.test.ts).
describe('PresenceRoster (test-first plan #1 — join/leave in the app-bar cluster)', () => {
  it('renders nothing when nobody else is here', () => {
    const { container } = render(<PresenceRoster projectId={projectId} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a chip per online collaborator once the roster has entries', () => {
    let roster = applyPresenceEvent(emptyRoster(), {
      type: 'presence',
      userSub: 'bob-sub',
      label: 'bob@x.test',
      selectedContextId: null,
      focusedCell: null,
      at: 0,
    })
    roster = applyPresenceEvent(roster, {
      type: 'presence',
      userSub: 'carol-sub',
      label: 'carol@x.test',
      selectedContextId: null,
      focusedCell: null,
      at: 0,
    })
    usePresenceStore.setState({ enabled: true, workspaceId, selfSub: 'self-sub', roster })

    render(<PresenceRoster projectId={projectId} />)
    expect(screen.getByTitle('bob@x.test')).toBeInTheDocument()
    expect(screen.getByTitle('carol@x.test')).toBeInTheDocument()
  })

  it('never shows a chip for self', () => {
    const roster = applyPresenceEvent(emptyRoster(), {
      type: 'presence',
      userSub: 'self-sub',
      label: 'me@x.test',
      selectedContextId: null,
      focusedCell: null,
      at: 0,
    })
    usePresenceStore.setState({ enabled: true, workspaceId, selfSub: 'self-sub', roster })

    const { container } = render(<PresenceRoster projectId={projectId} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('PresenceRoster — lifecycle (starts/stops presence for the project\'s workspace)', () => {
  it('calls start() with the project\'s workspace id on mount, and stop() on unmount', async () => {
    const startSpy = vi.fn()
    const stopSpy = vi.fn()
    usePresenceStore.setState({ start: startSpy, stop: stopSpy })

    const { unmount } = render(<PresenceRoster projectId={projectId} />)
    await waitFor(() => expect(startSpy).toHaveBeenCalledWith(workspaceId))

    unmount()
    expect(stopSpy).toHaveBeenCalled()
  })
})
