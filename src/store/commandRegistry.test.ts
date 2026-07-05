import { afterEach, describe, expect, it } from 'vitest'
import type { CommandItem } from '../domain/paletteRanking'
import { resetCommandRegistry, useCommandRegistryStore } from './commandRegistry'

const noop = () => {}
function verb(id: string, title: string): CommandItem {
  return { id, kind: 'action', title, run: noop }
}

afterEach(() => resetCommandRegistry())

describe('command registry', () => {
  it('collects commands a feature registers, with no palette involvement', () => {
    useCommandRegistryStore.getState().registerCommand(verb('export', 'Export project…'))
    const ids = useCommandRegistryStore
      .getState()
      .collect()
      .map((c) => c.id)
    expect(ids).toContain('export')
  })

  it('unregisters when the returned disposer is called', () => {
    const dispose = useCommandRegistryStore.getState().registerCommand(verb('export', 'Export project…'))
    dispose()
    expect(useCommandRegistryStore.getState().collect()).toHaveLength(0)
  })

  it('supports dynamic providers that read live state each collect', () => {
    let live: CommandItem[] = []
    useCommandRegistryStore.getState().registerProvider(() => live)
    expect(useCommandRegistryStore.getState().collect()).toHaveLength(0)
    live = [verb('a', 'A'), verb('b', 'B')]
    expect(useCommandRegistryStore.getState().collect()).toHaveLength(2)
  })

  it('de-duplicates items sharing an id across providers', () => {
    useCommandRegistryStore.getState().registerProvider(() => [verb('x', 'First')])
    useCommandRegistryStore.getState().registerProvider(() => [verb('x', 'Second')])
    const collected = useCommandRegistryStore.getState().collect()
    expect(collected).toHaveLength(1)
    expect(collected[0]?.title).toBe('First')
  })

  it('tracks recency most-recent-first, without duplicates', () => {
    const store = useCommandRegistryStore.getState()
    store.markUsed('a')
    store.markUsed('b')
    store.markUsed('a')
    expect(useCommandRegistryStore.getState().recentIds).toEqual(['a', 'b'])
  })
})
