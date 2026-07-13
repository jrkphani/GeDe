# 079: Email-scoped invitations never materialize on the invitee — inbound `invitations`/`workspace_members` apply drops the row on an unguarded local `workspaces` FK

- **Status**: OPEN — **root cause diagnosed & code-verified; fix not yet scoped (awaiting decision).** Diagnosis only per this session's scope; no code changed.
- **Milestone**: M9/M8 — sharing (055/#8) read-path materialization
- **Severity**: **Critical** — blocks **every genuine (never-been-a-member) invitee**, i.e. the entire audience of issue 062's email-scoped invite feature. This is the *actual* remaining blocker for sharing, previously masked by 078 (now fixed).

## Symptom (observed live, two-account e2e, 2026-07-13)

Inviter **A** (`jrkphani@gmail.com`) shares a project with invitee **B** (`jrkphani@icloud.com`, verified). B signs in and polls 60s (20×). B's pending invite (a real row in RDS: `id 019f58e0`, `email jrkphani@icloud.com`, `workspace_id 8306e508` = A's workspace) **never appears** — no badge, and B's local PGlite `invitations` table only ever contains a *different* invite for a workspace **B is already a member of**. Artifacts: `scratchpad/e2e-078-share/{result.json, invitations-shape-responses.jsonl, action-log.txt, network-B.har}`.

## Root cause — client apply path (NOT auth/scoping)

`src/db/sync.ts`'s `applyInboundDeltas` handles the streamed `invitations` row with a **bare insert and no "ensure parent `workspaces` row exists" step**:

- `src/db/sync.ts:203-214` (`'invitations'`) and `:216-228` (`'workspace_members'`) — `tx.insert(...).onConflictDoUpdate(...)` with no workspace self-heal.
- Contrast `src/db/sync.ts:77-80` (`'projects'`), which **does** self-heal (`tx.insert(schema.workspaces).values({id, name:'Workspace'}).onConflictDoNothing()`) — the fix issue 072 shipped for the identical FK.
- `invitations.workspace_id` carries a real, enforced FK to `workspaces.id` (`migration 0009_invitations.sql:22`, `schema.ts:61-63`), and `migrate.ts` runs the same migrations against client PGlite, so the FK is enforced **client-side** too.
- `workspaces` is **not** an Electric-synced table (`syncScope.ts:39-51`); the only local writers of a `workspaces` row are `createProject`→`ensureWorkspaceRow` and the `projects`-case self-heal. A first-time invitee is (by definition) not a member of the inviting workspace, so **no other path will ever seed that local `workspaces` stub** → the insert throws a genuine Postgres FK violation, **every time, permanently**.

### Why it silently disappears (and reports `hasError:false`)

1. `syncEngine.ts:227-230` — the FK rejection is caught, the delta buffered into `retryBuffer`, `onError` fired.
2. `RETRY_APPLY_ORDER`/`drainRetryBuffer` only reorder among the **11 synced tables** — the missing parent (`workspaces`) is *unsynced*, so no retry can ever satisfy it.
3. When all 11 synced tables report `up-to-date` (they do, within the 60s window), `maybeSurfaceOrphaned()` (`syncEngine.ts:156-169`) fires a final `onError` and **permanently discards** the buffered delta. Electric never re-delivers an acked message, so it's gone for the session — and a fresh reload re-snapshots the same row and hits the same violation again.
4. `src/store/sync.ts:294-302` — `onControl` resets `hasError:false` on **every** `up-to-date` control (any table, unconditionally), which fire every ~10-20s, masking the transient `hasError:true` before the next `syncState()` sample. Matches the captured `syncStateB.hasError:false` despite a real permanent failure. (Same masking mechanic 072's writeup named.)

## What this RULES OUT (refuted with direct evidence)

- **NOT the read-path token / missing `email` claim.** Decoded the JWT B actually sent as `Authorization: Bearer` on its `/sync/...table=invitations` requests (from `network-B.har`): `token_use:id`, `email:jrkphani@icloud.com`, `email_verified:True`, `sub:f46834b8…`. It is the **ID token with a verified, correct email**. (`src/store/sync.ts:236` defaults `getAuthToken` to the ID token, per 068.)
- **NOT the server-side email scoping (062).** `invitations-shape-responses.jsonl` shows B's *own distinct* shape handle (`102116284-…`, not A's) returned the icloud invite over the wire **twice** — a row B could only match via the `lower(email)=lower($2)` branch of `INVITATIONS_EMAIL_SCOPE_SQL` (B is not a member of `8306e508`). 062's server shape works. `jwt.ts:69` extracts `email`; `shapeProxy/handler.ts:93-100` passes it to `scopeToWorkspaces`; `syncScope.ts:151-153` applies the email predicate when present.
- **NOT 078.** 078 (experimental subquery-shape churn) is fixed & deployed; `invitations` is not a subquery shape and its row reached the client fine.

