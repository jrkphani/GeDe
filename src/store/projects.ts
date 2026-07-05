import { create } from 'zustand'
import { getDatabase, type Database } from '../db/client'
import { resetDatabase, setDatabase } from './database'
import {
  archiveProject as dbArchive,
  createProject as dbCreate,
  listProjects as dbList,
  renameProject as dbRename,
  restoreProject as dbRestore,
  type ProjectRow,
} from '../db/mutations'

// The store is the only caller of the mutation layer. Components act through
// these actions; optimistic in-memory state mirrors what the row functions
// return. lastAction is a single-step inverse (issue 001) — the full command
// log replaces it in issue 006.

type Status = 'booting' | 'ready' | 'error'

interface ProjectsState {
  status: Status
  error: string | null
  projects: ProjectRow[]
  lastAction: { label: string; undo: () => Promise<void> } | null
  init: (db?: Database) => Promise<void>
  createProject: (name: string) => Promise<void>
  renameProject: (id: string, name: string) => Promise<void>
  archiveProject: (id: string) => Promise<void>
  undoLast: () => Promise<void>
}

let database: Database | null = null

const initialState = {
  status: 'booting' as Status,
  error: null,
  projects: [],
  lastAction: null,
}

export const useProjectsStore = create<ProjectsState>()((set, get) => ({
  ...initialState,

  async init(db) {
    try {
      database = db ?? (await getDatabase()).db
      setDatabase(database)
      const projects = await dbList(database)
      set({ status: 'ready', projects })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  async createProject(name) {
    const db = database
    if (!db) return
    const row = await dbCreate(db, { name })
    set({ projects: [row, ...get().projects], lastAction: null })
  },

  async renameProject(id, name) {
    const db = database
    if (!db) return
    await dbRename(db, id, name)
    // rename undo lands with the command log (006); no narration yet
    set({ projects: await dbList(db) })
  },

  async archiveProject(id) {
    const db = database
    if (!db) return
    const row = await dbArchive(db, id)
    set({
      projects: get().projects.filter((p) => p.id !== id),
      lastAction: {
        label: `Archived “${row.name}”`,
        undo: async () => {
          await dbRestore(db, id)
          set({ projects: await dbList(db), lastAction: null })
        },
      },
    })
  },

  async undoLast() {
    const action = get().lastAction
    if (action) await action.undo()
  },
}))

export function resetProjectsStore() {
  database = null
  resetDatabase()
  useProjectsStore.setState({ ...initialState })
}
