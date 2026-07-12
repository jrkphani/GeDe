import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  CorruptedEnvelopeError,
  ENVELOPE_TABLE_NAMES,
  FK_TARGETS,
  FORMAT_VERSION,
  ID_FIELDS,
  NewerVersionError,
  NotGeDeExportError,
  WORKSPACE_SCOPED_TABLES,
  type Envelope,
  type EnvelopeTables,
  type Row,
  type TableName,
  envelopeStats,
  envelopeToJson,
  parseEnvelope,
  remapEnvelope,
  serializeEnvelope,
} from './projectEnvelope'

// ── Fixture / arbitrary builders ─────────────────────────────────────────────
// Build a self-consistent project graph exercising all 9 tables, both
// self-referential chains (parameters.parentParamId, tier2_entries.parentId,
// contexts.parentId) and both cross-links (dimensions.sourceParamId,
// parameters.sourceEntryId), at recursion depth ≤ 4.

const ts = '2026-07-05T00:00:00.000Z'

function empty(): EnvelopeTables {
  return {
    projects: [],
    tier1_purpose: [],
    tier1_props: [],
    tier2_tables: [],
    tier2_entries: [],
    dimensions: [],
    parameters: [],
    contexts: [],
    bindings: [],
  }
}

function base(id: string) {
  return { id, createdAt: ts, updatedAt: ts, deletedAt: null }
}

// All nine tables carry a workspaceId field (issue 034/migration 0008 gave
// the first six their own denormalized column; issue 078 step 2/migration
// 0015 gave tier2_entries/parameters/bindings theirs too — see
// WORKSPACE_SCOPED_TABLES' own doc comment in projectEnvelope.ts).
const WS = 'ws1'
function baseWs(id: string) {
  return { ...base(id), workspaceId: WS }
}

// A hand-built fixture with every FK type wired up, used for the isomorphism
// test where explicit edges are easier to assert than random ones.
function fixture(): EnvelopeTables {
  const t = empty()
  t.projects.push({ ...baseWs('p1'), name: 'Tavalo', description: 'desc' })
  t.tier1_purpose.push({ ...baseWs('pu1'), projectId: 'p1', body: 'why' })
  t.tier1_props.push({ ...baseWs('pr1'), projectId: 'p1', rank: 1, name: 'Prop', description: null, sort: 0 })
  t.tier2_tables.push({ ...baseWs('tt1'), projectId: 'p1', name: 'Value', sort: 0 })
  // tier2 entries: root → child → grandchild (self-ref chain, depth 3)
  t.tier2_entries.push({ ...baseWs('te1'), tableId: 'tt1', parentId: null, name: 'E1', description: null, sort: 0 })
  t.tier2_entries.push({ ...baseWs('te2'), tableId: 'tt1', parentId: 'te1', name: 'E2', description: null, sort: 0 })
  t.tier2_entries.push({ ...baseWs('te3'), tableId: 'tt1', parentId: 'te2', name: 'E3', description: null, sort: 0 })
  // root-canvas dimensions
  t.dimensions.push({ ...baseWs('d1'), projectId: 'p1', contextId: null, sourceParamId: null, name: 'D1', color: '#111', sort: 0 })
  t.dimensions.push({ ...baseWs('d2'), projectId: 'p1', contextId: null, sourceParamId: null, name: 'D2', color: '#222', sort: 1 })
  // parameters incl. a self-ref (sub-parameter) and a sourceEntryId cross-link
  t.parameters.push({ ...baseWs('pa1'), dimensionId: 'd1', parentParamId: null, sourceEntryId: 'te1', name: 'P1', sort: 0 })
  t.parameters.push({ ...baseWs('pa2'), dimensionId: 'd1', parentParamId: 'pa1', sourceEntryId: null, name: 'P2', sort: 1 })
  t.parameters.push({ ...baseWs('pa3'), dimensionId: 'd2', parentParamId: null, sourceEntryId: null, name: 'P3', sort: 0 })
  // contexts: root context + drilled child (self-ref parentId)
  t.contexts.push({ ...baseWs('c1'), projectId: 'p1', parentId: null, symbol: 'α', name: 'root', justification: 'j', sort: 0 })
  t.contexts.push({ ...baseWs('c2'), projectId: 'p1', parentId: 'c1', symbol: 'α1', name: null, justification: null, sort: 0 })
  // child-canvas dimension: contextId + sourceParamId cross-link both set
  t.dimensions.push({ ...baseWs('d3'), projectId: 'p1', contextId: 'c2', sourceParamId: 'pa1', name: 'D3', color: '#333', sort: 0 })
  t.parameters.push({ ...baseWs('pa4'), dimensionId: 'd3', parentParamId: null, sourceEntryId: null, name: 'P4', sort: 0 })
  // bindings on both canvases
  t.bindings.push({ ...baseWs('b1'), contextId: 'c1', dimensionId: 'd1', parameterId: 'pa1', tupleHash: 'h1' })
  t.bindings.push({ ...baseWs('b2'), contextId: 'c1', dimensionId: 'd2', parameterId: 'pa3', tupleHash: 'h1' })
  t.bindings.push({ ...baseWs('b3'), contextId: 'c2', dimensionId: 'd3', parameterId: 'pa4', tupleHash: 'h2' })
  return t
}

