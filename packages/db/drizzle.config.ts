import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration. Migrations are hand-authored in `migrations/`
 * and applied by `applyMigrations` at service boot; `npm run generate` diffs
 * `src/schema.ts` against the migration history to draft the next file.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
