import { create } from 'zustand'
import { getDatabase, type Database } from '../db/client'
import { resetDatabase, setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
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
// return. Every mutating action pushes its inverse onto the shared command
// log (issue 006) — replacing the single-step lastAction/undoLast (issue 001).

type Status = 'booting' | 'ready' | 'error'

interface ProjectsState {
  status: Status
  error: string | null
  projects: ProjectRow[]
  init: (db?: Database) => Promise<void>
  createProject: (name: string) => Promise<void>
  renameProject: (id: string, name: string) => Promise<void>
  archiveProject: (id: string) => Promise<void>
}

let database: Database | null = null

const initialState = {
  status: 'booting' as Status,
  error: null,
  projects: [],
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
    set({ projects: [row, ...get().projects] })
    useCommandLogStore.getState().push({
      label: `create project "${row.name}"`,
      async undo() {
        await dbArchive(db, row.id)
        set({ projects: await dbList(db) })
      },
      async redo() {
        await dbRestore(db, row.id)
        set({ projects: await dbList(db) })
      },
    })
  },

  async renameProject(id, name) {
    const db = database
    if (!db) return
    const previousName = get().projects.find((p) => p.id === id)?.name ?? name
    await dbRename(db, id, name)
    set({ projects: await dbList(db) })
    useCommandLogStore.getState().push({
      label: `rename project to "${name}"`,
      async undo() {
        await dbRename(db, id, previousName)
        set({ projects: await dbList(db) })
      },
      async redo() {
        await dbRename(db, id, name)
        set({ projects: await dbList(db) })
      },
    })
  },

  async archiveProject(id) {
    const db = database
    if (!db) return
    const row = await dbArchive(db, id)
    set({ projects: get().projects.filter((p) => p.id !== id) })
    useCommandLogStore.getState().push({
      label: `archive "${row.name}"`,
      async undo() {
        await dbRestore(db, id)
        set({ projects: await dbList(db) })
      },
      async redo() {
        await dbArchive(db, id)
        set({ projects: get().projects.filter((p) => p.id !== id) })
      },
    })
  },
}))

export function resetProjectsStore() {
  database = null
  resetDatabase()
  useProjectsStore.setState({ ...initialState })
}
