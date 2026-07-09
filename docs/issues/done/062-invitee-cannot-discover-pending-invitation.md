# 062: Invitee never receives their pending invitation from the server (accept flow unreachable for a real invitee)

- **Status**: SHIPPED — Option B (email-scoped read-path), lowest deploy risk: reuses the existing 058 shape proxy, no new CDK resources/Lambdas/routes
- **Milestone**: M9 — the missing data-delivery piece behind 060; the true remaining blocker for GitHub #8
- **Severity**: High — this is *why* the two-identity smoke fails. 060 shipped a correct accept UI, but a real (cross-device) invitee's client has no way to learn a pending invitation exists, so the "Invitations" badge never appears and there is nothing to accept.
- **Found via**: Clean-profile smoke of the deployed 060 UI (2026-07-09/10) — the tester reported "not seeing any invite being accepted."

## Resolution

Shipped Option B, exactly as this issue's own fix-direction spec'd it:

1. **`invitations` joins `SYNCED_TABLES`** (`src/domain/syncScope.ts`) — the shape proxy now subscribes to it like every other synced table.
2. **Email-scoped WHERE, invitations only.** `scopeToWorkspaces(table, workspaceIds, callerEmail?)` grew an optional third param, consulted ONLY for `table === 'invitations'`: with a caller email it builds `(workspace_id = ANY($1::text[]) OR lower(email) = lower($2))`, params `[membershipArrayLiteral, callerEmail]` — a not-yet-member invitee (empty membership set) still gets a real, matches-by-email shape, never the fail-closed `false`. Every other table's single-param shape is byte-for-byte unchanged (asserted directly — `syncScope.test.ts`'s "every OTHER SYNCED_TABLES table ignores a passed-in callerEmail" guard). No email → falls back to the prior membership-only, fail-closed-on-empty predicate.
3. **Email extracted from the VERIFIED Cognito JWT only.** `CognitoClaims` (`src/server/writeApi/jwt.ts`) grew an optional `email` field, read off the signature-verified payload (never a client-supplied query param/header); `resolveShapeRequest` (`src/server/shapeProxy/handler.ts`) passes `auth.claims.email` into the scope builder. A dedicated cross-email no-leak test proves a token for email Y never resolves email X's invites, and a client-supplied `email`/`params[2]` query override is proven to be ignored.
4. **Client refresh wiring.** `src/store/sync.ts` gained a generic `invitationsAppliedAt` timestamp, bumped whenever an inbound `invitations` delta applies; `PendingInvitations.tsx` subscribes to it and re-runs `loadMyInvitations()` on change, so the 060 badge now appears the moment a fresh invite streams in, with no manual reload.
5. **Migration `0013_invitations_replica_identity.sql`** sets `REPLICA IDENTITY FULL` on `invitations` (mirrors 0012's rationale for the other nine tables) — required now that Electric actually replicates this table. Picked up automatically by the existing migration-runner Lambda (`deploy/cdk/lib/migration-runner/`); no new CDK resource. Two existing CDK tests that hardcode the migration file count (`deploy/cdk/test/migration-stack.test.ts`, `deploy/cdk/test/migration-runner.test.ts`) were bumped 13→14, and `api-stack.test.ts`'s snapshot was refreshed for the shape-proxy/write-path Lambda bundle hash change (real code changed, not config drift). `cdk synth` passes.

All new/changed logic is test-first (red confirmed before each green): `src/domain/syncScope.test.ts`, `src/server/writeApi/jwt.test.ts`, `src/server/shapeProxy/handler.test.ts`, `src/store/sync.test.ts`, `src/components/PendingInvitations.test.tsx`.

## Symptom

A genuinely separate invitee (fresh browser profile, empty local PGlite) signs in and sees **no** pending invitation — the 060 "Invitations · N" affordance never appears, so Accept can't be clicked. In a *single* browser it appeared to work, but only because the invitation row was already in that browser's local PGlite (shared local data — a false positive).

## Root cause

The invitee-discovery path relies on **local** data that is never populated:

- **`invitations` (and `workspace_members`) are NOT in `SYNCED_TABLES`** — `src/domain/syncScope.ts:24,28` explicitly excludes them, so the read-path never streams invitation rows to any client.
- The read-path scope for invitations is **membership-only** — `syncScope.ts:74` `invitations: 'workspace_id = ANY($1::text[])'` (the caller's *member* workspaces). A not-yet-member invitee wouldn't match it even if it were synced.
- The shape proxy does **not** extract the caller's **email** from the verified Cognito JWT (`src/server/shapeProxy/handler.ts`, `src/server/writeApi/jwt.ts` — no email claim handling), so no by-email scoping is possible today.
- 060's `useWorkspaceStore.loadMyInvitations` (`src/store/workspace.ts:259`) queries **local** `listPendingInvitationsForEmail(db, email)` — which returns empty for a fresh invitee, since nothing put the invitation into their local PGlite.

Net: the invitation exists only in RDS, with no delivery path to the invitee's device.

## Fix direction (choose one — the dedicated endpoint is recommended)

**Option A — dedicated "my invitations" endpoint (recommended: simpler, avoids read-path scope/security churn).**
A small authenticated API (same ALB/CloudFront pattern as the write/debug APIs) e.g. `GET /invitations/mine`: verify the Cognito JWT, read its **email** claim, `SELECT` pending (non-accepted, non-revoked, non-expired) `invitations WHERE lower(email) = lower(jwt.email)`, return them. The client calls it on sign-in / hydrate to populate `myInvitations` directly (bypassing Electric). Accept then proceeds via 057's existing seat mutation. Minimal blast radius; the by-email read is naturally scoped to the caller's own verified email.

**Option B — stream invitations via the read-path, scoped by email.**
Add `invitations` to `SYNCED_TABLES`; extend the shape-proxy invitation scope to `workspace_id = ANY($memberships) OR lower(email) = lower($callerEmail)`; extract the email claim from the JWT in the shape proxy; ensure the client subscribes to + applies the invitations shape (the `db/sync.ts` apply case exists from 056). More architecturally uniform but touches Electric scoping security (a new email-based scope) and the client subscription set — more surface area.

Either way, after accept the seat lands (057) and the shared project streams in (058/060's `refreshProjects`).

## Test-first plan

- **Server (endpoint or scope):** a test that, given a JWT with email X, the API/scope returns exactly the pending invitations addressed to X and nothing else (no cross-email leak). Include a negative: email Y sees none of X's invites.
- **Client:** `loadMyInvitations` populates `myInvitations` from the server source (mock it), so the 060 badge appears for a fresh invitee with no local invitation row.
- **E2E (the #8 gate):** two Cognito identities, **separate profiles** — A invites B; B signs in and *sees* the pending invite (proving server delivery), clicks Accept; assert `workspace_members` gains B's seat (049 debug API) and B's client renders A's project.

## Dependencies / ordering

Blocks a full close of **GitHub #8** and resolution of **055**. Builds on 056 (invitation writes reach RDS), 057 (seat mutation), 058 (read-path), 060 (accept UI — correct, just starved of data).

**References**: 060 (the accept UI this feeds), 055/#8 (the umbrella bug), 057 (`acceptInvitation` seat), 058 (`syncScope.ts` — where invitations are excluded/membership-scoped), migration `0009` (the by-email invitation SELECT RLS that Option A's query mirrors).
