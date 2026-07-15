import { create } from 'zustand'
import {
  addTier1Prop as dbAdd,
  getTier1Purpose as dbGetPurpose,
  listTier1Props as dbList,
  removeTier1Prop as dbRemove,
  renameTier1Prop as dbRename,
  reorderTier1Prop as dbReorder,
  restoreTier1Prop as dbRestore,
  setTier1ExistingScenario as dbSetExistingScenario,
  setTier1PropDescription as dbSetDescription,
  setTier1Purpose as dbSetPurpose,
  type Tier1PropRow,
} from '../db/mutations'
import { requireDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { enqueueIfSyncing, useSyncStore } from './sync'
import { useStatusStore } from './status'

// Issue 075 Part B — the `useSyncStore.tier1AppliedAt` subscription below
// (mirrors src/store/projects.ts's own module-level syncUnsubscribe pattern,
// 072): re-`load()` re-subscribes rather than accumulating a duplicate
// listener per project-open.
let syncUnsubscribe: (() => void) | null = null

// 1st Tier Foundation state for the currently open project (issue 013): one
// purpose body + a table of ranked value propositions. Every mutating action
// pushes its inverse onto the shared command log (issue 006) — one gesture,
// one call, one undo step (a re-rank included).

interface Tier1State {
  projectId: string | null
  // The single purpose body; '' when the project has none yet.
  purpose: string
  // Issue 081 — shares tier1_purpose's one row with `purpose`; null when the
  // field has never been written (a legitimate terminal state). A
  // JSON-stringified Lexical EditorState, never HTML.
  existingScenario: string | null
  props: Tier1PropRow[]
  // Mirrors the per-scope generation guard used by contexts.ts (issue 004/007
  // CI race): Foundation's mount effect calls load(projectId) once, but a
  // mutation can complete before that initial SELECT resolves. Every mutating
  // action bumps this synchronously before awaiting; load() discards a stale
  // result if the generation moved while it was in flight.
  generation: number
  load: (projectId: string) => Promise<void>
  setPurpose: (body: string) => Promise<void>
  setExistingScenario: (existingScenario: string | null) => Promise<void>
  addProp: (name: string) => Promise<Tier1PropRow | null>
  renameProp: (id: string, name: string) => Promise<void>
  setDescription: (id: string, description: string) => Promise<void>
  reorderProp: (id: string, toIndex: number) => Promise<void>
  removeProp: (id: string) => Promise<void>
}

export const useTier1Store = create<Tier1State>()((set, get) => ({
  projectId: null,
  purpose: '',
  existingScenario: null,
  props: [],
  generation: 0,

  async load(projectId) {
    // Set the scope synchronously, before any await — a mutation firing right
    // after mount must not see a null projectId (HANDOFF race gotcha).
    const startGen = get().generation
    set({ projectId })
    const db = requireDatabase()
    const [purpose, props] = await Promise.all([dbGetPurpose(db, projectId), dbList(db, projectId)])
    if (get().generation !== startGen) return // a mutation landed mid-load; it already set fresh state
    set({ purpose: purpose?.body ?? '', existingScenario: purpose?.existingScenario ?? null, props })

    // Issue 075 Part B — load() only ever ran once per project-open, so a
    // tier1_purpose OR tier1_props delta that streamed in (or that 075A's own
    // FK-retry landed) AFTER this resolved never rendered without a remount.
    // Re-read off this store's own ground-truth signal instead, mirroring
    // 062/067/072's own refresh wiring. Reuses the SAME generation guard
    // load() itself relies on, so an in-progress local mutation always wins.
    syncUnsubscribe?.()
    syncUnsubscribe = useSyncStore.subscribe((state, prevState) => {
      if (state.tier1AppliedAt === prevState.tier1AppliedAt) return
      const { projectId: currentProjectId } = get()
      if (currentProjectId === null) return
      const genAtStart = get().generation
      const freshDb = requireDatabase()
      void Promise.all([dbGetPurpose(freshDb, currentProjectId), dbList(freshDb, currentProjectId)]).then(
        ([freshPurpose, freshProps]) => {
          if (get().generation !== genAtStart) return
          set({
            purpose: freshPurpose?.body ?? '',
            existingScenario: freshPurpose?.existingScenario ?? null,
            props: freshProps,
          })
        },
      )
    })
  },

  async setPurpose(body) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previous = get().purpose
    // Issue 081 — Purpose and Existing Scenario SHARE one tier1_purpose row
    // (same Subtlety-A-class nuance 073 originally flagged, widened for the
    // second field): the upsert/update determination must key off whether
    // ANY tier1_purpose row already existed before this edit, not just
    // whether `purpose` itself was previously empty — a project whose only
    // prior write was setExistingScenario already has a row, so this edit
    // must be 'update', or the server's `ON CONFLICT (id) DO NOTHING`
    // silently no-ops it (the 066-class bug).
    const rowExistedBefore = get().purpose !== '' || get().existingScenario !== null
    set((s) => ({ generation: s.generation + 1 }))
    const row = await dbSetPurpose(db, projectId, body)
    set({ purpose: row?.body ?? body })
    if (row) enqueueIfSyncing('tier1_purpose', row.id, rowExistedBefore ? 'update' : 'upsert', row)
    useCommandLogStore.getState().push({
      label: 'edit purpose',
      async undo() {
        const r = await dbSetPurpose(db, projectId, previous)
        set({ purpose: r?.body ?? previous })
      },
      async redo() {
        const r = await dbSetPurpose(db, projectId, body)
        set({ purpose: r?.body ?? body })
      },
    })
  },

  // Issue 081 — mirrors setPurpose's own upsert/update subtlety, but Purpose
  // and Existing Scenario SHARE one tier1_purpose row: the enqueued op must
  // be 'upsert' only when NO tier1_purpose row existed before this edit
  // (both purpose === '' AND existingScenario === null), else 'update' — a
  // check on THIS field alone (existingScenario === null) would wrongly
  // enqueue 'upsert' for a row that already exists because Purpose was
  // written first, which the server's ON CONFLICT (id) DO NOTHING would
  // silently no-op (the 066-class bug).
  async setExistingScenario(existingScenario) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previous = get().existingScenario
    const rowExistedBefore = get().purpose !== '' || get().existingScenario !== null
    set((s) => ({ generation: s.generation + 1 }))
    const row = await dbSetExistingScenario(db, projectId, existingScenario)
    set({ existingScenario: row?.existingScenario ?? existingScenario })
    if (row) enqueueIfSyncing('tier1_purpose', row.id, rowExistedBefore ? 'update' : 'upsert', row)
    useCommandLogStore.getState().push({
      label: 'edit existing scenario',
      async undo() {
        const r = await dbSetExistingScenario(db, projectId, previous)
        set({ existingScenario: r?.existingScenario ?? previous })
      },
      async redo() {
        const r = await dbSetExistingScenario(db, projectId, existingScenario)
        set({ existingScenario: r?.existingScenario ?? existingScenario })
      },
    })
  },

  async addProp(name) {
    const { projectId } = get()
    if (projectId === null) return null
    const db = requireDatabase()
    set((s) => ({ generation: s.generation + 1 }))
    // Issue 083 Cause B — FoundationSurface.tsx's `onCreate: (name) => void
    // addProp(name)` discards this promise entirely: a rejection here
    // (dbAdd's own workspaceId resolution, db/mutations.ts's
    // projectWorkspaceId, hard-throws via firstOrThrow on a missing
    // FK-ancestor row) would otherwise vanish into the void, indistinguishable
    // from a silent no-op. Catch it here — the one place guaranteed to run
    // regardless of how the caller awaits — and announce via useStatusStore,
    // the app's one sanctioned feedback channel (mirrors tier2.ts's own
    // addTable/addEntry handling and workspace.ts's acceptInvitation).
    let row: Tier1PropRow
    try {
      row = await dbAdd(db, projectId, name)
    } catch {
      useStatusStore.getState().announce(`Couldn't add "${name}" — please try again.`)
      return null
    }
    set({ props: await dbList(db, projectId) })
    enqueueIfSyncing('tier1_props', row.id, 'upsert', row)
    const orderedIdsAfterAdd = get().props.map((p) => p.id)
    useCommandLogStore.getState().push({
      label: `add value proposition "${name}"`,
      async undo() {
        await dbRemove(db, projectId, row.id)
        set({ props: await dbList(db, projectId) })
      },
      async redo() {
        await dbRestore(db, projectId, row.id, orderedIdsAfterAdd)
        set({ props: await dbList(db, projectId) })
      },
    })
    return row
  },

  async renameProp(id, name) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previous = get().props.find((p) => p.id === id)?.name ?? name
    set((s) => ({ generation: s.generation + 1 }))
    const renamed = await dbRename(db, id, name)
    set({ props: await dbList(db, projectId) })
    enqueueIfSyncing('tier1_props', renamed.id, 'update', renamed)
    useCommandLogStore.getState().push({
      label: `rename value proposition to "${name}"`,
      async undo() {
        await dbRename(db, id, previous)
        set({ props: await dbList(db, projectId) })
      },
      async redo() {
        await dbRename(db, id, name)
        set({ props: await dbList(db, projectId) })
      },
    })
  },

  async setDescription(id, description) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previous = get().props.find((p) => p.id === id)?.description ?? ''
    set((s) => ({ generation: s.generation + 1 }))
    const updated = await dbSetDescription(db, id, description)
    set({ props: await dbList(db, projectId) })
    enqueueIfSyncing('tier1_props', updated.id, 'update', updated)
    useCommandLogStore.getState().push({
      label: 'edit value-proposition description',
      async undo() {
        await dbSetDescription(db, id, previous)
        set({ props: await dbList(db, projectId) })
      },
      async redo() {
        await dbSetDescription(db, id, description)
        set({ props: await dbList(db, projectId) })
      },
    })
  },

  async reorderProp(id, toIndex) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const before = get().props
    const fromIndex = before.findIndex((p) => p.id === id)
    set((s) => ({ generation: s.generation + 1 }))
    const after = await dbReorder(db, projectId, id, toIndex)
    set({ props: after })
    // Issue 073 Subtlety B — reorderTier1Prop's rewriteTier1PropRanks rewrites
    // sort/rank on EVERY row whose position actually moved, not just the one
    // the user dragged (db/mutations.ts:939-953). `after` is already in the
    // new sort order, so each row's index IS its new sort/rank — enqueue an
    // 'update' for every row whose previous sort/rank disagrees with it,
    // else sibling drift never reaches the server.
    const beforeById = new Map(before.map((p) => [p.id, p]))
    after.forEach((row, index) => {
      const prev = beforeById.get(row.id)
      // -1 sentinels for "no prior row" — sort/rank are always >= 0, so a
      // missing `prev` always counts as changed without an explicit `!prev` /
      // optional-chain-on-a-narrowed-value lint conflict.
      const prevSort = prev?.sort ?? -1
      const prevRank = prev?.rank ?? -1
      if (prevSort !== index || prevRank !== index + 1) {
        enqueueIfSyncing('tier1_props', row.id, 'update', row)
      }
    })
    useCommandLogStore.getState().push({
      label: 're-rank value proposition',
      async undo() {
        set({ props: await dbReorder(db, projectId, id, fromIndex) })
      },
      async redo() {
        set({ props: await dbReorder(db, projectId, id, toIndex) })
      },
    })
  },

  async removeProp(id) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const before = get().props
    const orderedIds = before.map((p) => p.id)
    const removedRow = before.find((p) => p.id === id)
    const removedName = removedRow?.name ?? ''
    set((s) => ({ generation: s.generation + 1 }))
    const after = await dbRemove(db, projectId, id)
    set({ props: after })
    // Issue 073 — the removed row is a soft-delete tombstone; removeTier1Prop
    // ALSO rewrites sort/rank on every surviving sibling to close the gap
    // (same rewriteTier1PropRanks cascade as reorderProp — Subtlety B), so
    // enqueue an 'update' for every one of those, not just the delete.
    if (removedRow) enqueueIfSyncing('tier1_props', id, 'delete', removedRow)
    const beforeById = new Map(before.map((p) => [p.id, p]))
    after.forEach((row, index) => {
      const prev = beforeById.get(row.id)
      // -1 sentinels for "no prior row" — sort/rank are always >= 0, so a
      // missing `prev` always counts as changed without an explicit `!prev` /
      // optional-chain-on-a-narrowed-value lint conflict.
      const prevSort = prev?.sort ?? -1
      const prevRank = prev?.rank ?? -1
      if (prevSort !== index || prevRank !== index + 1) {
        enqueueIfSyncing('tier1_props', row.id, 'update', row)
      }
    })
    useCommandLogStore.getState().push({
      label: `remove value proposition "${removedName}"`,
      async undo() {
        await dbRestore(db, projectId, id, orderedIds)
        set({ props: await dbList(db, projectId) })
      },
      async redo() {
        set({ props: await dbRemove(db, projectId, id) })
      },
    })
  },
}))

export function resetTier1Store(): void {
  syncUnsubscribe?.()
  syncUnsubscribe = null
  useTier1Store.setState({ projectId: null, purpose: '', existingScenario: null, props: [], generation: 0 })
}
