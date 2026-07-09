// Feature-flags v2 sync (issue 032 implementation note: "Feature-flag sync so
// v1's single-user, no-network path stays the tested default until v2
// ships"). Default OFF everywhere sync isn't explicitly configured — dev,
// every existing test, and CI's `npm run verify` all run with sync disabled,
// so the full v1 suite is the regression guard (test-first plan #6) with zero
// special-casing.
// Issue 058 — SYNCED_TABLES' canonical definition now lives in
// src/domain/syncScope.ts (a pure, Vite-free module reachable from server
// code too — src/server/shapeProxy/handler.ts imports it directly to
// allow-list a shape request's `table` param). Re-exported here so every
// existing client import of `SYNCED_TABLES` from this module is unaffected.
export { SYNCED_TABLES } from '../domain/syncScope'

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

// The exact bug-051 crash-on-empty-URL guard (`src/store/sync.ts`'s
// `start()`), extracted as a pure, directly-testable predicate (issue 058
// test-first plan item 1). Without a configured VITE_SYNC_URL — and no
// injected test `streamFactory` — the default shape-stream factory would
// build a shape URL from an empty base and throw ("Failed to construct
// 'URL': Invalid URL"). Once VITE_SYNC_URL is populated (issue 058's
// CloudFront `/sync*` path, deploy/cdk/lib/hosting-stack.ts), this
// naturally returns false and the read-path starts — the gate stays
// defensive (per 051's own "Follow-up" note) rather than being deleted, so
// a future environment with sync enabled but no sync URL configured yet
// still degrades safely instead of crashing.
export function shouldSkipReadPath(hasStreamFactory: boolean): boolean {
  return syncBaseUrl() === '' && !hasStreamFactory
}
