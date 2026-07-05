import { create } from 'zustand'

// TECH_STACK §5 — a command-log middleware, shared by every store, replacing
// the single-step lastAction/undoLast pattern (issue 001). Each store action
// pushes one Command carrying its own inverse; undo/redo replay through the
// same mutation layer so persistence never desyncs from the in-memory state
// (issue 006). Session-scoped: cleared on project switch (AppShell), never
// persisted.

export interface Command {
  label: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

const MAX_DEPTH = 200

interface CommandLogState {
  past: Command[]
  future: Command[]
  // Non-null while inside batch(): push() collects here instead of `past` so
  // one user gesture spanning several store calls (e.g. create + first
  // justification) becomes one undo step.
  batching: Command[] | null
  push: (cmd: Command) => void
  undo: () => Promise<void>
  redo: () => Promise<void>
  batch: <T>(label: string, fn: () => Promise<T>) => Promise<T>
  clear: () => void
}

export const useCommandLogStore = create<CommandLogState>()((set, get) => ({
  past: [],
  future: [],
  batching: null,

  push(cmd) {
    const { batching } = get()
    if (batching) {
      batching.push(cmd)
      return
    }
    set((s) => ({ past: [...s.past, cmd].slice(-MAX_DEPTH), future: [] }))
  },

  async undo() {
    const { past } = get()
    const command = past[past.length - 1]
    if (!command) return
    await command.undo()
    set((s) => ({ past: s.past.slice(0, -1), future: [...s.future, command] }))
  },

  async redo() {
    const { future } = get()
    const command = future[future.length - 1]
    if (!command) return
    await command.redo()
    set((s) => ({ future: s.future.slice(0, -1), past: [...s.past, command] }))
  },

  async batch(label, fn) {
    const outerBatch = get().batching
    const collector = outerBatch ?? []
    if (!outerBatch) set({ batching: collector })
    let result: Awaited<ReturnType<typeof fn>>
    try {
      result = await fn()
    } catch (err) {
      if (!outerBatch) set({ batching: null })
      throw err
    }
    if (!outerBatch) {
      set({ batching: null })
      if (collector.length > 0) {
        const combined: Command = {
          label,
          async undo() {
            for (const c of [...collector].reverse()) await c.undo()
          },
          async redo() {
            for (const c of collector) await c.redo()
          },
        }
        set((s) => ({ past: [...s.past, combined].slice(-MAX_DEPTH), future: [] }))
      }
    }
    return result
  },

  clear() {
    set({ past: [], future: [], batching: null })
  },
}))
