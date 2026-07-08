# 055: Sharing a project never reaches the invited users (invitations stay local-only)

- **Status**: OPEN
- **Milestone**: M9 (Identity & tenancy) / M8 (Server & sync) — a cross-cutting gap in 035 (sharing) × 043/048 (write-path + client flush) × 050 (personal-workspace model)
- **Found via**: Tester report against the live app (https://d1nzod71m3rz6x.cloudfront.net), 2026-07-09
- **Severity**: High (a shipped, user-visible feature — "Share" — silently does nothing observable to the recipient)

## Symptom

A tester created a project, entered the email IDs of the intended collaborators in the Share UI, and submitted. The invited users never received the project — it was not shared with them in any way. No error was shown to the sharer; the invitation appears to succeed locally.

## Root cause

Three independent, compounding causes. **Cause 1 alone already makes the feature fail** for any second device/user; Causes 2 and 3 would each independently block it even if Cause 1 were fixed. This is primarily an **architectural not-yet-built gap**, with a smaller wiring omission (Cause 1) layered on top.

### Cause 1 — the invitation write never leaves the browser (client wiring omission)

`useWorkspaceStore.invite()` writes the invitation only to the **local PGlite** database and never enqueues a sync mutation:

- `src/store/workspace.ts:78-87` — `invite()` calls `dbCreateInvitation(db, …)` against the local handle (`requireDatabase()`), then `set(...)`. There is **no** `useSyncStore.getState().enqueueLocalMutation(...)` call.
- Contrast: the one action that *does* reach the cloud, `createProject` (`src/store/projects.ts:103-127`), explicitly calls `enqueueLocalMutation({...})` after its local write.
- Repo-wide, `enqueueLocalMutation` is called **only** from `src/store/projects.ts` (plus the queue's own def/tests in `src/store/sync.ts`). `workspace.ts` — which owns `invite`, `changeRole`, and `removeMember` — never calls it. So invitations, role changes, and member removals are **all** local-only.
- UI confirms this is the exact path: `src/components/WorkspaceMembers.tsx:81` calls `invite(trimmed, inviteRole)`.

Result: the invitation row lands in the sharer's own in-browser PGlite and nowhere else. Nothing is transmitted.

### Cause 2 — the sync/write protocol structurally excludes invitation tables (architectural gap)

Even if `invite()` were fixed to enqueue, the mutation could not be represented or accepted:

- `MutationTable` (the write-path Lambda's wire type) is a fixed 9-table union: `projects | tier1Purpose | tier1Props | tier2Tables | tier2Entries | dimensions | parameters | contexts | bindings` — `src/domain/mutationProtocol.ts:23-32`. Neither `invitations` nor `workspace_members` is present.
- The client queue's `QueuedMutation.table` reuses the same restricted `TableName`/`ENVELOPE_TABLE_NAMES` (`src/domain/mutationQueue.ts:23` ← `syncDelta.ts` ← `src/domain/projectEnvelope.ts:175-187`), so `table: 'invitations'` would not even type-check.
- The inbound-apply switch (`src/db/sync.ts:54-173`) has no `case` for `invitations`/`workspace_members`, and the write-path handler (`src/server/writeApi/handler.ts`) has no allow-list entry, invariant check, or store method for them.

Result: an invitation mutation cannot pass the client queue type, cannot be accepted by `/write`, and would never land in RDS.

### Cause 3 — the personal-workspace-only model has no shared workspace to join (model gap)

Even with Causes 1 & 2 fixed **and** the read-path deployed, an invitee could still never see the project:

- `workspaceIdForSub(sub) = uuidv5(GEDE_WORKSPACE_NAMESPACE, sub)` (`src/domain/workspaceId.ts:41-43`) is a pure per-`sub` id, used both server-side (050 provisioning trigger) and client-side (`src/store/auth.ts:25-26`, `applyWorkspaceScope`).
- Every distinct Cognito `sub` is therefore scoped to its **own** personal workspace. There is no code path that scopes an invited user's session to the *sharer's* workspace id.

Result: an invited user's client would sync deltas for `workspaceIdForSub(inviteeSub)` — their own empty personal workspace — not the sharer's, so the shared project would remain invisible.

(Separately, the ElectricSQL **read-path is not deployed at all** today — the `sync` Fargate service is an `nginx:alpine` stub, `VITE_SYNC_URL` is empty, the client read-path is gated off — so no server→client streaming of any row happens yet. This is the outermost blocker on the recipient side.)

## Where it breaks in the pipeline

```
UI (WorkspaceMembers.tsx:81  Share → invite())
  → store (workspace.ts:78-87  invite())
    → local PGlite write (db/invitations.ts createInvitation)     ✅ succeeds (local only)
      → sync queue enqueue                                        ❌ Cause 1 — never called
        → POST /write (write-path Lambda)                         ❌ Cause 2 — table not in protocol/allow-list
          → RDS `invitations` row                                — never reached
            → ElectricSQL read-path                               — not deployed
              → recipient's client / workspace                    ❌ Cause 3 — recipient has a different personal workspace
```

Live evidence consistent with the above: a production RDS query (049 debug API, 2026-07-09) showed `invitations: 0` and `workspace_members: 1` — no invitation has ever reached the server, matching Cause 1.

## Verification (done this session)

- `src/store/workspace.ts:78-87` — `invite()` local-only, no enqueue. ✅ confirmed by read.
- `grep enqueueLocalMutation src/store src/components` → only `projects.ts` (+ `sync.ts` def/tests). ✅
- `src/domain/mutationProtocol.ts:23-32` — 9-table `MutationTable`, no invitation tables. ✅
- `grep invitations|workspace_members src/domain/mutationProtocol.ts src/domain/projectEnvelope.ts` → none. ✅

## Fix direction (not yet implemented — needs design)

Real cross-identity sharing is a multi-issue follow-on to 035/043/050, not a one-line patch:

1. **Protocol + write-path**: extend `MutationTable`/`TableName`/`ENVELOPE_TABLE_NAMES`, the inbound-apply switch (`src/db/sync.ts`), and the write-path handler allow-list + invariants + store to cover `invitations` (and `workspace_members` for seat creation).
2. **Client wiring**: have `workspace.ts` `invite()`/`changeRole()`/`removeMember()` enqueue their writes to the sync queue (mirroring `createProject`), so they flush to `/write`.
3. **Shared-workspace model**: add a server-side **accept/seat** path so an invited user's writes attach to the *inviter's* workspace (via the mutation envelope + a membership/RLS check) rather than their own `workspaceIdForSub` — breaking the current 1-user ↔ 1-workspace invariant (035 "Deviations" item 3 already flags this boundary).
4. **Read-path**: deploy the ElectricSQL read-path so a seated member's client can stream the shared workspace's rows (prerequisite for the recipient to *see* anything).

### Interim UX guard (small, shippable now)

Until the above lands, the Share UI is misleading — it implies success. Consider gating/labelling the Share action (or surfacing "sharing is not yet available in the cloud build") so testers/users aren't told a share happened when nothing leaves the device.

## Test-first plan

- **Client (unit)**: a test asserting `useWorkspaceStore.invite(email, role)` enqueues a mutation via `useSyncStore.getState().enqueueLocalMutation` (currently red — no call exists). Mirror the existing `createProject` enqueue test in `src/store/`.
- **Protocol (type/guard)**: a test that a `QueuedMutation`/`MutationEnvelope` with `table: 'invitations'` is representable and validates — currently impossible (won't type-check), which *is* the failing assertion that documents Cause 2.
- **Write-path (contract)**: extend `src/server/writeApi/*.test.ts` so a POST with an `invitations` mutation is accepted and produces the correct INSERT (currently no allow-list entry → rejected).
- **E2E (deferred until model exists)**: two-identity Playwright/integration test — user A invites user B by email; user B signs in and sees the shared project. Blocked on Cause 3 + read-path deploy.

**References**: 035 (sharing — roles & invitations; shipped schema/RLS/local-CRUD/UI, see its "Deviations" item 3), 043 (write-path API + `MutationTable` protocol), 048 (client write-queue flush), 050 (`workspaceIdForSub` personal-workspace model), 032 (Electric read-path, not yet deployed). Related open follow-ups noted in `docs/HANDOFF.md` ("Shared / multi-workspace writes (035)") and `DEPLOYMENT.md §9a` ("Personal-workspace-only").