let counter = 0
function seqId(): string {
  counter += 1
  return `new-${String(counter).padStart(4, '0')}`
}

// Randomized valid project: n dimensions each with params, a context tree of
// bounded depth with bindings, and a tier-2 entry tree of bounded depth.
const arbTables = fc
  .record({
    paramsPer: fc.integer({ min: 1, max: 3 }),
    ctxCount: fc.integer({ min: 1, max: 4 }),
    entryDepth: fc.integer({ min: 1, max: 4 }),
  })
  .map(({ paramsPer, ctxCount, entryDepth }) => {
    let n = 0
    const nid = (p: string) => `${p}-${(n += 1)}`
    const t = empty()
    const pid = nid('p')
    t.projects.push({ ...baseWs(pid), name: `Proj ${pid}`, description: null })
    t.tier1_purpose.push({ ...baseWs(nid('pu')), projectId: pid, body: 'b' })

    const tableId = nid('tt')
    t.tier2_tables.push({ ...baseWs(tableId), projectId: pid, name: 'T', sort: 0 })
    // A linear entry chain of length entryDepth (self-ref, depth ≤ 4)
    let parentEntry: string | null = null
    const entryIds: string[] = []
    for (let d = 0; d < entryDepth; d++) {
      const eid = nid('te')
      t.tier2_entries.push({ ...baseWs(eid), tableId, parentId: parentEntry, name: `E${d}`, description: null, sort: 0 })
      entryIds.push(eid)
      parentEntry = eid
    }

    const dimIds: string[] = []
    const paramIdsByDim: Record<string, string[]> = {}
    for (let i = 0; i < 2; i++) {
      const did = nid('d')
      t.dimensions.push({ ...baseWs(did), projectId: pid, contextId: null, sourceParamId: null, name: `D${i}`, color: '#000', sort: i })
      dimIds.push(did)
      paramIdsByDim[did] = []
      let prevParam: string | null = null
      for (let j = 0; j < paramsPer; j++) {
        const paid = nid('pa')
        // First param of first dim links to an entry (cross-link); some params
        // chain into a sub-parameter (self-ref).
        const sourceEntryId = i === 0 && j === 0 ? entryIds[0] ?? null : null
        t.parameters.push({ ...baseWs(paid), dimensionId: did, parentParamId: prevParam, sourceEntryId, name: `P${j}`, sort: j })
        paramIdsByDim[did].push(paid)
        prevParam = j === 0 ? paid : prevParam
      }
    }

    // Root contexts, each fully bound → complete tuple.
    for (let c = 0; c < ctxCount; c++) {
      const cid = nid('c')
      t.contexts.push({ ...baseWs(cid), projectId: pid, parentId: null, symbol: `s${c}`, name: null, justification: 'j', sort: c })
      for (const did of dimIds) {
        const paid = (paramIdsByDim[did] ?? [])[0] as string
        t.bindings.push({ ...baseWs(nid('b')), contextId: cid, dimensionId: did, parameterId: paid, tupleHash: `h${c}` })
      }
    }
    return t
  })

// ── Test-side canonicalizer: prove "deep-equal modulo ids" without depending
// on id values. Applies the remap's own bijection to the ORIGINAL and asserts
// it reproduces the remapped output — so any forgotten FK field diverges.
function applyIdMap(tables: EnvelopeTables, idMap: Map<string, string>): EnvelopeTables {
  const out: Record<string, Row[]> = {}
  for (const name of ENVELOPE_TABLE_NAMES) {
    out[name] = (tables[name] as Row[]).map((row) => {
      const copy: Row = { ...row }
      for (const field of ID_FIELDS[name] as readonly string[]) {
        const v = copy[field]
        if (typeof v === 'string') copy[field] = idMap.get(v) ?? v
      }
      return copy
    })
  }
  return out as unknown as EnvelopeTables
}

