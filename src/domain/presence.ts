// Issue 038 — presence's pure core: no React, no store, no DB (ADR-0005
// spirit — this module never imports `src/db/**`, and never will, since
// presence is deliberately an ephemeral channel that never becomes a synced
// row; see this issue's design brief and src/presence/presenceChannel.ts's
// own header). A roster reducer + the cue derivations the UI reads, shared by
// the store layer (src/store/presence.ts) and its tests the same way
// src/domain/syncDelta.ts is shared by 032's store/db layers.
import { hashContent } from './contentHash'
import { presenceColor } from '../theme/palette'

// The grain a "same-cell concurrent edit" hint needs (test-first plan #3):
// a context row plus which field on it — a dimension id for a binding cell,
// or a fixed key ('symbol' | 'justification') for those columns. Opaque
// string by design, mirroring how bindingsByContext is already keyed by
// dimension id elsewhere in this codebase — this module doesn't need to know
// the difference.
export interface FocusedCell {
  contextId: string
  field: string
}

export interface PresenceEntry {
  userSub: string
  label: string
  color: string
  selectedContextId: string | null
  focusedCell: FocusedCell | null
  lastSeen: number
}

// The wire protocol a PresenceChannelLike (src/presence/presenceChannel.ts)
// carries. `hello` is a handshake only — a newly-joined tab asks existing
// peers to reannounce so its roster doesn't sit empty until the next
// heartbeat (BroadcastChannel/any pub-sub channel has no replay for late
// subscribers) — it never itself represents a presence fact, so
// applyPresenceEvent below leaves the roster untouched for it.
export type PresenceWireEvent =
  | {
      type: 'presence'
      userSub: string
      label: string
      selectedContextId: string | null
      focusedCell: FocusedCell | null
      at: number
    }
  | { type: 'leave'; userSub: string; at: number }
  | { type: 'hello'; userSub: string; at: number }

export type PresenceRoster = ReadonlyMap<string, PresenceEntry>

export function emptyRoster(): PresenceRoster {
  return new Map()
}

// Deterministic per-user identity color (ADR-0005 spirit: no randomness,
// same seeding-by-hash approach as 028's canvas node positions) — a small
// hash of the Cognito `sub` picks a slot in the presence palette, which is
// disjoint from the dimension data palette (src/theme/palette.ts's own doc
// comment) so a collaborator's cue never reads as a dimension.
export function assignPresenceColor(userSub: string): string {
  const hash = hashContent(userSub)
  const slot = parseInt(hash.slice(0, 6), 36)
  return presenceColor(slot)
}

// The roster reducer — the one place a PresenceWireEvent becomes roster
// state. `presence` upserts (last message wins; ephemeral chrome has no LWW
// timestamp-guard requirement the way 032's synced rows do — a stale event
// arriving after a fresher one is a rare, low-stakes ordering blip for
// ambient chrome, not domain data). `leave` deletes. `hello` is a no-op here
// (see the wire-event doc comment above) — handled instead where it belongs,
// as a transport-level handshake in presenceChannel.ts.
export function applyPresenceEvent(roster: PresenceRoster, event: PresenceWireEvent): PresenceRoster {
  switch (event.type) {
    case 'leave': {
      if (!roster.has(event.userSub)) return roster
      const next = new Map(roster)
      next.delete(event.userSub)
      return next
    }
    case 'presence': {
      const next = new Map(roster)
      next.set(event.userSub, {
        userSub: event.userSub,
        label: event.label,
        color: assignPresenceColor(event.userSub),
        selectedContextId: event.selectedContextId,
        focusedCell: event.focusedCell,
        lastSeen: event.at,
      })
      return next
    }
    case 'hello':
      return roster
  }
}

// A tab that crashes/loses network without ever publishing `leave` would
// otherwise strand a ghost roster entry forever — pruned once its last
// heartbeat is older than `timeoutMs`. Returns the same reference when
// nothing changed (referential stability — no gratuitous store update/
// re-render when the roster is already current).
export function pruneStale(roster: PresenceRoster, now: number, timeoutMs: number): PresenceRoster {
  let next: Map<string, PresenceEntry> | null = null
  for (const [sub, entry] of roster) {
    if (now - entry.lastSeen > timeoutMs) {
      next ??= new Map(roster)
      next.delete(sub)
    }
  }
  return next ?? roster
}

// Every roster entry except the caller's own — sorted by userSub for a
// stable render order (never insertion order, which would jitter as peers
// join/leave/reannounce).
export function othersInRoster(roster: PresenceRoster, selfSub: string | null): PresenceEntry[] {
  return [...roster.values()].filter((e) => e.userSub !== selfSub).sort((a, b) => a.userSub.localeCompare(b.userSub))
}

// Test-first plan #2 — the ephemeral "selected context" cue: who else (not
// self) currently has this context selected.
export function selectorsOfContext(roster: PresenceRoster, contextId: string, selfSub: string | null): PresenceEntry[] {
  return othersInRoster(roster, selfSub).filter((e) => e.selectedContextId === contextId)
}

// Test-first plan #3 — the "X is editing" same-cell hint's row-grain source:
// who else (not self) has a cell open on this context. (The UI surfaces this
// at row grain; the underlying data is field-grain — see ContextRegister's
// own comment on why the visible hint doesn't currently narrow to the exact
// field.)
export function editorsOfContext(roster: PresenceRoster, contextId: string, selfSub: string | null): PresenceEntry[] {
  return othersInRoster(roster, selfSub).filter((e) => e.focusedCell?.contextId === contextId)
}

// STYLE_GUIDE §9 voice: quiet, specific, numerate — never a name dump once a
// workspace has more than a couple of concurrent collaborators.
export function presenceCueLabel(entries: readonly PresenceEntry[], verb: 'editing' | 'here'): string {
  const [a, b] = entries
  if (!a) return ''
  if (!b) return `${a.label} is ${verb}`
  if (entries.length === 2) return `${a.label} and ${b.label} are ${verb}`
  return `${entries.length} people are ${verb}`
}

// Heartbeat cadence + the timeout pruneStale uses — presence.ts owns both
// constants since they're a matched pair (timeout must exceed a few missed
// heartbeats, not an independent tuning knob). Not a promise about the ≤100ms
// motion budget (STYLE_GUIDE §8) — that's about a cue's own visual
// transition once data arrives, not how often a peer reannounces itself.
export const PRESENCE_HEARTBEAT_MS = 15_000
export const PRESENCE_TIMEOUT_MS = 45_000
