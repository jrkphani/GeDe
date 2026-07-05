import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { uuidv7 } from 'uuidv7'
import { runMigrations, migrationCount } from './migrate'
import { projects } from './schema'

async function freshPg() {
  const pg = new PGlite()
  await runMigrations(pg)
  return pg
}

describe('migrations', () => {
  it('has at least migration 0000', () => {
    expect(migrationCount()).toBeGreaterThan(0)
  })

  it('creates the projects table', async () => {
    const pg = await freshPg()
    const res = await pg.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'projects'`,
    )
    expect(res.rows).toHaveLength(1)
  })

  it('is idempotent — a second run applies nothing', async () => {
    const pg = new PGlite()
    const first = await runMigrations(pg)
    expect(first.length).toBe(migrationCount())
    const second = await runMigrations(pg)
    expect(second).toHaveLength(0)
  })
})

describe('projects round-trip', () => {
  it('inserts and selects a project row', async () => {
    const pg = await freshPg()
    const db = drizzle(pg, { schema: { projects } })
    const id = uuidv7()
    await db.insert(projects).values({ id, name: 'Tavalo', description: 'example system' })
    const rows = await db.select().from(projects)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(id)
    expect(rows[0]?.name).toBe('Tavalo')
    expect(rows[0]?.createdAt).toBeTruthy()
    expect(rows[0]?.deletedAt).toBeNull()
  })
})
