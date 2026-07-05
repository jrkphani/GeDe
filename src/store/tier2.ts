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
      if (get().generation !== startGen) return // a mutation landed mid-load
      const linkByEntryId: Record<string, PromotedLinkView> = {}
      for (const l of links) {
        linkByEntryId[l.entryId] = {
          parameterId: l.parameterId,
          dimensionId: l.dimensionId,
          dimensionName: l.dimensionName,
        }
      }
      set({ tables, entriesByTable, linkByEntryId, rootDimensions })
    },

    async addTable(name) {
      const { projectId } = get()
      if (projectId === null) return null
      bump()
      const row = await dbAddTable(db(), projectId, name)
      await reloadTables(projectId)
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
      await dbRenameTable(db(), id, name)
      await reloadTables(projectId)
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
      const row = await dbAddEntry(db(), tableId, parentId, name)
      await reloadEntries(tableId)
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
      await dbRenameEntry(db(), id, name)
      for (const p of linked) await renameParameter(db(), p.id, name)
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
      await dbSetEntryDescription(db(), id, description)
      await reloadEntries(tableId)
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
      const paramIds = (await listParametersBySourceEntries(db(), ids)).map((p) => p.id)
      bump()
      const priorLinks = await unlinkParametersFromEntries(db(), paramIds)
      const { removedIds } = await removeTier2EntrySubtree(db(), tableId, id)
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
      const paramIds = (await listParametersBySourceEntries(db(), ids)).map((p) => p.id)
      bump()
      const del = await deleteParametersUnbinding(db(), paramIds)
      const { removedIds } = await removeTier2EntrySubtree(db(), tableId, id)
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
  useTier2Store.setState({
    projectId: null,
    tables: [],
    entriesByTable: {},
    linkByEntryId: {},
    rootDimensions: [],
    generation: 0,
  })
}
