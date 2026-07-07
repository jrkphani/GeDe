import { uuidv7 } from 'uuidv7'
import { create } from 'zustand'
import { getDatabase, type Database } from '../db/client'
import { resetDatabase, setDatabase } from './database'
import { useAuthStore } from './auth'
import { useCommandLogStore } from './commandLog'
import { useSyncStore } from './sync'
import {
  archiveProject as dbArchive,
  createProject as dbCreate,
  listProjects as dbList,
  renameProject as dbRename,
  restoreProject as dbRestore,
  type ProjectRow,
} from '../db/mutations'
import { adoptProject as dbAdopt, gatherProjectRows, importProject as dbImport } from '../db/projectIO'
import {
  getOrCreateUserWorkspace,
  listWorkspacesForUser,
  type WorkspaceRow,
} from '../db/workspaces'
import {
  ENVELOPE_TABLE_NAMES,
  envelopeToJson,
  parseEnvelope,
  serializeEnvelope,
  type EnvelopeStats,
} from '../domain/projectEnvelope'

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
  // Issue 015 — export gathers a project's rows into the versioned JSON
  // envelope; import always creates a NEW project (fresh ids) atomically and
  // throws a typed rejection (parseEnvelope) the caller renders calmly.
  exportProject: (id: string) => Promise<{ name: string; json: string }>
  importProject: (text: string) => Promise<{ project: ProjectRow; stats: EnvelopeStats }>
  // Issue 037 — the local→cloud on-ramp. Moves a local project into a
  // workspace (see src/db/projectIO.ts's adoptProject for the atomicity/
  // idempotency contract) and, for a genuinely new adoption, enqueues every
  // row of the destination copy onto the optimistic-write queue (issue 032)
  // — "push through the sync/write-path" using the existing queue plumbing,
  // since no live client→server write flush exists yet in this repo.
  adoptProject: (
    id: string,
    targetWorkspaceId: string,
  ) => Promise<{ project: ProjectRow; stats: EnvelopeStats; alreadyAdopted: boolean }>
  // The signed-in user's available adoption destinations — ensures they have
  // at least their own workspace (creating one on first use) then lists
  // every workspace they belong to, oldest first.
  listWorkspaceOptions: () => Promise<WorkspaceRow[]>
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
      // Issue 032: a no-op unless VITE_SYNC_ENABLED=true (src/sync/config.ts)
      // — v1's single-user, no-network path stays the tested default until
      // v2 ships (implementation note, test-first plan #6).
      useSyncStore.getState().start(database)
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

  async exportProject(id) {
    const db = database
    if (!db) throw new Error('Storage is unavailable')
    const name = get().projects.find((p) => p.id === id)?.name ?? 'project'
    const tables = await gatherProjectRows(db, id)
    return { name, json: envelopeToJson(serializeEnvelope(tables)) }
  },

  async importProject(text) {
    const db = database
    if (!db) throw new Error('Storage is unavailable')
    // parseEnvelope throws NotGeDeExportError / NewerVersionError /
    // CorruptedEnvelopeError before the DB is touched; the DB import is atomic.
    const envelope = parseEnvelope(text)
    const result = await dbImport(db, envelope)
    // Re-list so the imported clone slots into persisted (updatedAt) order,
    // matching what a reload would show.
    set({ projects: await dbList(db) })
    return result
  },

  // Deliberately no command-log entry (mirrors WorkspaceMembers' own choice,
  // issue 035): adoption reaches into a shared workspace another party may
  // already see, so "undo" would read as a false promise of a purely local,
  // reversible action.
  async adoptProject(id, targetWorkspaceId) {
    const db = database
    if (!db) throw new Error('Storage is unavailable')
    const result = await dbAdopt(db, id, targetWorkspaceId)
    set({ projects: await dbList(db) })

    if (!result.alreadyAdopted) {
      const enqueue = useSyncStore.getState().enqueueLocalMutation
      const enqueuedAt = new Date().toISOString()
      for (const table of ENVELOPE_TABLE_NAMES) {
        for (const row of result.tables[table]) {
          enqueue({
            id: uuidv7(),
            table,
            rowId: row.id,
            op: 'upsert',
            row,
            optimisticUpdatedAt: row.updatedAt,
            enqueuedAt,
            status: 'pending',
          })
        }
      }
    }

    return { project: result.project, stats: result.stats, alreadyAdopted: result.alreadyAdopted }
  },

  async listWorkspaceOptions() {
    const db = database
    if (!db) throw new Error('Storage is unavailable')
    const sub = useAuthStore.getState().user?.sub
    if (!sub) throw new Error('Sign in to move a project into a workspace')
    await getOrCreateUserWorkspace(db, sub)
    return listWorkspacesForUser(db, sub)
  },
}))

export function resetProjectsStore() {
  database = null
  resetDatabase()
  useSyncStore.getState().stop()
  useProjectsStore.setState({ ...initialState })
}
