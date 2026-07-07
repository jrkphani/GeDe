# ADR-0010: Tier responsibilities & the local-first inversion (server is authority for shared writes)

- **Status**: Accepted
- **Date**: 2026-07-07
- **Relates to**: ADR-0003 (Postgres-everywhere / PGlite local-first), ADR-0006 (PWA), ADR-0008 (CDK+RDS+ElectricSQL), ADR-0009 (Cognito). Issues 030/032/033/034 and the new **043**.

## Context

v2 introduces a real server (issue 030: CDK VPC + RDS + Fargate), so it's natural to ask "what's the 3-tier split?" But GeDe is **local-first** (ADR-0003/0006): the browser holds the UI *and* the domain logic *and* a full local database (PGlite). Classic 3-tier — thin client, fat middle tier — does not apply, and forcing it would destroy the offline, zero-latency, data-on-device thesis. Two facts sharpen the design:

1. **Modern ElectricSQL is read-path sync only.** It streams Postgres → clients via "shapes"; **you own the write path.** So there must be a server component that accepts writes — it isn't free in the sync engine.
2. **Shared data can't trust a client.** v1's domain invariants (dimension floor n≥2, tuple completeness, cascade integrity, "never block a save") are enforced **client-side**. Fine for a single-user local app; unsafe the moment multiple untrusted clients write to one Postgres.

## Decision

Keep the **local-first thick-client inversion** and make the server **thin but authoritative for shared writes**. Responsibilities:

- **Tier 1 — Presentation (browser SPA, on CloudFront/S3).** All UI, **all pure domain logic** (canvasLayout, composeMode, coverage, completeness, duplicates, projectEnvelope, paletteRanking, …), and the **local data engine** (PGlite + Drizzle + IndexedDB). Writes go **optimistically to local PGlite first** (instant, offline, undoable), then the mutation replays to Tier 2. **Authoritative for offline/local edits.**
- **Tier 2 — Application (server, thin by design).** Two parts: **(a) ElectricSQL read-path sync** (Postgres → clients via shapes) and **(b) a write-path API** that authenticates (Cognito JWT, ADR-0009), enforces **tenancy** (workspace, 034) and **domain invariants** (mirrored from v1), and writes to Postgres; Electric then syncs the authoritative result back to every client. **Authoritative for shared writes — it may reject.**
- **Tier 3 — Data (RDS, isolated subnets).** Source of truth: **RLS** (tenancy, 034) + **constraints/triggers** (domain invariants, defense-in-depth) + the shared Drizzle migrations. Reachable only from the compute tier.
- **Managed / cross-cutting:** Cognito (identity, ADR-0009), CloudFront/S3 (asset delivery), VPC/NAT.

**Authority rule:** the **client is authoritative offline** (local-first — you can always edit); the **server is authoritative for shared/synced state** (it validates on the wire and can reject a mutation that violates tenancy or an invariant, which then reconciles back to the offending client).

**Invariants are enforced at two layers** (belt-and-suspenders): the Tier-2 write-API (fast, friendly errors) *and* Tier-3 DB constraints/triggers (last line, can't be bypassed).

## Cost shape (keep it cheap)

- **Write-API as serverless** — AWS Lambda behind the ALB / API Gateway — is the recommended default: writes are infrequent, so **$0 idle, pay-per-write**, no always-on task. ElectricSQL stays on **Fargate** (it holds persistent streaming connections). This keeps Tier 2 to *one* always-on task plus a serverless write path.
- Consistent with ADR-0009's direction (auth already left the VPC for Cognito); the remaining NAT/Fargate footprint is the sync task, revisitable with VPC endpoints later.

## Consequences

- **New issue 043**: the Tier-2 **write-path API + server-side invariant enforcement** (Cognito-authenticated, workspace-scoped, invariant-validating writes to Postgres; offline queue + replay; conflict/LWW authority at the boundary).
- **Issue 032 is sharpened**: it is the **read-path** sync (Electric shapes → PGlite) plus the **client** optimistic-write model and offline queue — writes *persist* via 043, not "the engine ships the delta straight to the server." Its old "don't route writes through the server" note is corrected here.
- **Issue 034** gains **domain-invariant DB constraints/triggers** alongside RLS tenancy (Tier-3 enforcement).
- **Deployment**: Tier 2 = ElectricSQL (Fargate) + write-API (Lambda); DEPLOYMENT §9 / TECH_STACK §6.3 reference this ADR for *which responsibility lives where* (they already describe the boxes).
- **Not doing**: moving domain logic to a server app tier. The client stays thick; the server stays thin. This ADR exists to prevent that drift.
