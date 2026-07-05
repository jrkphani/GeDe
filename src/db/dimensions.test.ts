import { eq, isNotNull } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import { bindings, dimensions } from './schema'
import {
  addDimension,
  addParameter,
  bindParameter,
  createContext,
  DimensionFloorError,
  listBindings,
  listDimensions,
  removeDimension,
  renameDimension,
  reorderDimension,
  restoreDimension,
  setDimensionColor,
} from './mutations'
import { createProject } from './mutations'
import { DIMENSION_PALETTE } from '../theme/palette'

async function projectDb() {
  const { db } = await openDatabase('memory://')
  const project = await createProject(db, { name: 'Tavalo' })
  return { db, projectId: project.id }
}

describe('dimension mutations', () => {
  it('adds dimensions with default names and palette colors in sort order', async () => {
    const { db, projectId } = await projectDb()
    const d1 = await addDimension(db, projectId)
    const d2 = await addDimension(db, projectId)
    const d3 = await addDimension(db, projectId)

    expect([d1.name, d2.name, d3.name]).toEqual(['Dimension 1', 'Dimension 2', 'Dimension 3'])
    expect([d1.color, d2.color, d3.color]).toEqual([
      DIMENSION_PALETTE[0],
      DIMENSION_PALETTE[1],
      DIMENSION_PALETTE[2],
    ])
    expect((await listDimensions(db, projectId)).map((d) => d.sort)).toEqual([0, 1, 2])
  })

  it('reorder rewrites sort stably and colors stay with their dimension', async () => {
    const { db, projectId } = await projectDb()
    await addDimension(db, projectId)
    const b = await addDimension(db, projectId)
    await addDimension(db, projectId)
    await setDimensionColor(db, b.id, '#123456')

    await reorderDimension(db, projectId, b.id, 0)
    const rows = await listDimensions(db, projectId)
    expect(rows.map((d) => d.name)).toEqual(['Dimension 2', 'Dimension 1', 'Dimension 3'])
    expect(rows.map((d) => d.sort)).toEqual([0, 1, 2])
    // color override travels with the dimension, not the slot
    expect(rows[0]?.color).toBe('#123456')
  })

  it('rename updates the row and bumps updated_at', async () => {
    const { db, projectId } = await projectDb()
    const d = await addDimension(db, projectId)
    await new Promise((r) => setTimeout(r, 5))
    const renamed = await renameDimension(db, d.id, 'Value')
    expect(renamed.name).toBe('Value')
    expect(new Date(renamed.updatedAt).getTime()).toBeGreaterThan(new Date(d.updatedAt).getTime())
  })

  it('rejects removal at the n = 2 floor with a typed error', async () => {
    const { db, projectId } = await projectDb()
    const a = await addDimension(db, projectId)
    await addDimension(db, projectId)

    await expect(removeDimension(db, projectId, a.id)).rejects.toBeInstanceOf(DimensionFloorError)
    expect(await listDimensions(db, projectId)).toHaveLength(2)
  })

  it('removal above the floor soft-deletes and closes the sort gap', async () => {
    const { db, projectId } = await projectDb()
    const a = await addDimension(db, projectId)
    await addDimension(db, projectId)
    await addDimension(db, projectId)

    await removeDimension(db, projectId, a.id)
    const rows = await listDimensions(db, projectId)
    expect(rows.map((d) => d.name)).toEqual(['Dimension 2', 'Dimension 3'])
    expect(rows.map((d) => d.sort)).toEqual([0, 1])
  })

  it('default names never collide with live rows after a middle removal', async () => {
    const { db, projectId } = await projectDb()
    await addDimension(db, projectId)
    const b = await addDimension(db, projectId)
    await addDimension(db, projectId) // "Dimension 3"
    await removeDimension(db, projectId, b.id) // live: Dimension 1, Dimension 3
    const fresh = await addDimension(db, projectId)
    const names = (await listDimensions(db, projectId)).map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
    expect(fresh.name).toBe('Dimension 4')
  })

  // issue 006: restoreDimension is the undo-of-remove / redo-of-add primitive
  // — it must reproduce the exact prior order, not just un-delete the row.
  describe('restoreDimension (issue 006 undo/redo)', () => {
    it('restores a tail removal back to the end', async () => {
      const { db, projectId } = await projectDb()
      const a = await addDimension(db, projectId)
      const b = await addDimension(db, projectId)
      const c = await addDimension(db, projectId)
      const orderedIds = [a.id, b.id, c.id]

      await removeDimension(db, projectId, c.id)
      await restoreDimension(db, projectId, c.id, orderedIds)

      const rows = await listDimensions(db, projectId)
      expect(rows.map((d) => d.id)).toEqual(orderedIds)
      expect(rows.map((d) => d.sort)).toEqual([0, 1, 2])
    })

    it('restores a middle removal at its original position, shifting the rest back', async () => {
      const { db, projectId } = await projectDb()
      const a = await addDimension(db, projectId)
      const b = await addDimension(db, projectId)
      const c = await addDimension(db, projectId)
      const orderedIds = [a.id, b.id, c.id]

      await removeDimension(db, projectId, b.id)
      expect((await listDimensions(db, projectId)).map((d) => d.sort)).toEqual([0, 1])

      await restoreDimension(db, projectId, b.id, orderedIds)
      const rows = await listDimensions(db, projectId)
      expect(rows.map((d) => d.id)).toEqual(orderedIds)
      expect(rows.map((d) => d.sort)).toEqual([0, 1, 2])
    })
  })

  // issue 007: removal cascades to bindings — SPEC invariant 4. Bindings have
  // no deletedAt (schema.ts) so this is a real hard delete, not a soft one.
  describe('removeDimension binding cascade (issue 007)', () => {
    async function canvasWithFullyBoundContext() {
      const { db, projectId } = await projectDb()
      const value = await addDimension(db, projectId)
      const stake = await addDimension(db, projectId)
      const risk = await addDimension(db, projectId)
      const vParam = await addParameter(db, value.id, 'Comfort')
      const sParam = await addParameter(db, stake.id, 'Users')
      const rParam = await addParameter(db, risk.id, 'Low')
      const ctx = await createContext(db, projectId)
      await bindParameter(db, ctx.id, value.id, vParam.id)
      await bindParameter(db, ctx.id, stake.id, sParam.id)
      await bindParameter(db, ctx.id, risk.id, rParam.id)
      return { db, projectId, value, stake, risk, vParam, sParam, rParam, ctx }
    }

    it('hard-deletes bindings for the removed dimension and recomputes remaining tuple hashes', async () => {
      const { db, projectId, value, stake, risk, vParam, rParam, ctx } =
        await canvasWithFullyBoundContext()

      const { dimensions: after, deletedBindings } = await removeDimension(db, projectId, stake.id)
      expect(after.map((d) => d.id)).toEqual([value.id, risk.id])
      expect(deletedBindings).toHaveLength(1)
      expect(deletedBindings[0]?.dimensionId).toBe(stake.id)
      expect(deletedBindings[0]?.contextId).toBe(ctx.id)

      const remaining = await listBindings(db, ctx.id)
      expect(remaining.map((r) => r.dimensionId).sort()).toEqual([risk.id, value.id].sort())
      const expectedHash = `${vParam.id}|${rParam.id}`
      expect(remaining.every((r) => r.tupleHash === expectedHash)).toBe(true)
    })

    it('leaves other contexts untouched when they never bound the removed dimension', async () => {
      const { db, projectId, value, stake, vParam } = await canvasWithFullyBoundContext()
      const untouched = await createContext(db, projectId)
      await bindParameter(db, untouched.id, value.id, vParam.id)

      await removeDimension(db, projectId, stake.id)

      const rows = await listBindings(db, untouched.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.dimensionId).toBe(value.id)
    })

    it('no binding ever references a soft-deleted dimension (integrity)', async () => {
      const { db, projectId, stake } = await canvasWithFullyBoundContext()

      await removeDimension(db, projectId, stake.id)

      const orphans = await db
        .select()
        .from(bindings)
        .innerJoin(dimensions, eq(bindings.dimensionId, dimensions.id))
        .where(isNotNull(dimensions.deletedAt))
      expect(orphans).toHaveLength(0)
    })

    it('undo (restoreDimension with the deleted bindings) reinserts them and recomputes the original hash', async () => {
      const { db, projectId, value, stake, risk, vParam, sParam, rParam, ctx } =
        await canvasWithFullyBoundContext()
      const orderedIds = [value.id, stake.id, risk.id]

      const { deletedBindings } = await removeDimension(db, projectId, stake.id)
      await restoreDimension(db, projectId, stake.id, orderedIds, deletedBindings)

      const rows = await listDimensions(db, projectId)
      expect(rows.map((d) => d.id)).toEqual(orderedIds)

      const restoredBindings = await listBindings(db, ctx.id)
      expect(restoredBindings.map((r) => r.dimensionId).sort()).toEqual(orderedIds.slice().sort())
      const expectedHash = `${vParam.id}|${sParam.id}|${rParam.id}`
      expect(restoredBindings.every((r) => r.tupleHash === expectedHash)).toBe(true)
    })
  })
})
