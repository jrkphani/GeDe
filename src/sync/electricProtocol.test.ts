import { describe, expect, it } from 'vitest'
import {
  isElectricChangeMessage,
  MalformedElectricMessageError,
  toRowDelta,
  toRowDeltas,
  type ElectricChangeMessage,
  type ElectricControlMessage,
} from './electricProtocol'

// Fixtures modeled on @electric-sql/client's real wire types (ChangeMessage /
// ControlMessage) — see the module doc for why this repo can't exercise a
// live Electric connection in tests.

function change(operation: 'insert' | 'update' | 'delete', value: Record<string, unknown>): ElectricChangeMessage {
  return { key: `"public"."contexts"/"${String(value.id)}"`, value, headers: { operation } }
}

describe('isElectricChangeMessage', () => {
  it('distinguishes a change message from a control message', () => {
    const c = change('insert', { id: 'c1' })
    const control: ElectricControlMessage = { headers: { control: 'up-to-date' } }
    expect(isElectricChangeMessage(c)).toBe(true)
    expect(isElectricChangeMessage(control)).toBe(false)
  })
})

describe('toRowDelta — wire normalization', () => {
  it('converts a snake_case Electric row into a camelCase RowDelta', () => {
    const message = change('insert', {
      id: 'c1',
      project_id: 'p1',
      parent_id: null,
      symbol: 'α',
      name: null,
      justification: 'because',
      sort: 0,
      created_at: '2026-07-07T00:00:00.000Z',
      updated_at: '2026-07-07T00:00:01.000Z',
      deleted_at: null,
    })
    const delta = toRowDelta('contexts', message)
    expect(delta).toEqual({
      table: 'contexts',
      id: 'c1',
      updatedAt: '2026-07-07T00:00:01.000Z',
      row: {
        id: 'c1',
        projectId: 'p1',
        parentId: null,
        symbol: 'α',
        name: null,
        justification: 'because',
        sort: 0,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:01.000Z',
        deletedAt: null,
      },
    })
  })

  it('a control message (up-to-date etc.) normalizes to null — nothing to apply', () => {
    const control: ElectricControlMessage = { headers: { control: 'up-to-date' } }
    expect(toRowDelta('contexts', control)).toBeNull()
  })

  it('a delete-operation message normalizes the same way (soft-delete is just a row with deleted_at set)', () => {
    const message = change('delete', {
      id: 'b1',
      context_id: 'c1',
      dimension_id: 'd1',
      parameter_id: 'pa1',
      tuple_hash: 'h1',
      created_at: '2026-07-07T00:00:00.000Z',
      updated_at: '2026-07-07T00:00:02.000Z',
      deleted_at: '2026-07-07T00:00:02.000Z',
    })
    const delta = toRowDelta('bindings', message)
    expect(delta?.row.deletedAt).toBe('2026-07-07T00:00:02.000Z')
  })

  // Issue 078 step 2 — migration 0015 denormalized workspace_id directly onto
  // these three tables. SQL_TO_JS_COLUMNS must map their wire `workspace_id`
  // column to `workspaceId`, or (per this module's own TRAP comment)
  // Electric's real inbound rows for these tables would silently drop the
  // column — passing the client's own local NOT NULL insert of a
  // remote-created row two files away (src/db/sync.ts).
  it.each(['tier2_entries', 'parameters', 'bindings'] as const)(
    'maps workspace_id -> workspaceId for %s (issue 078 step 2)',
    (table) => {
      const message = change('insert', {
        id: 'row1',
        workspace_id: 'ws-1',
        created_at: '2026-07-12T00:00:00.000Z',
        updated_at: '2026-07-12T00:00:01.000Z',
        deleted_at: null,
      })
      const delta = toRowDelta(table, message)
      expect(delta?.row.workspaceId).toBe('ws-1')
    },
  )

  // Issue 081 — migration 0016 denormalized existing_scenario directly onto
  // tier1_purpose. SQL_TO_JS_COLUMNS must map the wire `existing_scenario`
  // column to `existingScenario`, or (per this module's own "unknown columns
  // are dropped, not thrown on" comment) every remote-created/updated
  // tier1_purpose row would silently lose its existingScenario the moment it
  // round-trips through Electric — the exact failure mode 078 step 2 flagged
  // for workspace_id, repeated here for a different column.
  it('maps existing_scenario -> existingScenario for tier1_purpose (issue 081)', () => {
    const message = change('update', {
      id: 'pu1',
      project_id: 'p1',
      workspace_id: 'ws-1',
      body: 'Purpose text',
      existing_scenario: '{"root":{}}',
      created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:01.000Z',
      deleted_at: null,
    })
    const delta = toRowDelta('tier1_purpose', message)
    expect(delta?.row.existingScenario).toBe('{"root":{}}')
  })

  it('a null existing_scenario survives the mapping (the schema’s "not written yet" state)', () => {
    const message = change('insert', {
      id: 'pu1',
      project_id: 'p1',
      workspace_id: 'ws-1',
      body: 'Purpose text',
      existing_scenario: null,
      created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:01.000Z',
      deleted_at: null,
    })
    const delta = toRowDelta('tier1_purpose', message)
    expect(delta?.row.existingScenario).toBeNull()
  })

  it('drops an Electric-protocol column this app has no camelCase field for', () => {
    const message = change('insert', {
      id: 'p1',
      name: 'Tavalo',
      description: null,
      created_at: '2026-07-07T00:00:00.000Z',
      updated_at: '2026-07-07T00:00:01.000Z',
      deleted_at: null,
      // hypothetical future Electric-internal column, not one of ours
      __electric_meta: 'whatever',
    })
    const delta = toRowDelta('projects', message)
    expect(delta?.row).not.toHaveProperty('__electric_meta')
  })

  it('throws MalformedElectricMessageError when the row has no id', () => {
    const message = change('insert', { name: 'no id', updated_at: '2026-07-07T00:00:01.000Z' })
    expect(() => toRowDelta('projects', message)).toThrow(MalformedElectricMessageError)
  })

  it('throws MalformedElectricMessageError when the row has no updated_at', () => {
    const message = change('insert', { id: 'p1', name: 'no updated_at' })
    expect(() => toRowDelta('projects', message)).toThrow(MalformedElectricMessageError)
  })
})

describe('toRowDeltas — batch normalization', () => {
  it('normalizes a mixed batch of change and control messages, dropping the control ones', () => {
    const messages = [
      change('insert', { id: 'c1', updated_at: '2026-07-07T00:00:01.000Z' }),
      { headers: { control: 'up-to-date' } } as ElectricControlMessage,
      change('update', { id: 'c2', updated_at: '2026-07-07T00:00:02.000Z' }),
    ]
    const deltas = toRowDeltas('contexts', messages)
    expect(deltas.map((d) => d.id)).toEqual(['c1', 'c2'])
  })
})
