# 091: "The item you tried to change no longer exists" surfaces during normal editing

- **Status**: OPEN — observed live, not yet root-caused. Intermittent. Likely cosmetic (self-heals to `Synced`), but it flashes a scary error to the user.
- **Milestone**: sync/write-path hardening (the write-side companion to 086/087).
- **Related**: **089-D1** (the heal-on-load enqueues `'update'` mutations for prose columns — a prime suspect), **086** (over-sensitive read-error banner / debounced notes), **087** (surface silent write failures), **088** (write-path/sync at scale).

## Symptom (live, 2026-07-17)
On the live site (089-D1 build), while editing an Architecture **Entity description** on a fresh project (`LIVE-085-086`, table "TAble 1", "Entity 1"), the status bar showed **"The item you tried to change no longer exists."** at bottom-left while the bottom-right sync state read **`Synced`**. The description cell itself was still empty (placeholder "Add description…"), i.e. no explicit user commit had happened yet. Captured via owner screenshot; not deterministically reproduced.

## Where the message comes from (verified)
`src/server/writeApi/handler.ts:99` returns this message when `checkTenancy(mutation)` fails with a reason **other than `cross_tenant`** (`src/server/writeApi/tenancy.ts` — `unknown_entity`, returned when `resolver.workspaceForRow(mutation)` is `null`, i.e. the mutation's TARGET row's workspace can't be resolved because the row does not exist server-side). So: a client `update`/`delete` mutation was sent for a row the write API has no record of.

## Hypotheses (need CloudWatch to disambiguate)
1. **Benign transient** — a note left over from an earlier action that deleted a row while an in-flight mutation still referenced it (a stale echo). The repeatable heal / normal retry then reconciles; `Synced` shows. If this is it, the only fix is UX: don't surface `unknown_entity` for a row that was just locally removed.
2. **D1 heal-on-load enqueuing an update for a not-yet-synced row** — `healRichTextOnLoad` (`src/store/richTextConvert.ts`) enqueues `'update'` for prose columns (incl. `tier2_entries.description`) on project open. If a locally-created entry's INSERT hasn't yet flushed/applied server-side when the heal's `'update'` arrives, the server can't find it → `unknown_entity`. The heal is repeatable so it self-heals on the next open, but it would surface this note. (Heal skips empty cells, so Entity 1's empty description shouldn't have triggered it — but a sibling non-empty description on the same project might have.)
3. **A rapid edit-before-insert-flush race** unrelated to the heal.

## Next steps
- **CloudWatch the `…WriteApiFunction…` log group** for the exact rejected mutation around the repro time: table, op, rowId, reason (`unknown_entity` vs `cross_tenant`), and whether the row's INSERT was in the same/earlier batch. That single log line disambiguates hypotheses 1–3.
- If it's the heal (hyp. 2): make `healRichTextOnLoad` **not surface** `unknown_entity` rejections for its background `'update'`s (they self-heal), OR gate the heal's enqueue on the row being confirmed-applied server-side (`hasApplied`/an insert-acked check), OR order the heal strictly after the project's initial outbox drain.
- If it's a stale-delete echo (hyp. 1): suppress the note when the target row was locally removed (the client already knows it's gone).

## Severity
Low/cosmetic — the write is correctly rejected (the row genuinely isn't on the server yet or is gone), sync converges, and `Synced` is shown. But an unexplained "no longer exists" error erodes trust during ordinary editing. Worth root-causing before it recurs at scale on the heavy account.

## References
- `src/server/writeApi/handler.ts:99` (the message), `src/server/writeApi/tenancy.ts` (`checkTenancy` / `unknown_entity`).
- `src/store/richTextConvert.ts` (D1 heal-on-load), `src/store/sync.ts` (`enqueueIfSyncing`), `src/server/writeApi/store.ts:540` (`ON CONFLICT DO NOTHING`).
- Owner screenshot 2026-07-17 (not in repo).
