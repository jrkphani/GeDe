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
