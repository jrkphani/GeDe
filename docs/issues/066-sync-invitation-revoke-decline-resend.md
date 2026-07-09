# 066: Invitation revoke / decline / resend never reach the server (local-only) — revoked invites stay live

- **Status**: OPEN
- **Milestone**: M9 — sharing correctness; **should land with/right after 062**
- **Severity**: High once 062 ships — a revoked invitation remains **live and acceptable** server-side, because the revoke never syncs.
- **Found via**: functional review of the open sharing issues (2026-07-10).

## Symptom / discrepancy

`useWorkspaceStore`'s write actions are inconsistent about syncing:
- `invite` / `changeRole` / `removeMember` **do** enqueue to the sync queue (`src/store/workspace.ts:122/144/165`) → flush to `/write` → RDS. ✅
- **`revokeInvitation` (:178), `resendInvitation` (:186), and `declineInvitation` (:273) do NOT enqueue** — they mutate local PGlite only (see the `// no separate sync enqueue` note at `:74`). ❌

Consequences (all data-correctness, not cosmetic):
1. **Revoke is local-only** → the invitation row in RDS keeps `deleted_at = null`. The instant **062** streams invitations to invitees by email, a revoked invite is still delivered and **still acceptable** — the owner believes they revoked access; the invitee can still join. Security/correctness bug that 062 *activates*.
2. **Decline is local-only** → an invitee's decline never propagates; the invite stays pending in RDS and would re-appear on another device.
3. **Resend/extend-expiry is local-only** → the server-side `expires_at` never changes, so the extension is a no-op for anyone but the local user.

## Root cause

056 wired the *additive* membership actions to the sync queue but left the invitation lifecycle actions (revoke/decline/resend) as local-only writes. The write-path already allow-lists the `invitations` table (056), so the server can accept these — the client just never sends them.

## Fix direction

Wire `revokeInvitation` / `declineInvitation` / `resendInvitation` to `useSyncStore.getState().enqueueLocalMutation(...)` after their local write, mirroring `invite`/`changeRole`/`removeMember`:
- **revoke / decline** → a soft-delete (tombstone) or status update on the `invitations` row (whatever the schema uses for revoked/declined — align with `src/db/invitations.ts`), scoped to the invitation's workspace, so the tombstone reaches RDS and (via the read-path / 062) removes it from the invitee's view.
- **resend** → an update carrying the new `expires_at`.
- Keep the signed-out / sync-off path **byte-for-byte local-only** (the existing guard), same as the other actions.
- Confirm the write-path handler + `PgWriteStore` accept an `invitations` update/delete op (it should, via 056's allow-list — add a contract test if missing).

## Test-first plan

- `workspace.test.ts`: `revokeInvitation` / `declineInvitation` enqueue an `invitations` tombstone/update once a sync workspace is set; `resendInvitation` enqueues an update with the new expiry. Signed-out → nothing enqueued (local-only unchanged).
- Write-path contract: an `invitations` soft-delete/update op is `applied` (extend `handler.test.ts`/`pgWriteStore` coverage if not already there).
- Interaction with 062: a revoked invitation's tombstone, once synced, means the invitee no longer receives it (or receives the tombstone) — assert at the scope/apply layer.

## Dependencies / ordering

Blocked by 056 (protocol/allow-list, done). **Tightly coupled to 062** — 062 makes revoked invites visible to invitees, so 066 must land with or immediately after 062 to avoid shipping the "revoked invite still works" bug. Relates to 055/#8.

**References**: 056 (invitations in the write-path protocol), 060 (`declineInvitation`, which inherited the owner-side `revokeInvitation`'s no-sync limitation), 062 (invitation delivery to invitees — the reason this becomes urgent), `src/store/workspace.ts` (the local-only actions), `src/db/invitations.ts` (revoke/resend semantics).
