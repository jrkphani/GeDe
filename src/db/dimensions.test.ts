import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import {
  addDimension,
  DimensionFloorError,
  listDimensions,
  removeDimension,
  renameDimension,
  reorderDimension,
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
})
