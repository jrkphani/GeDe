import { describe, expect, it } from 'vitest'
import {
  couldBeContextName,
  emptyStateMessage,
  rankCommands,
  type CommandItem,
} from './paletteRanking'

// A run() that records nothing — ranking never invokes it, so a shared noop is
// safe and keeps the fixtures readable.
const noop = () => {}

function item(partial: Partial<CommandItem> & Pick<CommandItem, 'id' | 'title'>): CommandItem {
  return { kind: 'context', run: noop, ...partial }
}

describe('rankCommands', () => {
  it('orders exact symbol match before name match before justification match', () => {
    const items: CommandItem[] = [
      // matches only via justification text (keyword)
      item({ id: 'just', title: 'Onboarding', keywords: ['α2 appears in the justification'] }),
      // matches via name/title substring
      item({ id: 'name', title: 'The α2 milestone' }),
      // exact symbol match — must win
      item({ id: 'sym', title: 'Comfort', symbol: 'α2' }),
    ]
    const ranked = rankCommands(items, 'α2', [])
    expect(ranked.map((r) => r.id)).toEqual(['sym', 'name', 'just'])
  })

  it('floats recently-used items above equally-scored ones', () => {
    const items: CommandItem[] = [
      item({ id: 'a', title: 'Export project' }),
      item({ id: 'b', title: 'Export data' }),
      item({ id: 'c', title: 'Export report' }),
    ]
    // All three are title-prefix matches (same score); recents decide.
    const ranked = rankCommands(items, 'export', ['c', 'a'])
    expect(ranked.map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('matches verbs by title prefix and by synonym keyword', () => {
    const items: CommandItem[] = [
      item({ id: 'export', kind: 'action', title: 'Export project…', keywords: ['download', 'backup'] }),
      item({ id: 'foundation', kind: 'tier', title: 'Foundation' }),
    ]
    // Title prefix.
    expect(rankCommands(items, 'export', []).map((r) => r.id)).toEqual(['export'])
    // Synonym keyword — "download" is not in the title at all.
    expect(rankCommands(items, 'download', []).map((r) => r.id)).toEqual(['export'])
  })

  it('excludes non-matches and caps the list at eight results', () => {
    const items: CommandItem[] = Array.from({ length: 20 }, (_, i) =>
      item({ id: `c${i}`, title: `Context ${i}` }),
    )
    items.push(item({ id: 'other', title: 'Zzz unrelated' }))
    const ranked = rankCommands(items, 'context', [])
    expect(ranked).toHaveLength(8)
    expect(ranked.every((r) => r.id.startsWith('c'))).toBe(true)
  })

  it('shows everything recent-first for an empty query', () => {
    const items: CommandItem[] = [
      item({ id: 'a', title: 'Alpha' }),
      item({ id: 'b', title: 'Beta' }),
      item({ id: 'c', title: 'Gamma' }),
    ]
    const ranked = rankCommands(items, '', ['b'])
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('is case-insensitive and trims the query', () => {
    const items: CommandItem[] = [item({ id: 'sym', title: 'Comfort', symbol: 'α' })]
    expect(rankCommands(items, '  COMFORT ', []).map((r) => r.id)).toEqual(['sym'])
  })
})

describe('ranking performance', () => {
  // Acceptance: open-to-interactive < 100ms. Ranking is the per-keystroke work
  // the palette does on top of a cmdk render; at a realistic-plus corpus (1000
  // items — far larger than any real project) a full sweep of progressively-
  // longer queries must stay comfortably fast so a keystroke never stalls.
  //
  // This is a stress guard against an accidentally-quadratic regression, NOT a
  // literal budget: 100 rank() calls over 1000 items is ~100× a single real
  // keystroke. A strict wall-clock ceiling does not survive shared/slower CI
  // hardware (HANDOFF: the canvas perf test was widened 16→40ms for the same
  // reason). Healthy runs here are ~60–125ms; the 400ms ceiling keeps CI green
  // under load while a true algorithmic blowup (seconds) still trips it.
  it('ranks a 1000-item corpus across many queries without going quadratic', () => {
    const items: CommandItem[] = Array.from({ length: 1000 }, (_, i) =>
      item({
        id: `c${i}`,
        title: `Context number ${i}`,
        symbol: `α${i}`,
        keywords: [`justification prose for context ${i}`],
      }),
    )
    const queries = ['c', 'co', 'con', 'context', 'α', 'α5', 'number', 'prose', '', 'zzz']
    const start = performance.now()
    for (let pass = 0; pass < 10; pass++) {
      for (const q of queries) rankCommands(items, q, ['c3', 'c7'])
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(400)
  })
})

describe('emptyStateMessage', () => {
  it('offers to create a context when the query could be a symbol or name', () => {
    expect(couldBeContextName('Payments')).toBe(true)
    expect(emptyStateMessage('Payments')).toContain('Enter creates a context')
    expect(emptyStateMessage('Payments')).toContain('Payments')
  })

  it('falls back to a plain message for an empty or implausible query', () => {
    expect(couldBeContextName('   ')).toBe(false)
    expect(emptyStateMessage('   ')).toBe('No matches')
    // A whole paragraph is not a name.
    expect(couldBeContextName('x'.repeat(60))).toBe(false)
    expect(emptyStateMessage('x'.repeat(60))).toBe('No matches')
  })
})