// A loosely-typed round-tripped copy for the tamper tests to mutate freely.
interface LooseEnvelope {
  formatVersion: number
  tables: Record<string, Row[] | undefined>
}
function loose(tables: EnvelopeTables): LooseEnvelope {
  return JSON.parse(envelopeToJson(serializeEnvelope(tables))) as LooseEnvelope
}

describe('projectEnvelope — round-trip', () => {
  it('parse ∘ serialize is identity, and re-serialize is byte-stable', () => {
    const env = serializeEnvelope(fixture())
    const json = envelopeToJson(env)
    const parsed = parseEnvelope(json)
    expect(parsed.tables).toEqual(env.tables)
    // Re-export of the parsed envelope produces identical bytes.
    expect(envelopeToJson(serializeEnvelope(parsed.tables))).toBe(json)
  })

  it('property: random projects export → import → deep-equal modulo ids', () => {
    fc.assert(
      fc.property(arbTables, (tables) => {
        const env = serializeEnvelope(tables)
        const json = envelopeToJson(env)
        const parsed = parseEnvelope(json)
        expect(parsed.tables).toEqual(env.tables)

        const { tables: remapped, idMap } = remapEnvelope(env.tables, seqId, 'target-ws')
        // Every id changed (fresh) and the bijection is total + injective.
        expect(new Set(idMap.values()).size).toBe(idMap.size)
        // Applying the same bijection to the original reproduces the remap
        // exactly → every FK/self-ref/cross-link field was rewritten. The
        // workspaceId column is a special case (issue 034): it is NOT part of
        // the id bijection — every workspace-scoped row is stamped with the
        // caller's target workspace regardless of what the source had, so
        // applyIdMap's output must be adjusted the same way before comparing.
        const expected = serializeEnvelope(applyIdMap(env.tables, idMap))
        for (const name of WORKSPACE_SCOPED_TABLES) {
          expected.tables[name] = (expected.tables[name] as Row[]).map((row) => ({
            ...row,
            workspaceId: 'target-ws',
          })) as never
        }
        expect(serializeEnvelope(remapped).tables).toEqual(expected.tables)
      }),
      { numRuns: 60 },
    )
  })
})

describe('projectEnvelope — id remap preserves every FK (graph isomorphism)', () => {
  it('rewrites pk, fk, self-ref and cross-link edges consistently', () => {
    const src = serializeEnvelope(fixture()).tables
    const { tables: dst, idMap } = remapEnvelope(src, seqId, 'target-ws')

    // Bijection: distinct new ids, one per source row.
    const totalRows = ENVELOPE_TABLE_NAMES.reduce((sum, n) => sum + src[n].length, 0)
    expect(idMap.size).toBe(totalRows)
    expect(new Set(idMap.values()).size).toBe(totalRows)

    // For every row and every id field, dst == idMap(src) and the FK target
    // row exists in the destination.
    const dstIds: Record<TableName, Set<string>> = {} as Record<TableName, Set<string>>
    for (const n of ENVELOPE_TABLE_NAMES) dstIds[n] = new Set((dst[n] as Row[]).map((r) => r.id as string))

    for (const n of ENVELOPE_TABLE_NAMES) {
      const srcRows = src[n] as Row[]
      const dstRows = dst[n] as Row[]
      srcRows.forEach((srcRow, i) => {
        const dstRow = dstRows[i] as Row
        for (const field of ID_FIELDS[n] as readonly string[]) {
          const s = srcRow[field]
          if (s === null) {
            expect(dstRow[field]).toBeNull()
          } else {
            expect(dstRow[field]).toBe(idMap.get(s as string))
          }
        }
        // Cross-check every FK still resolves in the destination graph.
        for (const [field, target] of Object.entries(FK_TARGETS[n])) {
          const v = dstRow[field]
          if (v !== null) expect(dstIds[target].has(v as string)).toBe(true)
        }
      })
    }
    // Self-referential depth-3 tier2 chain survives with rewritten pointers.
    const entries = dst.tier2_entries
    const byId = new Map(entries.map((e) => [e.id, e]))
    const leaf = entries.find((e) => e.name === 'E3')
    expect(leaf?.parentId).toBe(byId.get(leaf?.parentId ?? '')?.id)
    // The child-canvas dimension's sourceParamId points at a real parameter.
    const childDim = dst.dimensions.find((d) => d.contextId !== null)
    expect(dst.parameters.some((p) => p.id === childDim?.sourceParamId)).toBe(true)
  })
})

