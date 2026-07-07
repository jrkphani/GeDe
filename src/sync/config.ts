// Feature-flags v2 sync (issue 032 implementation note: "Feature-flag sync so
// v1's single-user, no-network path stays the tested default until v2
// ships"). Default OFF everywhere sync isn't explicitly configured — dev,
// every existing test, and CI's `npm run verify` all run with sync disabled,
// so the full v1 suite is the regression guard (test-first plan #6) with zero
// special-casing.
import type { TableName } from '../domain/syncDelta'

export function isSyncEnabled(): boolean {
  return import.meta.env.VITE_SYNC_ENABLED === 'true'
}

// The Electric server's shape endpoint base (issue 030's `sync` Fargate slot,
// fronted by the Api stack's ALB — deploy/cdk/lib/api-stack.ts). Empty by
// default; startSync() never runs unless isSyncEnabled() is true anyway.
export function syncBaseUrl(): string {
  return import.meta.env.VITE_SYNC_URL ?? ''
}

// The write-path API's endpoint (issue 048): same-origin by default (empty
// base + `/write`, per the deploy topology issue 047 makes HTTPS same-origin
// via CloudFront — DEPLOYMENT.md §9a) so the client never hardcodes a full
// URL. Overridable via VITE_WRITE_API_PATH for tests/alternate environments,
// mirroring syncBaseUrl()'s own override seam.
export function writeApiPath(): string {
  return import.meta.env.VITE_WRITE_API_PATH ?? '/write'
}

// Every base table this app syncs, in a stable order. Not an FK-apply order
// requirement (src/db/sync.ts's two-pass strategy tolerates any order within
// a batch) — just the fixed list of shapes syncEngine.ts subscribes to.
export const SYNCED_TABLES: readonly TableName[] = [
  'projects',
  'tier1_purpose',
  'tier1_props',
  'tier2_tables',
  'tier2_entries',
  'dimensions',
  'parameters',
  'contexts',
  'bindings',
]
