import { create } from 'zustand'
import {
  addTier1Prop as dbAdd,
  getTier1Purpose as dbGetPurpose,
  listTier1Props as dbList,
  removeTier1Prop as dbRemove,
  renameTier1Prop as dbRename,
  reorderTier1Prop as dbReorder,
  restoreTier1Prop as dbRestore,
  setTier1PropDescription as dbSetDescription,
  setTier1Purpose as dbSetPurpose,
  type Tier1PropRow,
} from '../db/mutations'
import { requireDatabase } from './database'
import { useCommandLogStore } from './commandLog'

// 1st Tier Foundation state for the currently open project (issue 013): one
// purpose body + a table of ranked value propositions. Every mutating action
// pushes its inverse onto the shared command log (issue 006) — one gesture,
// one call, one undo step (a re-rank included).

interface Tier1State {
  projectId: string | null
  // The single purpose body; '' when the project has none yet.
  purpose: string
  props: Tier1PropRow[]
  // Mirrors the per-scope generation guard used by contexts.ts (issue 004/007
  // CI race): Foundation's mount effect calls load(projectId) once, but a
  // mutation can complete before that initial SELECT resolves. Every mutating
  // action bumps this synchronously before awaiting; load() discards a stale
  // result if the generation moved while it was in flight.
  generation: number
  load: (projectId: string) => Promise<void>
  setPurpose: (body: string) => Promise<void>
  addProp: (name: string) => Promise<Tier1PropRow | null>
  renameProp: (id: string, name: string) => Promise<void>
  setDescription: (id: string, description: string) => Promise<void>
  reorderProp: (id: string, toIndex: number) => Promise<void>
  removeProp: (id: string) => Promise<void>
}

export const useTier1Store = create<Tier1State>()((set, get) => ({
  projectId: null,
  purpose: '',
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
    set({ purpose: purpose?.body ?? '', props })
  },

  async setPurpose(body) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previous = get().purpose
    set((s) => ({ generation: s.generation + 1 }))
    const row = await dbSetPurpose(db, projectId, body)
    set({ purpose: row?.body ?? body })
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

  async addProp(name) {
    const { projectId } = get()
    if (projectId === null) return null
    const db = requireDatabase()
    set((s) => ({ generation: s.generation + 1 }))
    const row = await dbAdd(db, projectId, name)
    set({ props: await dbList(db, projectId) })
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
    await dbRename(db, id, name)
    set({ props: await dbList(db, projectId) })
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
    await dbSetDescription(db, id, description)
    set({ props: await dbList(db, projectId) })
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
    const fromIndex = get().props.findIndex((p) => p.id === id)
    set((s) => ({ generation: s.generation + 1 }))
    set({ props: await dbReorder(db, projectId, id, toIndex) })
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
    const orderedIds = get().props.map((p) => p.id)
    const removedName = get().props.find((p) => p.id === id)?.name ?? ''
    set((s) => ({ generation: s.generation + 1 }))
    set({ props: await dbRemove(db, projectId, id) })
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
  useTier1Store.setState({ projectId: null, purpose: '', props: [], generation: 0 })
}