describe('projectEnvelope — tampered files rejected atomically with a named error', () => {
  it('non-JSON / non-object → Not a GeDe export', () => {
    expect(() => parseEnvelope('not json{')).toThrow(NotGeDeExportError)
    expect(() => parseEnvelope('[]')).toThrow(NotGeDeExportError)
    expect(() => parseEnvelope('42')).toThrow(NotGeDeExportError)
    expect(() => parseEnvelope(JSON.stringify({ hello: 'world' }))).toThrow(NotGeDeExportError)
  })

  it('newer formatVersion → NewerVersionError', () => {
    const env = serializeEnvelope(fixture())
    const bumped = JSON.stringify({ ...env, formatVersion: FORMAT_VERSION + 1 })
    expect(() => parseEnvelope(bumped)).toThrow(NewerVersionError)
  })

  it('missing table → CorruptedEnvelopeError at that table', () => {
    const broken = loose(fixture())
    delete broken.tables.contexts
    expect(() => parseEnvelope(JSON.stringify(broken))).toThrow(CorruptedEnvelopeError)
    try {
      parseEnvelope(JSON.stringify(broken))
    } catch (e) {
      expect((e as CorruptedEnvelopeError).message).toContain('contexts')
    }
  })

  it('dangling FK → CorruptedEnvelopeError at the offending row', () => {
    const broken = loose(fixture())
    const binding = broken.tables.bindings?.[0]
    if (binding) binding.parameterId = 'ghost'
    expect(() => parseEnvelope(JSON.stringify(broken))).toThrow(CorruptedEnvelopeError)
  })

  it('cyclic parent chain → CorruptedEnvelopeError', () => {
    const broken = loose(fixture())
    // Make the two contexts point at each other.
    const [a, b] = broken.tables.contexts ?? []
    if (a && b) {
      a.parentId = b.id ?? null
      b.parentId = a.id ?? null
    }
    expect(() => parseEnvelope(JSON.stringify(broken))).toThrow(CorruptedEnvelopeError)
  })
})

// Issue 078 step 2 — FORMAT_VERSION 2 -> 3: tier2_entries/parameters/bindings
// gained their own workspaceId column (migration 0015). A genuine v2 file
// (exported before this change) has NO workspaceId key at all on those three
// tables' rows — mirrors the v1->v2 upgrade test's own shape one version up.
describe('projectEnvelope — v2 -> v3 upgrade (issue 078 step 2)', () => {
  // Strips `workspaceId` from a plain row (used below to downgrade a v3
  // fixture's rows to a genuine v2 shape) by rebuilding from Object.entries
  // rather than a `{ workspaceId, ...rest }` destructure-and-discard
  // (unused-var lint) or a dynamic `delete` (no-dynamic-delete lint).
  function omitWorkspaceId(row: Row): Omit<Row, 'workspaceId'> {
    return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'workspaceId'))
  }

  it('a legacy v2 file (no workspaceId on tier2_entries/parameters/bindings) parses with workspaceId injected as null', () => {
    const env = serializeEnvelope(fixture())
    const v3 = JSON.parse(envelopeToJson(env)) as Envelope & { tables: Record<string, Row[]> }
    // Downgrade to a genuine v2 shape: strip workspaceId from exactly the
    // three tables that didn't have it pre-078, bump the version marker down.
    const v2: Record<string, unknown> = {
      formatVersion: 2,
      tables: {
        ...v3.tables,
        tier2_entries: v3.tables.tier2_entries.map(omitWorkspaceId),
        parameters: v3.tables.parameters.map(omitWorkspaceId),
        bindings: v3.tables.bindings.map(omitWorkspaceId),
      },
    }

    const parsed = parseEnvelope(JSON.stringify(v2))

    expect(parsed.formatVersion).toBe(FORMAT_VERSION)
    for (const name of ['tier2_entries', 'parameters', 'bindings'] as const) {
      expect(parsed.tables[name].every((row) => row.workspaceId === null)).toBe(true)
    }
    // The six tables that already had workspaceId in v2 are untouched.
    expect(parsed.tables.projects[0]?.workspaceId).toBe(WS)
  })
})

describe('projectEnvelope — stats', () => {
  it('counts canvases (root + drilled) and live contexts', () => {
    const stats = envelopeStats(fixture())
    // fixture has root-canvas dims (context null) + one child canvas (c2).
    expect(stats.canvases).toBe(2)
    expect(stats.contexts).toBe(2)
  })
})
