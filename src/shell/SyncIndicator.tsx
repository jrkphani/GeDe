import { useSyncStore } from '../store/sync'
import { syncStatusLabel } from '../domain/syncStatus'

// Issue 036 — the status bar's right cluster (SITEMAP §5: "v2 adds sync
// state here", beside drafts/coverage/version). Purely presentational: reads
// the already-derived SyncStatus (src/domain/syncStatus.ts, wired live in
// src/store/sync.ts) and renders its numerate label (STYLE_GUIDE §9) — no
// state decisions live here. Renders nothing while sync isn't enabled (v1's
// tested default): there is no honest sync state to show for a single-user,
// no-network build, and the status bar shouldn't clutter with a permanently
// inert indicator.
//
// This is ambient chrome, like the adjacent version span — not the
// interruptive narration channel (`useStatusStore`, 016's single feedback
// channel / no toasts). The transient, quiet lost-edit note (test-first plan
// #3) is what flows through `useStatusStore.announce` (src/store/sync.ts);
// this indicator is the always-visible "is my work saved" readout the issue's
// slice asks for, mirroring how the version number is always-visible chrome
// rather than a status-store message.
export function SyncIndicator() {
  const enabled = useSyncStore((s) => s.enabled)
  const status = useSyncStore((s) => s.status)
  const pendingCount = useSyncStore((s) => s.pendingCount)

  if (!enabled) return null

  return (
    <span className="status-bar__sync" data-sync-status={status}>
      {syncStatusLabel(status, pendingCount)}
    </span>
  )
}
