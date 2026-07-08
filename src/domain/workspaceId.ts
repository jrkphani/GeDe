import { uuidv5 } from './uuidv5'

// Issue 050 (ADR-0009/0010 follow-up) — the keystone of "close the write
// loop's last mile": a workspace id that is DERIVED, not stored or fetched.
//
// Every other id in this schema (src/db/schema.ts) is a randomly generated,
// time-ordered UUIDv7 (`uuidv7()`) — nothing needs to reproduce those from
// first principles. A user's PERSONAL workspace id is different: both the
// server-side Cognito PostConfirmation trigger
// (src/server/provisionWorkspace/handler.ts, which creates the workspace
// row) and the client (src/store/auth.ts, which scopes writes to it) must
// independently arrive at the exact same id given only the Cognito `sub`
// already present in every ID token — no side-channel, no Cognito custom
// attribute, no `AdminUpdateUserAttributes`, no lookup endpoint. A custom
// attribute would require a User Pool `Schema` change, which forces a full
// User Pool REPLACEMENT in CloudFormation (destroying every existing user) —
// exactly the outcome this design avoids. See docs/issues/
// 050-workspace-provisioning-sync-enablement.md's "Design brief".
//
// UUIDv5 (RFC 4122 §4.3) is the standard tool for "deterministic id from a
// namespace + a name": `id = f(NAMESPACE, sub)`. This is a deliberate,
// documented deviation from the repo's UUIDv7 default — the ONLY place in
// this codebase an id is anything other than uuidv7().

/**
 * Fixed forever once any environment has provisioned real workspaces against
 * it — changing this constant changes EVERY existing user's derived
 * workspace id, orphaning their already-provisioned `workspaces` row. Only a
 * random-looking UUID literal to avoid collisions with any of RFC 4122's own
 * predefined namespaces; it carries no other meaning.
 */
const GEDE_WORKSPACE_NAMESPACE = 'c9d1a614-9c72-4de0-8b21-9e7d8a2f2b60'

/**
 * The signed-in user's personal workspace id — a pure function of their
 * Cognito `sub`. Same `sub` in, same workspace id out, always; different
 * `sub`s never collide (barring an astronomically unlikely SHA-1 collision).
 * Imported by BOTH src/server/provisionWorkspace/handler.ts (the trigger
 * that creates the row at this id) and src/store/auth.ts (the client that
 * scopes writes to it) — they agree by construction, never by a round trip.
 */
export function workspaceIdForSub(sub: string): string {
  return uuidv5(GEDE_WORKSPACE_NAMESPACE, sub)
}
