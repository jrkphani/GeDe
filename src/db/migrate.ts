import type { PGlite } from '@electric-sql/pglite'

// drizzle-kit generates SQL files into ./migrations; this runner applies them in
// filename order and records each in __migrations. It is the ONLY path by which
// schema exists (TECH_STACK §2: migrations from the first table, even in PGlite),
// and it runs in both the browser (Vite bundles the SQL via import.meta.glob)
// and Vitest.
const migrationFiles = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export async function runMigrations(pg: PGlite): Promise<string[]> {
  await pg.exec(
    `CREATE TABLE IF NOT EXISTS __migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  const applied: string[] = []
  for (const path of Object.keys(migrationFiles).sort()) {
    const name = path.split('/').pop() as string
    const seen = await pg.query('SELECT name FROM __migrations WHERE name = $1', [name])
    if (seen.rows.length > 0) continue
    await pg.exec(migrationFiles[path] as string)
    await pg.query('INSERT INTO __migrations (name) VALUES ($1)', [name])
    applied.push(name)
  }
  return applied
}

export function migrationCount(): number {
  return Object.keys(migrationFiles).length
}
