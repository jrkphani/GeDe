import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import {
  archiveProject,
  createProject,
  listProjects,
  renameProject,
  restoreProject,
} from './mutations'

async function freshDb() {
  const { db } = await openDatabase('memory://')
  return db
}

describe('project mutations', () => {
  it('createProject returns a row with a UUIDv7 id and timestamps', async () => {
    const db = await freshDb()
    const row = await createProject(db, { name: 'Tavalo' })
    // UUIDv7: version nibble is 7
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(row.name).toBe('Tavalo')
    expect(row.createdAt).toBeTruthy()
    expect(row.updatedAt).toBeTruthy()
    expect(row.deletedAt).toBeNull()
  })

  it('listProjects returns most recently touched first and excludes archived', async () => {
    const db = await freshDb()
    const a = await createProject(db, { name: 'Alpha' })
    const b = await createProject(db, { name: 'Beta' })
    await renameProject(db, a.id, 'Alpha 2')

    let rows = await listProjects(db)
    expect(rows.map((r) => r.name)).toEqual(['Alpha 2', 'Beta'])

    await archiveProject(db, b.id)
    rows = await listProjects(db)
    expect(rows.map((r) => r.name)).toEqual(['Alpha 2'])
  })

  it('archiveProject soft-deletes; restoreProject brings it back', async () => {
    const db = await freshDb()
    const row = await createProject(db, { name: 'Tavalo' })
    await archiveProject(db, row.id)
    expect(await listProjects(db)).toHaveLength(0)

    await restoreProject(db, row.id)
    const rows = await listProjects(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(row.id)
  })

  it('renameProject updates name and bumps updated_at', async () => {
    const db = await freshDb()
    const row = await createProject(db, { name: 'Old' })
    await new Promise((r) => setTimeout(r, 5))
    const renamed = await renameProject(db, row.id, 'New')
    expect(renamed.name).toBe('New')
    expect(new Date(renamed.updatedAt).getTime()).toBeGreaterThan(
      new Date(row.updatedAt).getTime(),
    )
  })
})
