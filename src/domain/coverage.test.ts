import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { computeTupleHash } from './symbols'
import {
  assignmentTupleHash,
  coverageStat,
  defaultAxes,
  documentedTuples,
  filterDimensionIds,
  fullTupleSpace,
  tupleSpaceSize,
  type CoverageContextInput,
} from './coverage'

// A random canvas: 2 ≤ n ≤ 5 dimensions, 1 ≤ mᵢ ≤ 6 parameters each.
interface RandomCanvas {
  orderedDimensionIds: string[]
  parameterIdsByDimension: Record<string, string[]>
}

const canvasArb: fc.Arbitrary<RandomCanvas> = fc
  .integer({ min: 2, max: 5 })
  .chain((n) =>
    fc
      .array(fc.integer({ min: 1, max: 6 }), { minLength: n, maxLength: n })
      .map((sizes) => {
        const orderedDimensionIds = sizes.map((_, i) => `d${i}`)
        const parameterIdsByDimension: Record<string, string[]> = {}
        sizes.forEach((m, i) => {
          parameterIdsByDimension[`d${i}`] = Array.from({ length: m }, (_, j) => `d${i}p${j}`)
        })
        return { orderedDimensionIds, parameterIdsByDimension }
      }),
  )

// Reconstruct the 2-D projection the UI presents: every filter-page × every
// (row, col) cell. Independent of coverage.ts's own enumeration so it acts as
// an oracle for "every tuple reachable through the UI regardless of n".
function projectionTupleHashes(
  canvas: RandomCanvas,
  rowDimId: string,
  colDimId: string,
): string[] {
  const { orderedDimensionIds, parameterIdsByDimension } = canvas
  const filterDims = orderedDimensionIds.filter((id) => id !== rowDimId && id !== colDimId)
  let pages: Record<string, string>[] = [{}]
  for (const dimId of filterDims) {
    const next: Record<string, string>[] = []
    for (const page of pages) for (const p of parameterIdsByDimension[dimId] ?? []) next.push({ ...page, [dimId]: p })
    pages = next
  }
  const hashes: string[] = []
  for (const page of pages) {
    for (const rowP of parameterIdsByDimension[rowDimId] ?? []) {
      for (const colP of parameterIdsByDimension[colDimId] ?? []) {
        hashes.push(assignmentTupleHash(orderedDimensionIds, { ...page, [rowDimId]: rowP, [colDimId]: colP }))
      }
    }
  }
  return hashes
}

describe('coverage projection capacity (issue 012 test-plan #1)', () => {
  it('every tuple appears exactly once across the projection pages, for any axis choice', () => {
    fc.assert(
      fc.property(canvasArb, fc.nat(), fc.nat(), (canvas, ri, ci) => {
        const dims = canvas.orderedDimensionIds
        const n = dims.length
        const rowIdx = ri % n
        // A distinct column dimension: step 1..n-1 forward, wrapping.
        const colIdx = (rowIdx + 1 + (ci % (n - 1))) % n
        const rowDimId = dims[rowIdx] as string
        const colDimId = dims[colIdx] as string

        const projected = projectionTupleHashes(canvas, rowDimId, colDimId)
        const oracle = fullTupleSpace(dims, canvas.parameterIdsByDimension)

        // Same multiset, each tuple exactly once, and it equals ∏ mᵢ.
        expect(projected.length).toBe(oracle.length)
        expect(new Set(projected).size).toBe(projected.length)
        expect([...projected].sort()).toEqual([...oracle].sort())
        expect(projected.length).toBe(tupleSpaceSize(dims, canvas.parameterIdsByDimension))
      }),
    )
  })

  it('documented / unexplored partition matches a brute-force oracle', () => {
    fc.assert(
      fc.property(
        canvasArb,
        fc.array(fc.record({ dims: fc.array(fc.nat(), { maxLength: 5 }), justify: fc.boolean() }), {
          maxLength: 8,
        }),
        (canvas, ctxSpecs) => {
          const { orderedDimensionIds: dims, parameterIdsByDimension: params } = canvas
          // Build random contexts binding a prefix of dimensions (some complete,
          // some partial), some justified.
          const contexts: CoverageContextInput[] = ctxSpecs.map((spec, i) => {
            const bindings: Record<string, string> = {}
            dims.forEach((dimId, di) => {
              const pick = spec.dims[di]
              const list = params[dimId] ?? []
              if (pick !== undefined && list.length > 0) {
                bindings[dimId] = list[pick % list.length] as string
              }
            })
            return {
              id: `c${i}`,
              symbol: String.fromCharCode(945 + i),
              bindings,
              justification: spec.justify ? 'because' : null,
            }
          })

          const map = documentedTuples(dims, contexts)

          // Oracle: a tuple is documented iff some context binds every dimension
          // to that tuple's parameter and is justified.
          for (const hash of fullTupleSpace(dims, params)) {
            const expected = contexts.some(
              (c) =>
                c.justification !== null &&
                c.justification.trim() !== '' &&
                dims.every((d) => c.bindings[d] !== undefined) &&
                computeTupleHash(dims.map((d) => c.bindings[d] as string)) === hash,
            )
            expect(map.has(hash)).toBe(expected)
          }
        },
      ),
    )
  })
})

