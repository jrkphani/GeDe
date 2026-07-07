// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SyncIndicator } from './SyncIndicator'
import { resetSyncStore, useSyncStore } from '../store/sync'

// Issue 036, test-first plan #1: given each sync state, the indicator
// renders the correct label; `offline` shows the pending count. Presentational
// — the component only reads useSyncStore's already-derived `status` (the
// pure decision lives in src/domain/syncStatus.ts, unit-tested there), so
// these tests just drive the store's public state directly.

beforeEach(() => {
  resetSyncStore()
})

describe('SyncIndicator', () => {
  it('renders nothing when sync is disabled (v1 default — no status to show)', () => {
    render(<SyncIndicator />)
    expect(screen.queryByText(/synced|syncing|offline|reconnecting|sync error/i)).toBeNull()
  })

  it('renders "Synced" when caught up', () => {
    useSyncStore.setState({ enabled: true, status: 'synced', pendingCount: 0 })
    render(<SyncIndicator />)
    expect(screen.getByText('Synced')).toBeInTheDocument()
  })

  it('renders "Syncing…" while catching up', () => {
    useSyncStore.setState({ enabled: true, status: 'syncing', pendingCount: 0 })
    render(<SyncIndicator />)
    expect(screen.getByText('Syncing…')).toBeInTheDocument()
  })

  it('renders "Offline · N pending" with the live pending count', () => {
    useSyncStore.setState({ enabled: true, status: 'offline', pendingCount: 4 })
    render(<SyncIndicator />)
    expect(screen.getByText('Offline · 4 pending')).toBeInTheDocument()
  })

  it('renders "Reconnecting…"', () => {
    useSyncStore.setState({ enabled: true, status: 'reconnecting', pendingCount: 2 })
    render(<SyncIndicator />)
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
  })

  it('renders "Sync error"', () => {
    useSyncStore.setState({ enabled: true, status: 'error', pendingCount: 0 })
    render(<SyncIndicator />)
    expect(screen.getByText('Sync error')).toBeInTheDocument()
  })

  it('carries the status as a data attribute for styling, not color alone (a11y baseline)', () => {
    useSyncStore.setState({ enabled: true, status: 'synced', pendingCount: 0 })
    render(<SyncIndicator />)
    expect(screen.getByText('Synced')).toHaveAttribute('data-sync-status', 'synced')
  })
})
