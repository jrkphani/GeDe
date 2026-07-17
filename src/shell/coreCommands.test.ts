// @vitest-environment jsdom
// Issue 089 D1 Phase 2 — once a context's justification can hold Lexical JSON
// instead of a plain string, the palette's keyword corpus (contextSource here)
// must index the PROSE, not the JSON envelope. Otherwise the palette both
// pollutes ranking with JSON syntax (`"root"`, `"paragraph"`) and fails to
// find a context by the words its author actually wrote.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coreCommandSources } from './coreCommands'
import { navigate } from './router'
import { rankCommands, type CommandItem } from '../domain/paletteRanking'
import { plainTextToRichJson } from '../domain/richText'
import { useContextsStore } from '../store/contexts'
import type { ContextRow } from '../db/mutations'

const PROJECT_ID = 'proj-089-d1-p2'

function contextRow(overrides: Partial<ContextRow>): ContextRow {
  return {
    id: 'ctx-1',
    projectId: PROJECT_ID,
    workspaceId: 'ws-1',
    canvasId: 'canvas-1',
    parentId: null,
    symbol: 'β1',
    name: null,
    justification: null,
    sort: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  }
}

// Resolve the single context CommandItem the contextSource yields for the
// current store/route state.
function contextItems(): CommandItem[] {
  // Only the context source contributes 'context'-kind items; filtering keeps
  // this robust if the source order/count ever changes.
  return coreCommandSources()
    .flatMap((source) => source())
    .filter((item) => item.kind === 'context')
}

beforeEach(() => {
  // Put a project route in the URL so projectIdOf(currentRoute()) resolves —
  // contextSource yields nothing outside a project.
  navigate({ kind: 'tier', projectId: PROJECT_ID, tier: 'foundation' })
})

afterEach(() => {
  useContextsStore.setState({ contexts: [] })
})

describe('contextSource keyword corpus (089 D1 P2)', () => {
  it('a context whose justification is Lexical JSON is found by its PROSE words', () => {
    const justification = plainTextToRichJson('Reflects the primary beneficiaries')
    useContextsStore.setState({ contexts: [contextRow({ justification })] })

    const items = contextItems()
    expect(items).toHaveLength(1)

    // Found by a prose word from the (now JSON-encoded) justification.
    expect(rankCommands(items, 'beneficiaries', []).map((i) => i.id)).toEqual(['context.ctx-1'])

    // NOT found by JSON structural tokens — the keywords hold plain prose, not
    // the serialized envelope. (These would spuriously match if the raw JSON
    // string had been stuffed into keywords.)
    expect(rankCommands(items, 'paragraph', [])).toHaveLength(0)
    expect(rankCommands(items, '"root"', [])).toHaveLength(0)
  })

  it('a legacy plain-string justification is still found by its words (verbatim passthrough)', () => {
    useContextsStore.setState({
      contexts: [contextRow({ justification: 'Reflects the primary beneficiaries' })],
    })
    const items = contextItems()
    expect(rankCommands(items, 'beneficiaries', []).map((i) => i.id)).toEqual(['context.ctx-1'])
  })
})
