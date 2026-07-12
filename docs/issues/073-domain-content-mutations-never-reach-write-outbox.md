# 073: Project content never persists to the server — domain-content mutations are never enqueued to the write outbox

- **Status**: IN PROGRESS (pt1: helper + tier1/tier2/contexts wired + tested)
- **Milestone**: M11 — cloud write loop (completeness)
- **Severity**: **Critical** — after 068/071/072 the project *shell* persists, but everything INSIDE it (foundation purpose/props, architecture tables/entries, dimensions, parameters, contexts, bindings) is local-only and is permanently lost on the 063 sign-out wipe. The UI shows a false "Synced." Blocks a meaningful sharing test (an invitee receives an empty project).
- **Found via**: live e2e after 072 (2026-07-11) — a 30s-idle diagnostic after editing content saw ZERO `/write` calls; only the project `insert` ever reached the outbox all session.

## Root cause (proven)

The client mutation-queue (032/048) is **opt-in per call site**, not automatic. `useSyncStore.enqueueLocalMutation()` (`src/store/sync.ts:318-326`) is the only path into the outbox, and nothing forces a mutating DB write to also enqueue. Only **9 sites** are wired: `createProject`/`adoptProject` (`src/store/projects.ts`) and 7 `workspace.ts` actions (invitations/workspace_members). Every domain-content store — `tier1.ts`, `tier2.ts`, `dimensions.ts`, `parameters.ts`, `contexts.ts` — does `await dbXxx() → set() → commandLog.push()` and **never touches `useSyncStore`** (confirmed: zero `enqueueLocalMutation` refs in those files or their tests). `renameProject`/`archiveProject`/`restoreArchivedProject`/`importProject` in `projects.ts` have the same gap even though `createProject` beside them is wired.

## Fix — one shared helper + a call at every mutating site

No clean choke point exists below the store layer (`db/mutations.ts` is deliberately store-free; `commandLog.push()` carries no table/row/op metadata). So:

1. **Add `enqueueIfSyncing(table, rowId, op, row)`** (in `src/store/sync.ts`, exported) that encapsulates the existing 8-line boilerplate from `createProject`/`workspace.ts`: `if (useSyncStore.getState().workspaceId) enqueueLocalMutation({ id: uuidv7(), table, rowId, op, row, optimisticUpdatedAt: row.updatedAt, enqueuedAt: new Date().toISOString(), status: 'pending' })`. Write/review the guard + envelope shape ONCE. (Optionally refactor `createProject`/`adoptProject`/`workspace.ts` to use it — nice-to-have, not required.)
2. **Call it at every mutating store action** (~36 sites) with the correct `op`:

| File | Actions | Table(s) |
|---|---|---|
| `tier1.ts` | setPurpose, addProp, renameProp, setDescription, reorderProp, removeProp | tier1_purpose, tier1_props |
| `tier2.ts` | addTable, renameTable, addEntry, renameEntry(+cascade renameParameter), setEntryDescription, removeEntry, resolveKeep, resolveDeleteParams, promote | tier2_tables, tier2_entries, parameters, dimensions |
| `dimensions.ts` | add, rename, setColor, reorder, remove(+bindings cascade) | dimensions, bindings |
| `parameters.ts` | add, rename, reorder, remove | parameters |
| `contexts.ts` | create, discard, setSymbol, setJustification, bind, unbind, revertStale, syncBindingsForContexts | contexts, bindings |
| `projects.ts` | renameProject, archiveProject, restoreArchivedProject, importProject(whole tree) | projects |

## Op-selection rule (get this wrong → silent server-side no-op, the 066 bug)

- **New row** (add/create) → `'upsert'` (server `INSERT ... ON CONFLICT (id) DO NOTHING`).
- **Edit of an existing row** (rename, setColor, set*, reorder's moved rows, renameEntry's parameter propagation) → `'update'` (server bare `UPDATE ... WHERE id`). Using `'upsert'` for an edit **silently no-ops server-side** — see `src/domain/mutationQueue.ts:27`, `src/sync/writeTransport.ts:62-73`, `src/server/writeApi/store.ts:520-532`.
- **Soft-delete** (remove/archive/discard/dimension-remove cascade → tombstone) → `'delete'`.

