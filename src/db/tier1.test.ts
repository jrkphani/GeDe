import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import {
  addTier1Prop,
  createProject,
  getTier1Purpose,
  listTier1Props,
  removeTier1Prop,
  reorderTier1Prop,
  setTier1Purpose,
} from './mutations'

async function freshProject() {
  const { db } = await openDatabase('memory://')
  const project = await createProject(db, { name: 'Tavalo' })
  return { db, projectId: project.id }
}

describe('tier1 purpose (single body per project)', () => {
  it('starts empty, then insert-or-updates the one body row', async () => {
    const { db, projectId } = await freshProject()
    expect(await getTier1Purpose(db, projectId)).toBeNull()

    await setTier1Purpose(db, projectId, 'A better way to sit together.')
    expect((await getTier1Purpose(db, projectId))?.body).toBe('A better way to sit together.')

    // Second write upserts the same row — never a second purpose per project.
    await setTier1Purpose(db, projectId, 'Comfort, on demand.')
    const purpose = await getTier1Purpose(db, projectId)
    expect(purpose?.body).toBe('Comfort, on demand.')
  })
})

describe('tier1 props (ranked value propositions)', () => {
  it('addTier1Prop appends with contiguous rank 1..k', async () => {
    const { db, projectId } = await freshProject()
    await addTier1Prop(db, projectId, 'Seating-status comfort')
    await addTier1Prop(db, projectId, 'Mobility fluidity')
    await addTier1Prop(db, projectId, 'Age-spectrum compatibility')

    const rows = await listTier1Props(db, projectId)
    expect(rows.map((r) => r.name)).toEqual([
      'Seating-status comfort',
      'Mobility fluidity',
      'Age-spectrum compatibility',
    ])
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3])
    expect(rows.map((r) => r.sort)).toEqual([0, 1, 2])
  })

  it('reorderTier1Prop rewrites ranks 1..k contiguously (drag #3 to #1)', async () => {
    const { db, projectId } = await freshProject()
    const a = await addTier1Prop(db, projectId, 'A')
    await addTier1Prop(db, projectId, 'B')
    const c = await addTier1Prop(db, projectId, 'C')

    const after = await reorderTier1Prop(db, projectId, c.id, 0)
    expect(after.map((r) => r.name)).toEqual(['C', 'A', 'B'])
    expect(after.map((r) => r.rank)).toEqual([1, 2, 3])
    // A slid from rank 1 to rank 2.
    expect(after.find((r) => r.id === a.id)?.rank).toBe(2)
  })

  it('removeTier1Prop closes the gap — remaining ranks stay contiguous 1..k', async () => {
    const { db, projectId } = await freshProject()
    await addTier1Prop(db, projectId, 'A')
    const b = await addTier1Prop(db, projectId, 'B')
    await addTier1Prop(db, projectId, 'C')

    const after = await removeTier1Prop(db, projectId, b.id)
    expect(after.map((r) => r.name)).toEqual(['A', 'C'])
    expect(after.map((r) => r.rank)).toEqual([1, 2])
    expect(after.map((r) => r.sort)).toEqual([0, 1])
  })
})
