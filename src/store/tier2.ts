import { create } from 'zustand'
import {
  addTier2Entry as dbAddEntry,
  addTier2Table as dbAddTable,
  countBindingsForParameter,
  deleteParametersUnbinding,
  listDimensions,
  listParameters,
  listParametersBySourceEntries,
  listPromotedLinks,
  listTier2Entries as dbListEntries,
  listTier2Tables as dbListTables,
  promoteEntries,
  relinkParameters,
  removeParameter,
  removeTier2EntrySubtree,
  removeTier2Table as dbRemoveTable,
  renameParameter,
  renameTier2Entry as dbRenameEntry,
  renameTier2Table as dbRenameTable,
  restoreDimension,
  restoreParameter,
  restoreParametersWithBindings,
  restoreTier2EntrySubtree,
  restoreTier2Table as dbRestoreTable,
  setTier2EntryDescription as dbSetEntryDescription,
  undoAddDimension,
  unlinkParametersFromEntries,
  type DimensionRow,
  type PromoteInput,
  type PromoteOutcome,
  type Tier2EntryRow,
  type Tier2TableRow,
} from '../db/mutations'
import { subtreeIds } from '../domain/entryTree'
import { requireDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { enqueueIfSyncing, useSyncStore } from './sync'
import { useStatusStore } from './status'

// Issue 075 Part B — the `useSyncStore.tier2AppliedAt` subscription below
// (mirrors src/store/projects.ts's own module-level syncUnsubscribe pattern,
// 072): re-`load()` re-subscribes rather than accumulating a duplicate
// listener per project-open.
let syncUnsubscribe: (() => void) | null = null

// 2nd-Tier Architecture state for the open project (issue 014): nested-row
// tables + the tier-linkage back to 3rd-Tier dimensions/parameters
// (invariant 7). Every mutating action pushes one undo step on the shared
// command log (issue 006). Promote seeds/extends the root canvas but does NOT
// hold canvas state here — the Design surface reloads dimensions/parameters
// from the DB on mount, so there is no cross-store subscription to keep in sync.

export interface EntryLink {
  parameterId: string
  parameterName: string
  dimensionId: string
  boundContextCount: number
}

// Deleting a linked entry is never a silent cascade (design brief): the store
// returns a typed result and the surface anchors the resolution popover.
export type RemoveEntryResult =
  | { kind: 'removed' }
  | { kind: 'needs-resolution'; tableId: string; entryId: string; links: EntryLink[] }

interface PromotedLinkView {
  parameterId: string
  dimensionId: string
  dimensionName: string
}

// Issue 073 Subtlety B — removeTier2EntrySubtree soft-deletes every entry in
// the subtree AND rewrites `sort` on the removed root's surviving siblings to
// close the gap (rewriteEntrySiblingSort, db/mutations.ts:1095-1101) — shared
// by removeEntry/resolveKeep/resolveDeleteParams below. Enqueues a 'delete'
// for every tombstoned row (using its last known pre-delete state — the
// server's delete branch ignores the payload and stamps deleted_at/updated_at
// from clientUpdatedAt regardless, src/server/writeApi/store.ts) and an
// 'update' for every surviving sibling whose sort actually moved.
function enqueueEntryRemoval(
  before: readonly Tier2EntryRow[],
  removedIds: readonly string[],
  after: readonly Tier2EntryRow[],
): void {
  const beforeById = new Map(before.map((e) => [e.id, e]))
  for (const removedId of removedIds) {
    const prevRow = beforeById.get(removedId)
    if (prevRow) enqueueIfSyncing('tier2_entries', removedId, 'delete', prevRow)
  }
  for (const row of after) {
    const prev = beforeById.get(row.id)
    if (prev && prev.sort !== row.sort) enqueueIfSyncing('tier2_entries', row.id, 'update', row)
  }
}

interface Tier2State {
  projectId: string | null
  tables: Tier2TableRow[]
  entriesByTable: Record<string, Tier2EntryRow[]>
  // entryId → the parameter/dimension it was promoted into (source badge).
  linkByEntryId: Record<string, PromotedLinkView>
  // Root-canvas dimensions, read-only here — the promote popover offers them as
  // "extend an existing dimension" targets. The Design surface owns their
  // authoring; this is a projection kept fresh across promote/undo/redo.
  rootDimensions: DimensionRow[]
  // Generation guard (HANDOFF race): mount effects call load() while a mutation
  // may already be in flight; every mutation bumps this synchronously and
  // load() discards a stale read.
  generation: number
  load: (projectId: string) => Promise<void>
  addTable: (name: string) => Promise<Tier2TableRow | null>
  renameTable: (id: string, name: string) => Promise<void>
  addEntry: (tableId: string, parentId: string | null, name: string) => Promise<Tier2EntryRow | null>
  renameEntry: (tableId: string, id: string, name: string) => Promise<number>
  setEntryDescription: (tableId: string, id: string, description: string) => Promise<void>
  removeEntry: (tableId: string, id: string) => Promise<RemoveEntryResult>
  resolveKeep: (tableId: string, id: string) => Promise<void>
  resolveDeleteParams: (tableId: string, id: string) => Promise<void>
  promote: (input: PromoteInput) => Promise<PromoteOutcome>
}

export const useTier2Store = create<Tier2State>()((set, get) => {
  const db = () => requireDatabase()

  async function reloadTables(projectId: string) {
    const tables = await dbListTables(db(), projectId)
    const entriesByTable: Record<string, Tier2EntryRow[]> = {}
    await Promise.all(
      tables.map(async (t) => {
        entriesByTable[t.id] = await dbListEntries(db(), t.id)
      }),
    )
    set({ tables, entriesByTable })
  }

  async function reloadEntries(tableId: string) {
    set({ entriesByTable: { ...get().entriesByTable, [tableId]: await dbListEntries(db(), tableId) } })
  }

  async function refreshLinks(projectId: string) {
    const [links, rootDimensions] = await Promise.all([
      listPromotedLinks(db(), projectId),
      listDimensions(db(), projectId),
    ])
    const linkByEntryId: Record<string, PromotedLinkView> = {}
    for (const l of links) {
      linkByEntryId[l.entryId] = {
        parameterId: l.parameterId,
        dimensionId: l.dimensionId,
        dimensionName: l.dimensionName,
      }
    }
    set({ linkByEntryId, rootDimensions })
  }

  function bump() {
    set((s) => ({ generation: s.generation + 1 }))
  }

  // Issue 075 Part B — the exact read `load()` performs, factored out so the
  // delta-triggered re-read below can reuse it verbatim (never drift out of
  // sync with what a fresh mount would see).
  async function readAll(projectId: string): Promise<{
    tables: Tier2TableRow[]
    entriesByTable: Record<string, Tier2EntryRow[]>
    linkByEntryId: Record<string, PromotedLinkView>
    rootDimensions: DimensionRow[]
  }> {
    const [tables, links, rootDimensions] = await Promise.all([
      dbListTables(db(), projectId),
      listPromotedLinks(db(), projectId),
      listDimensions(db(), projectId),
    ])
    const entriesByTable: Record<string, Tier2EntryRow[]> = {}
    await Promise.all(
      tables.map(async (t) => {
        entriesByTable[t.id] = await dbListEntries(db(), t.id)
      }),
    )
    const linkByEntryId: Record<string, PromotedLinkView> = {}
    for (const l of links) {
      linkByEntryId[l.entryId] = {
        parameterId: l.parameterId,
        dimensionId: l.dimensionId,
        dimensionName: l.dimensionName,
      }
    }
    return { tables, entriesByTable, linkByEntryId, rootDimensions }
  }

  return {
    projectId: null,
    tables: [],
    entriesByTable: {},
    linkByEntryId: {},
    rootDimensions: [],
    generation: 0,

    async load(projectId) {
      const startGen = get().generation
      set({ projectId })
      const result = await readAll(projectId)
      if (get().generation !== startGen) return // a mutation landed mid-load
      set(result)

      // Issue 075 Part B — load() only ever ran once per project-open, so a
      // tier2_tables OR tier2_entries delta that streamed in (or that 075A's
      // own FK-retry landed) AFTER this resolved never rendered without a
      // remount. Re-read off this store's own ground-truth signal instead,
      // mirroring 062/067/072's own refresh wiring. Reuses the SAME
      // generation guard load() itself relies on, so an in-progress local
      // mutation always wins over a delta-triggered reload that started
      // before it.
      syncUnsubscribe?.()
      syncUnsubscribe = useSyncStore.subscribe((state, prevState) => {
        if (state.tier2AppliedAt === prevState.tier2AppliedAt) return
        const { projectId: currentProjectId } = get()
        if (currentProjectId === null) return
        const genAtStart = get().generation
        void readAll(currentProjectId).then((fresh) => {
          if (get().generation !== genAtStart) return
          set(fresh)
        })
      })
    },

    async addTable(name) {
      const { projectId } = get()
      if (projectId === null) return null
      bump()
      // Issue 083 Cause B — the add call sites (ArchitectureSurface.tsx's
      // `onSubmit={(name) => void addTable(name)}`) discard this promise
      // entirely: a rejection here (dbAddTable's own workspaceId resolution,
      // db/mutations.ts's projectWorkspaceId, hard-throws via firstOrThrow on
      // a missing FK-ancestor row) would otherwise vanish into the void,
      // indistinguishable from a silent no-op. Catch it here — the one place
      // that's guaranteed to run regardless of how the caller awaits — and
      // announce via useStatusStore, the app's one sanctioned feedback
      // channel (mirrors acceptInvitation's own server-rejection handling,
      // workspace.ts:287-295).
      let row: Tier2TableRow
      try {
        row = await dbAddTable(db(), projectId, name)
      } catch {
        useStatusStore.getState().announce(`Couldn't add "${name}" — please try again.`)
        return null
      }
      await reloadTables(projectId)
      enqueueIfSyncing('tier2_tables', row.id, 'upsert', row)
      const orderedIds = get().tables.map((t) => t.id)
      useCommandLogStore.getState().push({
        label: `add table "${name}"`,
        async undo() {
          set({ tables: await dbRemoveTable(db(), projectId, row.id) })
        },
        async redo() {
          set({ tables: await dbRestoreTable(db(), projectId, row.id, orderedIds) })
        },
      })
      return row
    },

    async renameTable(id, name) {
      const { projectId } = get()
      if (projectId === null) return
      const previous = get().tables.find((t) => t.id === id)?.name ?? name
      bump()
      const renamed = await dbRenameTable(db(), id, name)
      await reloadTables(projectId)
      enqueueIfSyncing('tier2_tables', renamed.id, 'update', renamed)
      useCommandLogStore.getState().push({
        label: `rename table to "${name}"`,
        async undo() {
          await dbRenameTable(db(), id, previous)
          await reloadTables(projectId)
        },
        async redo() {
          await dbRenameTable(db(), id, name)
          await reloadTables(projectId)
        },
      })
    },

    async addEntry(tableId, parentId, name) {
      const { projectId } = get()
      if (projectId === null) return null
      bump()
      // Issue 083 Cause B — same rationale as addTable above: addEntry's
      // fire-and-forget call sites (ArchitectureSurface.tsx's `onCreate`,
      // EditableGrid's PhantomCell) discard this promise, so a rejection
      // (dbAddEntry's tier2TableWorkspaceId, same firstOrThrow shape) must be
      // caught and announced here, not left to vanish silently.
      let row: Tier2EntryRow
      try {
        row = await dbAddEntry(db(), tableId, parentId, name)
      } catch {
        useStatusStore.getState().announce(`Couldn't add "${name}" — please try again.`)
        return null
      }
      await reloadEntries(tableId)
      enqueueIfSyncing('tier2_entries', row.id, 'upsert', row)
      useCommandLogStore.getState().push({
        label: `add "${name}"`,
        async undo() {
          await removeTier2EntrySubtree(db(), tableId, row.id)
          await reloadEntries(tableId)
        },
        async redo() {
          await restoreTier2EntrySubtree(db(), tableId, [row.id])
          await reloadEntries(tableId)
        },
      })
      return row
    },

    async renameEntry(tableId, id, name) {
      const { projectId } = get()
      if (projectId === null) return 0
      const previous = (get().entriesByTable[tableId] ?? []).find((e) => e.id === id)?.name ?? name
      const linked = await listParametersBySourceEntries(db(), [id])
      const prevParamNames = linked.map((p) => ({ id: p.id, name: p.name }))
      bump()
      const renamedEntry = await dbRenameEntry(db(), id, name)
      enqueueIfSyncing('tier2_entries', renamedEntry.id, 'update', renamedEntry)
      // Issue 073 — invariant 7's rename propagation touches every linked
      // parameter row too (a genuine edit of an already-synced row → 'update').
      for (const p of linked) {
        const renamedParam = await renameParameter(db(), p.id, name)
        enqueueIfSyncing('parameters', renamedParam.id, 'update', renamedParam)
      }
      await reloadEntries(tableId)
      await refreshLinks(projectId)
      useCommandLogStore.getState().push({
        label: `rename "${name}"`,
        async undo() {
          await dbRenameEntry(db(), id, previous)
          for (const p of prevParamNames) await renameParameter(db(), p.id, p.name)
          await reloadEntries(tableId)
          await refreshLinks(projectId)
        },
        async redo() {
          await dbRenameEntry(db(), id, name)
          for (const p of prevParamNames) await renameParameter(db(), p.id, name)
          await reloadEntries(tableId)
          await refreshLinks(projectId)
        },
      })
      return linked.length
    },

    async setEntryDescription(tableId, id, description) {
      const { projectId } = get()
      if (projectId === null) return
      const previous = (get().entriesByTable[tableId] ?? []).find((e) => e.id === id)?.description ?? ''
      bump()
      const updated = await dbSetEntryDescription(db(), id, description)
      await reloadEntries(tableId)
      enqueueIfSyncing('tier2_entries', updated.id, 'update', updated)
      useCommandLogStore.getState().push({
        label: 'edit description',
        async undo() {
          await dbSetEntryDescription(db(), id, previous)
          await reloadEntries(tableId)
        },
        async redo() {
          await dbSetEntryDescription(db(), id, description)
          await reloadEntries(tableId)
        },
      })
    },

    async removeEntry(tableId, id) {
      const { projectId } = get()
      if (projectId === null) return { kind: 'removed' }
      const entries = get().entriesByTable[tableId] ?? []
      const ids = subtreeIds(entries, id)
      const linked = await listParametersBySourceEntries(db(), ids)
      if (linked.length > 0) {
        const links: EntryLink[] = await Promise.all(
          linked.map(async (p) => ({
            parameterId: p.id,
            parameterName: p.name,
            dimensionId: p.dimensionId,
            boundContextCount: await countBindingsForParameter(db(), p.id),
          })),
        )
        return { kind: 'needs-resolution', tableId, entryId: id, links }
      }
      bump()
      const { entries: after, removedIds } = await removeTier2EntrySubtree(db(), tableId, id)
      set({ entriesByTable: { ...get().entriesByTable, [tableId]: after } })
      enqueueEntryRemoval(entries, removedIds, after)
      useCommandLogStore.getState().push({
        label: 'delete entry',
        async undo() {
          await restoreTier2EntrySubtree(db(), tableId, removedIds)
          await reloadEntries(tableId)
        },
        async redo() {
          await removeTier2EntrySubtree(db(), tableId, id)
          await reloadEntries(tableId)
        },
      })
      return { kind: 'removed' }
    },

    async resolveKeep(tableId, id) {
      const { projectId } = get()
      if (projectId === null) return
      const entries = get().entriesByTable[tableId] ?? []
      const ids = subtreeIds(entries, id)
      const linkedParams = await listParametersBySourceEntries(db(), ids)
      const paramIds = linkedParams.map((p) => p.id)
      bump()
      const priorLinks = await unlinkParametersFromEntries(db(), paramIds)
      // Issue 073 — unlinkParametersFromEntries clears sourceEntryId on every
      // linked parameter (a genuine edit of an already-synced row → 'update').
      // It returns only the prior {id, sourceEntryId} pairs, not the full row,
      // so the enqueued payload is built from the pre-mutation row we already
      // fetched (linkedParams) with sourceEntryId nulled — matches exactly
      // what the DB just wrote; the server stamps updatedAt from this
      // envelope's own clientUpdatedAt regardless (src/server/writeApi/store.ts).
      const unlinkedAt = new Date().toISOString()
      for (const p of linkedParams) {
        enqueueIfSyncing('parameters', p.id, 'update', { ...p, sourceEntryId: null, updatedAt: unlinkedAt })
      }
      const { entries: after, removedIds } = await removeTier2EntrySubtree(db(), tableId, id)
      enqueueEntryRemoval(entries, removedIds, after)
      await reloadEntries(tableId)
      await refreshLinks(projectId)
      useCommandLogStore.getState().push({
        label: 'unlink parameter, delete entry',
        async undo() {
          await restoreTier2EntrySubtree(db(), tableId, removedIds)
          await relinkParameters(db(), priorLinks)
          await reloadEntries(tableId)
          await refreshLinks(projectId)
        },
        async redo() {
          await unlinkParametersFromEntries(db(), paramIds)
          await removeTier2EntrySubtree(db(), tableId, id)
          await reloadEntries(tableId)
          await refreshLinks(projectId)
        },
      })
    },

    async resolveDeleteParams(tableId, id) {
      const { projectId } = get()
      if (projectId === null) return
      const entries = get().entriesByTable[tableId] ?? []
      const ids = subtreeIds(entries, id)
      const linkedParams = await listParametersBySourceEntries(db(), ids)
      const paramIds = linkedParams.map((p) => p.id)
      bump()
      const del = await deleteParametersUnbinding(db(), paramIds)
      // Issue 073 — deleteParametersUnbinding soft-deletes every linked
      // parameter and HARD-deletes every binding pointing at them
      // (db/mutations.ts's own doc comment). A hard local delete still needs
      // a synced 'delete' envelope so the server tombstones its own row — the
      // delete branch ignores payload content and stamps deleted_at/updated_at
      // from clientUpdatedAt regardless, so the last-known row is a safe payload.
      const deletedAt = new Date().toISOString()
      for (const p of linkedParams) {
        enqueueIfSyncing('parameters', p.id, 'delete', { ...p, deletedAt, updatedAt: deletedAt })
      }
      for (const b of del.deletedBindings) {
        enqueueIfSyncing('bindings', b.id, 'delete', b)
      }
      const { entries: after, removedIds } = await removeTier2EntrySubtree(db(), tableId, id)
      enqueueEntryRemoval(entries, removedIds, after)
      await reloadEntries(tableId)
      await refreshLinks(projectId)
      useCommandLogStore.getState().push({
        label: 'delete parameter and entry',
        async undo() {
          await restoreTier2EntrySubtree(db(), tableId, removedIds)
          await restoreParametersWithBindings(db(), del.removedParameters, del.deletedBindings)
          await reloadEntries(tableId)
          await refreshLinks(projectId)
        },
        async redo() {
          await deleteParametersUnbinding(db(), paramIds)
          await removeTier2EntrySubtree(db(), tableId, id)
          await reloadEntries(tableId)
          await refreshLinks(projectId)
        },
      })
    },

    async promote(input) {
      bump()
      const outcome = await promoteEntries(db(), input)
      const createdParamIds = outcome.createdParameters.map((p) => p.id)
      const createdDim = outcome.createdDimension
      // Issue 073 Subtlety B — promote can create BOTH a new dimension and N
      // new parameters in one gesture; promoteEntries returns the full created
      // rows directly, so enqueue an 'upsert' for every one of them (brand-new
      // rows, never edits of an existing row).
      if (createdDim) enqueueIfSyncing('dimensions', createdDim.id, 'upsert', createdDim)
      for (const p of outcome.createdParameters) enqueueIfSyncing('parameters', p.id, 'upsert', p)
      await refreshLinks(input.projectId)
      if (createdParamIds.length === 0 && createdDim === null) return outcome // nothing created

      const afterDimIds = (await listDimensions(db(), input.projectId)).map((d) => d.id)
      const afterParamIds = (await listParameters(db(), outcome.dimensionId)).map((p) => p.id)
      const target = createdDim ? outcome.dimensionId : (input.target as { dimensionId: string }).dimensionId
      useCommandLogStore.getState().push({
        label: createdDim ? `promote to new dimension "${createdDim.name}"` : 'promote to dimension',
        async undo() {
          for (const pid of createdParamIds) await removeParameter(db(), target, pid)
          if (createdDim) await undoAddDimension(db(), input.projectId, createdDim.id)
          await refreshLinks(input.projectId)
        },
        async redo() {
          if (createdDim) await restoreDimension(db(), input.projectId, createdDim.id, afterDimIds)
          for (const pid of createdParamIds) await restoreParameter(db(), target, pid, afterParamIds)
          await refreshLinks(input.projectId)
        },
      })
      return outcome
    },
  }
})

export function resetTier2Store(): void {
  syncUnsubscribe?.()
  syncUnsubscribe = null
  useTier2Store.setState({
    projectId: null,
    tables: [],
    entriesByTable: {},
    linkByEntryId: {},
    rootDimensions: [],
    generation: 0,
  })
}
