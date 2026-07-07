# 043: Write-path API — server write authority + invariant enforcement (Tier 2)

- **Status**: OPEN
- **Milestone**: M8 (Server & sync)
- **Blocked by**: 030 (server/CDK — shipped), 032 (read-path sync + client mutation queue), 033 (Cognito JWT), 034 (workspace RLS/tenancy)

## Slice

As a signed-in collaborator, my local edits (already instant against PGlite) **replay to a server write-API** that checks *who I am* (Cognito JWT), *which workspace I may touch* (tenancy), and *whether the change is legal* (domain invariants) — then writes to the shared Postgres; ElectricSQL streams the authoritative result back to every client. Offline, I keep editing locally and the queue **replays on reconnect**. The server can **reject** an illegal or out-of-scope write, and that rejection reconciles back to me — so shared data stays correct even though clients aren't trusted.

## Motivation

**ElectricSQL is read-path sync only** — it streams Postgres → clients; **we own writes** (ADR-0010). So there must be a server write authority; it is not free in the engine (this corrects issue 032's original "engine ships the delta straight to the server" assumption). And v1's domain invariants (dimension floor n≥2, tuple completeness, cascade integrity, "never block a save") are enforced **client-side** — safe for a single-user local app, **unsafe** once multiple untrusted clients write to one shared Postgres. RLS (034) enforces *tenancy*, not *domain rules*. This issue is the missing **Tier 2 write authority**: authenticate, scope, validate, persist — the seam every shared feature (workspaces, sharing) writes through.

## Scope

- **Write-path API** (a small service, not the app's logic): accepts client mutations (the same mutation vocabulary as `src/db/mutations.ts`), and for each:
  - **Authenticates** the Cognito JWT (JWKS, ADR-0009) → the acting user (`sub`).
  - **Scopes** to the caller's workspace/tenant (034) — rejects cross-tenant writes independent of RLS (defense-in-depth).
  - **Validates domain invariants** server-side (mirrored from the client domain rules: dimension floor, tuple/completeness legality, FK-cycle integrity, cascade rules) — rejects illegal writes with a typed error.
  - **Resolves conflicts (LWW authority lives here, not in 032)**: on a concurrent edit to the same row, this write path (or a Postgres trigger) decides the winner by **`updated_at` last-write-wins** at persist time. The read-path (032) does not resolve conflicts — it applies whatever authoritative row this path produces, so two clients can never disagree on the winner (ADR-0010).
  - **Persists** to Postgres; ElectricSQL (032) syncs the authoritative rows back to all clients.
- **Serverless by default (cost)**: implement the API as **AWS Lambda behind the ALB / API Gateway** — `$0` idle, pay-per-write (ADR-0010). Not an always-on Fargate task. (Fargate remains only the ElectricSQL sync service.)
- **The replay protocol (this issue owns it; 032 owns the queue)**: **032 builds the client mutation-queue + optimistic apply**; **043 defines the protocol that queue replays into** — ordering, **idempotency via UUIDv7** (replaying the same mutation is a no-op), and the rollback-on-reject contract. The queue is the pinned integration seam between the two issues; keep them consistent (see 032's "queue seam" scope item).
- **Rejection → reconciliation**: a server-rejected mutation surfaces as a calm client error (015 style) and the local optimistic write is rolled back / reconciled to the authoritative server state (via the Electric stream).
- **Tier-3 backstop** (pairs with 034): the same invariants that can be expressed as **Postgres constraints/triggers** are added there too — the last line that no client or API bug can bypass.

Out of scope: the read-path sync mechanics (032); RLS policy authoring itself (034 — this issue *uses* it); auth (033); presence (038). Not a general application server — GeDe's domain logic stays client-side (ADR-0010); this validates and persists, it does not compute projections.

## Design brief

- **Server is authority for shared writes; client for offline** (ADR-0010): the local app never waits on the server to *edit*, but the server has the final say on what lands in shared Postgres and can reject.
- **Two-layer invariant enforcement**: friendly, fast validation in the API + a hard backstop in DB constraints/triggers. Never trust the client for shared integrity; never make the user wait for local edits.
- **Thin, not fat**: this is a *validate-and-persist* seam, not a re-implementation of the domain. Share the invariant predicates with the client where possible (the pure `src/domain/*` functions are the source of truth for the rules) so client and server can't drift.
- **Cheap**: serverless write path (Lambda) so an idle collaboration workspace costs nothing to keep writeable.

**References**: **ADR-0010** (tier responsibilities, server-authority-for-writes) · ADR-0009 (Cognito JWT) · issues 032 (read-path sync + client queue this pairs with), 034 (tenancy/RLS + the constraint backstop), 030 (infra to deploy into), 006 (command-log/mutation vocabulary), 015 (typed-rejection error style, FK-cycle handling), 007 (cascade/delete rules to enforce) · SPEC §3 (invariants) · TECH_STACK §5 (one mutation path).

## Test-first plan

1. **Auth gate**: a mutation with no/invalid/expired Cognito JWT is rejected (401/403); a valid one is accepted — asserted at the API boundary.
2. **Tenancy**: a write targeting another workspace is rejected even with a valid JWT (independent of RLS — the API refuses it), and RLS refuses it too (both layers tested).
3. **Invariant enforcement**: a mutation that would violate a domain invariant (e.g. drop below the dimension floor, an illegal tuple) is rejected server-side with a typed error — and the equivalent DB constraint/trigger also rejects a direct write (defense-in-depth).
4. **Offline replay/idempotency**: queued offline mutations replay in order on reconnect; replaying the same mutation twice (UUIDv7) is a no-op, no duplication.
5. **Rejection reconciliation**: a rejected optimistic local write rolls back to authoritative server state via the Electric stream; the user sees a calm error (015), the undo stack (006) stays coherent.
6. **Cost/shape guard (CDK)**: the write-API is serverless (no new always-on Fargate task); assertion tests cover the Lambda/route + that only the sync service is persistent.

## Acceptance criteria

- [ ] Client mutations persist only through the authenticated, workspace-scoped, invariant-validating write-API; Electric syncs the authoritative result back.
- [ ] Illegal/cross-tenant writes are rejected at **both** the API and the DB (constraints/RLS); rejections reconcile to a calm client error without corrupting undo.
- [ ] Offline edits queue and replay idempotently on reconnect; no loss/duplication (FK-cycle rows included).
- [ ] The write path is **serverless** (Lambda), no new always-on task; CDK assertion tests cover it.
- [ ] `npm run verify` green (single-user local path unchanged); server integration tests green.

## Implementation notes

- **Share the rules, don't fork them**: the client's pure invariant predicates (`src/domain/completeness.ts`, dimension-floor logic, cascade rules) should be the shared source the server validates with, so client and server enforce *identical* rules. Where the server can't run the exact TS (Lambda runtime differences), mirror them with a covering test that runs the same fixtures through both.
- **Idempotency**: UUIDv7 primary keys + an idempotency check make offline replay and retries safe; the API is effectively an "apply these mutations if legal" endpoint.
- **Cost**: Lambda behind the existing ALB (target group → Lambda) or a lightweight API Gateway; either way `$0` idle. This is the last piece that keeps Tier 2 to a single always-on task (the Electric sync service) — see ADR-0010's NAT/VPC-endpoint follow-up for squeezing that further.
- **Sequencing**: 032 (read-path + client queue) and this issue (write authority) are the two halves of "sync"; land 032's read-path + optimistic local writes first, then this to make writes durable and safe. 034's RLS/constraints are the tenancy/integrity backstop underneath.