describe('coverage stat (issue 012 test-plan #2)', () => {
  const dims = ['dA', 'dB']
  const baseParams = { dA: ['a1', 'a2'], dB: ['b1', 'b2', 'b3'] }
  const documentedCtx = (id: string, a: string, b: string): CoverageContextInput => ({
    id,
    symbol: id,
    bindings: { dA: a, dB: b },
    justification: 'j',
  })

  it('total = ∏ mᵢ and grows when a parameter is added', () => {
    expect(coverageStat(dims, baseParams, []).total).toBe(6)
    expect(coverageStat(dims, { ...baseParams, dA: ['a1', 'a2', 'a3'] }, []).total).toBe(9)
  })

  it('numerator grows when a context becomes documented (complete + justified)', () => {
    const before = coverageStat(dims, baseParams, [documentedCtx('α', 'a1', 'b1')])
    expect(before.documented).toBe(1)
    const after = coverageStat(dims, baseParams, [
      documentedCtx('α', 'a1', 'b1'),
      documentedCtx('β', 'a2', 'b2'),
    ])
    expect(after.documented).toBe(2)
  })

  it('a complete-but-unjustified context does not count (SPEC invariant 2)', () => {
    const complete: CoverageContextInput = { id: 'x', symbol: 'x', bindings: { dA: 'a1', dB: 'b1' }, justification: null }
    expect(coverageStat(dims, baseParams, [complete]).documented).toBe(0)
  })

  it('a draft (incomplete) context does not count', () => {
    const draft: CoverageContextInput = { id: 'y', symbol: 'y', bindings: { dA: 'a1' }, justification: 'j' }
    expect(coverageStat(dims, baseParams, [draft]).documented).toBe(0)
  })

  it('removing a dimension recomputes both numerator and denominator', () => {
    const three = ['dA', 'dB', 'dC']
    const threeParams = { ...baseParams, dC: ['c1', 'c2'] }
    const ctx: CoverageContextInput = {
      id: 'z',
      symbol: 'z',
      bindings: { dA: 'a1', dB: 'b1', dC: 'c1' },
      justification: 'j',
    }
    expect(coverageStat(three, threeParams, [ctx])).toEqual({ documented: 1, total: 12 })
    // dC removed: the same context now only binds dA,dB — still complete over 2.
    expect(coverageStat(dims, baseParams, [ctx])).toEqual({ documented: 1, total: 6 })
  })

  it('total is zero when a dimension has no parameters (degenerate)', () => {
    expect(tupleSpaceSize(dims, { dA: ['a1'], dB: [] })).toBe(0)
  })
})

describe('duplicate stacking (issue 012 test-plan #3)', () => {
  it('two documented contexts on the same tuple stack in one cell', () => {
    const dims = ['dA', 'dB']
    const map = documentedTuples(dims, [
      { id: 'c1', symbol: 'α', bindings: { dA: 'a1', dB: 'b1' }, justification: 'j' },
      { id: 'c2', symbol: 'β', bindings: { dA: 'a1', dB: 'b1' }, justification: 'j' },
    ])
    expect(map.size).toBe(1)
    const cell = map.get(assignmentTupleHash(dims, { dA: 'a1', dB: 'b1' }))
    expect(cell?.symbols).toEqual(['α', 'β'])
    expect(cell?.contextIds).toEqual(['c1', 'c2'])
  })
})

describe('axis selection', () => {
  it('defaults to the two largest dimensions, ties broken by sort order', () => {
    const dims = ['dA', 'dB', 'dC']
    // dB largest (4), dA and dC tie (2) → dA wins the tie by earlier sort order.
    const params = { dA: ['1', '2'], dB: ['1', '2', '3', '4'], dC: ['1', '2'] }
    expect(defaultAxes(dims, params)).toEqual({ rowDimId: 'dB', colDimId: 'dA' })
  })

  it('returns null below the n = 2 floor', () => {
    expect(defaultAxes(['only'], { only: ['x'] })).toBeNull()
  })

  it('filter dimensions are every non-axis dimension in sort order', () => {
    const dims = ['dA', 'dB', 'dC', 'dD']
    expect(filterDimensionIds(dims, { rowDimId: 'dB', colDimId: 'dD' })).toEqual(['dA', 'dC'])
  })
})