**Subtlety A — natural-key upserts:** `setTier1Purpose` (`src/db/mutations.ts:855-865`) and `bindParameter` (`:617-635`) upsert on a natural key (`projectId` / `(contextId,dimensionId)`), reusing a stable `id`. The store must pick `'upsert'` only on the **first** create and `'update'` on every subsequent edit of that same row (track "did it already exist" — e.g. `get().purpose !== ''`, or a prior binding present). Getting this wrong reproduces the 066 no-op for these two.

**Subtlety B — multi-row side effects:** `reorderDimension`/`reorderProp`/`reorderParameter` call `rewriteSort` which updates `sort` on **every sibling row** (`src/db/mutations.ts:203-217`); dimension-remove cascades to `bindings` tombstones; bind/unbind touch `bindings` + tuple-hash. Enqueue an `'update'`/`'delete'` for **every row whose column actually changed**, not just the one the user acted on — else sibling sort/hash drift never syncs and reappears stale after a full resync.

## FK-ordering (safe by construction)

Dependency order `projects → tier1_*/tier2_tables → tier2_entries → dimensions → parameters → contexts → bindings` (`src/domain/projectEnvelope.ts:177-187`, `store.ts:41-52`). The write handler applies mutations in client-queued order, and store actions run sequentially in natural order (can't add a child before its parent exists locally), so enqueueing at each call site is FK-safe with no batching/reordering. Parent project/workspace already ensured by 071/072.

## Test-first plan (red first — existing store tests assert persistence+undo only, never enqueue)

Per store, new `describe('sync enqueue')` seeding `useSyncStore.setState({ workspaceId: 'ws1' })` then asserting `useSyncStore.getState().queue` gains the right entry:
- `tier1.test.ts`: setPurpose → `'upsert'` first call, `'update'` on second (Subtlety A); addProp → `'upsert'`.
- `tier2.test.ts`: addTable/addEntry → `'upsert'`; promote → enqueues for every created dimensions/parameters row.
- `dimensions.test.ts`: add → `'upsert'`; reorder → an `'update'` for **every** row whose sort changed (Subtlety B); remove → `'delete'` + bindings `'delete'` cascade.
- `parameters.test.ts`: add → `'upsert'`; rename → `'update'`.
- `contexts.test.ts`: create → `'upsert'`; bind → correct `'upsert'`/`'update'` by whether the pair existed (Subtlety A).
- `projects.test.ts`: renameProject → `'update'`; archiveProject → `'delete'`.
- **Cross-cutting** (`src/store/syncEnqueue.integration.test.ts`, new): signed-in workspace, one representative mutation through each of the 5 domain stores + renameProject → assert `pendingCount(queue) === 6`. Directly encodes the live symptom.
Standing gate: `npm run verify:fast` green.

## Execution (two sequential subagents, main tree)

- **Part 1:** helper in `sync.ts` + wire `tier1.ts`, `tier2.ts`, `contexts.ts` (the natural-key/cascade group) + their enqueue tests. Commit `fix(073) pt1`.
- **Part 2 (after pt1):** wire `dimensions.ts` (reorder multi-row), `parameters.ts`, `projects.ts` (rename/archive/restore/import) + the cross-cutting integration test. Commit `fix(073) pt2`.
Sequential (both use the helper); disjoint store files; no worktree needed.

## Notes

- `workspace.ts:149` `changeRole` still ships the 066-class `'upsert'`-for-an-edit bug (its own KNOWN LIMITATION comment) — fix it while here if trivial, else note.
- `presence.ts` is genuinely ephemeral/local-only — correctly NOT wired; leave it.
- (RLS-no-op + tenant-context-key follow-up from 071 is now **candidate 074**, not 073.)

**References**: `src/store/sync.ts:318-326` (`enqueueLocalMutation`), `src/store/projects.ts:189` + `src/store/workspace.ts` (the 9 wired examples), `src/store/{tier1,tier2,dimensions,parameters,contexts}.ts` (unwired), `src/domain/mutationQueue.ts` + `src/sync/writeTransport.ts:62-73` (op semantics), `src/db/mutations.ts:203-217,617-635,855-865` (rewriteSort + natural-key upserts), `src/server/writeApi/store.ts:41-52,520-532` (FK order + op handling).
