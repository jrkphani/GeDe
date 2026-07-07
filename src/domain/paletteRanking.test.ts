import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  cosineSimilarity,
  couldBeContextName,
  emptyStateMessage,
  rankCommands,
  semanticScoresFromVectors,
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

  it('is unaffected by semanticScores when absent — the graceful-degradation contract (issue 042)', () => {
    // Golden test (test-first plan #2): with no model/scores at all, results
    // must be byte-identical to pre-042 lexical-only ranking, for every
    // fixture already covered above.
    const items: CommandItem[] = [
      item({ id: 'a', title: 'Export project' }),
      item({ id: 'b', title: 'Export data' }),
      item({ id: 'c', title: 'Export report' }),
    ]
    const withoutOptions = rankCommands(items, 'export', ['c', 'a'])
    const withEmptyScores = rankCommands(items, 'export', ['c', 'a'], { semanticScores: new Map() })
    expect(withoutOptions.map((r) => r.id)).toEqual(['c', 'a', 'b'])
    expect(withEmptyScores.map((r) => r.id)).toEqual(withoutOptions.map((r) => r.id))
  })
})

describe('semantic blend (issue 042)', () => {
  it('ranks a perfect name/symbol match first even against a strong semantic hit', () => {
    const items: CommandItem[] = [
      // Exact symbol match for the query "budget" doesn't exist; use a
      // perfect prefix/name match instead so the lexical tier is 0/2.
      item({ id: 'exact', title: 'Budget', symbol: 'β' }),
      // No lexical match at all ("hide the unconnected" never appears in its
      // text) but a strong semantic hit against the query embedding.
      item({ id: 'semantic', title: 'Fade unconnected contexts' }),
      item({ id: 'unrelated', title: 'Rename project' }),
    ]
    const semanticScores = new Map([
      ['exact', 0.1],
      ['semantic', 0.9],
      ['unrelated', 0.05],
    ])
    const ranked = rankCommands(items, 'budget', [], { semanticScores })
    // The lexical match still wins outright, and the semantically-close/
    // lexically-far item is surfaced at all (a plain lexical scan would drop
    // it) while the unrelated item — no lexical match and too weak a
    // semantic score to clear the inclusion threshold — is excluded entirely.
    expect(ranked.map((r) => r.id)).toEqual(['exact', 'semantic'])
  })

  it('uses semantic similarity as a tiebreaker within an equal lexical tier', () => {
    const items: CommandItem[] = [
      item({ id: 'a', title: 'Export project' }),
      item({ id: 'b', title: 'Export data' }),
    ]
    // Same lexical tier (both title-prefix matches) and no recents — semantic
    // similarity alone decides the order, per the "recall booster" brief.
    const semanticScores = new Map([
      ['a', 0.2],
      ['b', 0.8],
    ])
    expect(rankCommands(items, 'export', [], { semanticScores }).map((r) => r.id)).toEqual([
      'b',
      'a',
    ])
  })

  it('never lets semantic similarity promote a weak match above a stronger lexical tier', () => {
    // Property test (implementation notes: "property-test the exact match
    // never loses invariant") — for ANY semantic score assigned to a
    // lexically-weaker item, an exact/prefix match for the query never drops
    // below it.
    fc.assert(
      fc.property(fc.float({ min: 0, max: 1, noNaN: true }), (weakSemantic) => {
        const items: CommandItem[] = [
          item({ id: 'strong', title: 'Budget', symbol: 'β' }),
          item({ id: 'weak', title: 'Unrelated justification text' }),
        ]
        const ranked = rankCommands(items, 'budget', [], {
          semanticScores: new Map([
            ['strong', 0],
            ['weak', weakSemantic],
          ]),
        })
        const strongIndex = ranked.findIndex((r) => r.id === 'strong')
        const weakIndex = ranked.findIndex((r) => r.id === 'weak')
        expect(strongIndex).toBe(0)
        if (weakIndex !== -1) expect(weakIndex).toBeGreaterThan(strongIndex)
      }),
    )
  })

  it('does not apply semantic scoring to an empty query', () => {
    const items: CommandItem[] = [
      item({ id: 'a', title: 'Alpha' }),
      item({ id: 'b', title: 'Beta' }),
    ]
    // Even a high semantic score for 'b' must not reorder the empty-query
    // (recent-first) listing — there is no query text to have been embedded.
    const ranked = rankCommands(items, '', ['a'], {
      semanticScores: new Map([['b', 0.99]]),
    })
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('cosineSimilarity / semanticScoresFromVectors', () => {
  it('is 1 for identical vectors and 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('is symmetric and scale-invariant', () => {
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(cosineSimilarity([4, 5, 6], [1, 2, 3]))
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
  })

  it('returns 0 for mismatched lengths or a zero vector, never throws', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('builds a per-item score map from a query vector and item vectors', () => {
    const scores = semanticScoresFromVectors(
      [1, 0],
      new Map([
        ['same', [1, 0]],
        ['orthogonal', [0, 1]],
      ]),
    )
    expect(scores.get('same')).toBeCloseTo(1)
    expect(scores.get('orthogonal')).toBeCloseTo(0)
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
