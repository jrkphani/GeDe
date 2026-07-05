import { create } from 'zustand'
import type { CommandItem } from '../domain/paletteRanking'

// Issue 017 — the verb/command registry. The shell exposes this so features
// "register commands" (issue 016 seam) while the palette stays feature-
// agnostic: it reads only this store, never a feature module. A source is a
// function so dynamic contributors (the live context list) re-read state on
// every collect; a single static verb is just sugar over a one-item source.

export type CommandProvider = () => CommandItem[]

interface CommandRegistryState {
  providers: readonly CommandProvider[]
  // Most-recent-first ids of executed commands — drives the palette's
  // recent-first ordering (SITEMAP §3). Session-scoped, in-memory.
  recentIds: readonly string[]
  registerProvider: (provider: CommandProvider) => () => void
  registerCommand: (command: CommandItem) => () => void
  collect: () => CommandItem[]
  markUsed: (id: string) => void
}

const RECENTS_LIMIT = 20

export const useCommandRegistryStore = create<CommandRegistryState>()((set, get) => ({
  providers: [],
  recentIds: [],

  registerProvider(provider) {
    set((s) => ({ providers: [...s.providers, provider] }))
    return () => set((s) => ({ providers: s.providers.filter((p) => p !== provider) }))
  },

  registerCommand(command) {
    return get().registerProvider(() => [command])
  },

  collect() {
    const seen = new Set<string>()
    const out: CommandItem[] = []
    for (const provider of get().providers) {
      for (const item of provider()) {
        // First registration of an id wins — a feature can't clobber a core
        // command by reusing its id, and duplicate ids never double-render.
        if (seen.has(item.id)) continue
        seen.add(item.id)
        out.push(item)
      }
    }
    return out
  },

  markUsed(id) {
    set((s) => ({ recentIds: [id, ...s.recentIds.filter((x) => x !== id)].slice(0, RECENTS_LIMIT) }))
  },
}))

export function resetCommandRegistry(): void {
  useCommandRegistryStore.setState({ providers: [], recentIds: [] })
}