## Blast radius

- Every fresh invitee, unconditionally. Would only *appear* to work if the invitee already had some other local row referencing that exact `workspace_id` — essentially never for a real invite.
- **Also likely breaks the acceptance round-trip**: after accept, the resulting `workspace_members` row streams back via the identical unguarded `:216-228` case — same missing self-heal. Symmetric code path; verify once the invitations fix lands (the live test skipped accept because the badge never appeared).
- No other synced table affected: all others are membership-scoped and, by the time their rows apply, `projects`' 072 self-heal has already seeded the local `workspaces` row.

## Test-first plan (red first)

- **`src/db/sync.test.ts`**: today's `freshDb()` (`:23-27`) pre-seeds a `workspaces` row before *every* test, so it can never catch this. Add a case that applies an `invitations` delta whose `workspace_id` the local DB has **never seen** (no pre-seeded workspace) and asserts the row **lands** (currently: FK violation → discarded). Same for `workspace_members`. These are the red tests.

## Candidate fixes (choose after review — none implemented)

1. **Mirror 072's fix onto `invitations` + `workspace_members`** — ensure the parent `workspaces` stub inside the same tx before each upsert. Minimal, symmetric with the shipped/tested `projects` pattern. Tradeoff: creates a placeholder-named `workspaces` row on a non-member device — audit that no UI reads `workspaces` without joining through `workspace_members` (else the placeholder could leak into a listing).
2. **Centralize an "ensure-parent-workspace" helper** used by every `upsertGuarded` case carrying a `workspace_id` FK (projects + invitations + workspace_members) — closes the whole defect class at once and prevents a fourth recurrence, at a slightly larger diff.
3. **Fetch the real workspace name** on first reference (vs the generic `'Workspace'` placeholder) — better invite-banner UX but needs a new read endpoint; out of scope for a single apply-path patch. Flagged because `projects`' existing placeholder is already a known simplification.

## Also flagged (separate follow-ups)

- **Observability gap**: the ShapeProxy Lambda logs nothing application-level (no WHERE/params/email). A one-line `console.log({table, workspaceIdsCount, hasEmail})` in `resolveShapeRequest` would have shortcut this diagnosis.
- **Error masking**: `src/store/sync.ts:294-302` clearing `hasError` on any table's `up-to-date` hides real per-table apply failures — consider per-table error state.

**References**: `src/db/sync.ts` (`:56-92` projects self-heal, `:203-228` invitations/members), `src/sync/syncEngine.ts` (`:156-169`, `:227-230`), `src/store/sync.ts` (`:236`, `:294-307`), `src/domain/syncScope.ts` (`:39-51`, `:144-156`), `src/server/{writeApi/jwt.ts:57-75, shapeProxy/handler.ts:75-115}`, `migration 0009_invitations.sql:22`, `docs/issues/done/072-streamed-projects-dropped-local-fk-and-no-refresh.md`. Evidence: `scratchpad/e2e-078-share/`.
