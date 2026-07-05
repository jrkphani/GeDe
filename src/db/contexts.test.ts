import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import {
  addDimension,
  addParameter,
  bindParameter,
  ContextSymbolCollisionError,
  createContext,
  createProject,
  listBindings,
  listContexts,
  setContextSymbol,
  unbindParameter,
} from './mutations'

async function projectWithCanvas() {
  const { db } = await openDatabase('memory://')
  const project = await createProject(db, { name: 'Tavalo' })
  const value = await addDimension(db, project.id)
  const stake = await addDimension(db, project.id)
  const vComfort = await addParameter(db, value.id, 'Comfort')
  const sUsers = await addParameter(db, stake.id, 'Users')
  return { db, projectId: project.id, value, stake, vComfort, sUsers }
}

describe('context mutations', () => {
  it('auto-assigns symbols in the Greek cycle, in sort order', async () => {
    const { db, projectId } = await projectWithCanvas()
    const a = await createContext(db, projectId)
    const b = await createContext(db, projectId)
    const c = await createContext(db, projectId)
    expect([a.symbol, b.symbol, c.symbol]).toEqual(['α', 'β', 'γ'])
    expect((await listContexts(db, projectId)).map((ctx) => ctx.sort)).toEqual([0, 1, 2])
  })

  it('rejects a manual symbol override that collides with a live sibling', async () => {
    const { db, projectId } = await projectWithCanvas()
    const a = await createContext(db, projectId)
    const b = await createContext(db, projectId)
    await expect(setContextSymbol(db, projectId, b.id, a.symbol)).rejects.toBeInstanceOf(
      ContextSymbolCollisionError,
    )
    expect((await listContexts(db, projectId)).find((ctx) => ctx.id === b.id)?.symbol).toBe('β')
  })

  it('allows a manual override that does not collide', async () => {
    const { db, projectId } = await projectWithCanvas()
    const a = await createContext(db, projectId)
    const renamed = await setContextSymbol(db, projectId, a.id, 'ω')
    expect(renamed.symbol).toBe('ω')
  })
})

describe('binding mutations', () => {
  it('binding upsert replaces on the same (context, dimension), never duplicates', async () => {
    const { db, projectId, value, vComfort } = await projectWithCanvas()
    const ctx = await createContext(db, projectId)
    const anotherParam = await addParameter(db, value.id, 'Mobility')

    await bindParameter(db, ctx.id, value.id, vComfort.id)
    await bindParameter(db, ctx.id, value.id, anotherParam.id)

    const rows = await listBindings(db, ctx.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.parameterId).toBe(anotherParam.id)
  })

  it('tuple_hash is deterministic over ordered parameter ids and recomputed on re-bind', async () => {
    const { db, projectId, value, stake, vComfort, sUsers } = await projectWithCanvas()
    const ctx = await createContext(db, projectId)
    await bindParameter(db, ctx.id, value.id, vComfort.id)
    await bindParameter(db, ctx.id, stake.id, sUsers.id)

    const rows = await listBindings(db, ctx.id)
    const hash1 = rows[0]?.tupleHash
    expect(hash1).toBe(`${vComfort.id}|${sUsers.id}`)
    expect(rows.every((r) => r.tupleHash === hash1)).toBe(true)

    const otherStakeParam = await addParameter(db, stake.id, 'Maintainer')
    await bindParameter(db, ctx.id, stake.id, otherStakeParam.id)
    const rows2 = await listBindings(db, ctx.id)
    const hash2 = rows2[0]?.tupleHash
    expect(hash2).toBe(`${vComfort.id}|${otherStakeParam.id}`)
    expect(hash2).not.toBe(hash1)
  })

  it('unbind removes the binding and recomputes the remaining tuple hash', async () => {
    const { db, projectId, value, stake, vComfort, sUsers } = await projectWithCanvas()
    const ctx = await createContext(db, projectId)
    await bindParameter(db, ctx.id, value.id, vComfort.id)
    await bindParameter(db, ctx.id, stake.id, sUsers.id)

    await unbindParameter(db, ctx.id, stake.id)
    const rows = await listBindings(db, ctx.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tupleHash).toBe(vComfort.id)
  })
})
