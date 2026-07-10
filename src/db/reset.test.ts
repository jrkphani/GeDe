import { describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { openDatabase } from './client'
import { wipeAllLocalData } from './reset'
import { projects, tier1Purpose, workspaces } from './schema'

// Issue 063 — clear-on-sign-out's data-layer half: a shared browser must not
// leak the previous person's local project data after they sign out. This
// exercises the wipe directly against the real db layer (mirrors db.test.ts's
// own style), independent of the store-level orchestration (auth.test.ts).

async function seededDb() {
  const { pg, db } = await openDatabase('memory://')
  const workspaceId = uuidv7()
  await db.insert(workspaces).values({ id: workspaceId, name: 'Personal' })
  const projectId = uuidv7()
  await db.insert(projects).values({ id: projectId, workspaceId, name: 'Tavalo' })
  // A row in a table that FKs to BOTH workspaces and projects — proves the
  // wipe handles cross-table FK dependencies without ordering errors.
  await db.insert(tier1Purpose).values({
    id: uuidv7(),
    projectId,
    workspaceId,
    body: 'Some purpose statement',
  })
  return { pg, db, workspaceId, projectId }
}

describe('wipeAllLocalData', () => {
  it('empties every app table', async () => {
    const { db } = await seededDb()
    expect(await db.select().from(projects)).toHaveLength(1)

    await wipeAllLocalData(db)

    expect(await db.select().from(projects)).toEqual([])
    expect(await db.select().from(workspaces)).toEqual([])
    expect(await db.select().from(tier1Purpose)).toEqual([])
  })

  it('leaves the connection/schema usable afterward — a fresh write still succeeds', async () => {
    const { db } = await seededDb()
    await wipeAllLocalData(db)

    const workspaceId = uuidv7()
    await db.insert(workspaces).values({ id: workspaceId, name: 'Fresh' })
    const projectId = uuidv7()
    await db.insert(projects).values({ id: projectId, workspaceId, name: 'New start' })

    const rows = await db.select().from(projects)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('New start')
  })

  it('is a no-op (never throws) against an already-empty database', async () => {
    const { db } = await openDatabase('memory://')
    await expect(wipeAllLocalData(db)).resolves.not.toThrow()
  })
})
