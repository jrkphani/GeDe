import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import {
  addDimension,
  addParameter,
  createProject,
  listParameters,
  removeParameter,
  renameParameter,
  reorderParameter,
} from './mutations'

async function projectWithDimension() {
  const { db } = await openDatabase('memory://')
  const project = await createProject(db, { name: 'Tavalo' })
  const dimension = await addDimension(db, project.id)
  return { db, projectId: project.id, dimensionId: dimension.id }
}

describe('parameter mutations', () => {
  it('adds parameters in sort order, scoped to their dimension', async () => {
    const { db, dimensionId } = await projectWithDimension()
    const p1 = await addParameter(db, dimensionId, 'Buyers')
    const p2 = await addParameter(db, dimensionId, 'Maintainer')
    const p3 = await addParameter(db, dimensionId, 'Users')

    expect([p1.name, p2.name, p3.name]).toEqual(['Buyers', 'Maintainer', 'Users'])
    expect((await listParameters(db, dimensionId)).map((p) => p.sort)).toEqual([0, 1, 2])
  })

  it('m is unbounded and independent per dimension', async () => {
    const { db, projectId, dimensionId } = await projectWithDimension()
    const other = await addDimension(db, projectId)
    await addParameter(db, dimensionId, 'Buyers')
    await addParameter(db, dimensionId, 'Maintainer')
    await addParameter(db, dimensionId, 'Users')
    await addParameter(db, other.id, 'Only one here')

    expect(await listParameters(db, dimensionId)).toHaveLength(3)
    expect(await listParameters(db, other.id)).toHaveLength(1)
  })

  it('accepts parent_param_id for sub-parameters (schema ships ahead of UI, issue 011)', async () => {
    const { db, dimensionId } = await projectWithDimension()
    const parent = await addParameter(db, dimensionId, 'Users')
    const child = await addParameter(db, dimensionId, 'Inner Circle', parent.id)
    expect(child.parentParamId).toBe(parent.id)
  })

  it('reorder rewrites sort stably', async () => {
    const { db, dimensionId } = await projectWithDimension()
    await addParameter(db, dimensionId, 'Buyers')
    const b = await addParameter(db, dimensionId, 'Maintainer')
    await addParameter(db, dimensionId, 'Users')

    await reorderParameter(db, dimensionId, b.id, 0)
    const rows = await listParameters(db, dimensionId)
    expect(rows.map((p) => p.name)).toEqual(['Maintainer', 'Buyers', 'Users'])
    expect(rows.map((p) => p.sort)).toEqual([0, 1, 2])
  })

  it('rename updates the row and bumps updated_at', async () => {
    const { db, dimensionId } = await projectWithDimension()
    const p = await addParameter(db, dimensionId, 'Buyers')
    await new Promise((r) => setTimeout(r, 5))
    const renamed = await renameParameter(db, p.id, 'Purchasers')
    expect(renamed.name).toBe('Purchasers')
    expect(new Date(renamed.updatedAt).getTime()).toBeGreaterThan(new Date(p.updatedAt).getTime())
  })

  it('removal soft-deletes and closes the sort gap — no floor', async () => {
    const { db, dimensionId } = await projectWithDimension()
    const a = await addParameter(db, dimensionId, 'Buyers')
    await addParameter(db, dimensionId, 'Maintainer')
    await addParameter(db, dimensionId, 'Users')

    await removeParameter(db, dimensionId, a.id)
    const rows = await listParameters(db, dimensionId)
    expect(rows.map((p) => p.name)).toEqual(['Maintainer', 'Users'])
    expect(rows.map((p) => p.sort)).toEqual([0, 1])
  })

  it('removing every parameter leaves an empty ordered list (m can reach zero)', async () => {
    const { db, dimensionId } = await projectWithDimension()
    const a = await addParameter(db, dimensionId, 'Buyers')
    await removeParameter(db, dimensionId, a.id)
    expect(await listParameters(db, dimensionId)).toHaveLength(0)
  })
})
