# 070: Archived projects are unreachable — no list/restore beyond the transient "Undo Archive"

- **Status**: IMPLEMENTED (code-complete + verify:fast green)
- **Milestone**: M6 — projects list / archive management
- **Severity**: Medium — archived projects are safely persisted but permanently unreachable through the UI once the session-scoped undo is gone. GitHub **#9**.
- **Found via**: read-only investigation (2026-07-10).

## Symptom / discrepancy

Multiple projects have been archived, but **only the most recently archived one can be restored** (via "Undo Archive"). There is no way to view or restore previously archived projects.

## Root cause

Archiving is a soft-delete that persists correctly — but nothing ever surfaces archived rows, and the only "restore" is a transient, single-slot undo:

- `archiveProject` sets `deleted_at`, `restoreProject` clears it (`src/db/mutations.ts:67-83`) — rows are never hard-deleted.
- `listProjects` unconditionally filters `WHERE deleted_at IS NULL` (`mutations.ts:85-92`). **No `listArchivedProjects` exists anywhere** (grep-confirmed).
- "Undo Archive" is **not** archive-specific — it's the generic command-log LIFO stack (`src/store/commandLog.ts`), which is (a) **wiped on every project-open**: `AppShell.tsx:309-313` calls `useCommandLogStore.getState().clear()` in a `useEffect` on `[projectId]`, and (b) surfaced to the user only as the **single most recent** action via `useStatusStore`'s one-slot `announce()` (`src/store/status.ts`); `ProjectsList.tsx` calls `announce('Archived "X"', { label: 'Undo', run: undo })` on each archive, so a second archive silently replaces the first's Undo affordance.

Net: only the last archive is reachable, and only until navigation/reload. No schema change needed — `deleted_at` already exists (`src/db/schema.ts:97`).

## Fix direction (minimal)

1. **`src/db/mutations.ts`** — add `listArchivedProjects(db)` beside `listProjects` (85-92): same shape, `WHERE deleted_at IS NOT NULL`, ordered `deletedAt desc`. `restoreProject` (76-83) already exists, unchanged.
2. **`src/store/projects.ts`** — add `archivedProjects: ProjectRow[]` state + `loadArchivedProjects()` (calls the new query) + `restoreArchivedProject(id)` (calls `dbRestore` then refreshes BOTH `projects` and `archivedProjects`, and pushes a command-log entry whose undo re-archives). Mirror the existing `archiveProject` pattern. **Do NOT touch `createProject` (069's in-flight lock) or `refreshProjects` (068) — additive only.**
3. **New UI — archived-projects view.** A panel/drawer listing `archivedProjects` with a per-row **Restore** button, reusing `ProjectsList.tsx`'s `.project-row` layout + `Button variant="rowAction"`. Placement (per SITEMAP/STYLE_GUIDE — neither mentions "archive" today, so this is new surface): a state on `/` (not a new route), consistent with Design tier's `?view=canvas|coverage` query-param pattern — e.g. `?view=archived` or a drawer. Entry point: an affordance near the existing "Import project" toolbar button in `ProjectsList.tsx` (~64-79). Feedback via the status bar `announce()` (nothing toasts), now backed by the durable `restoreArchivedProject`, not the fragile undo stack.

## Test-first plan (red first)

1. **`src/db/mutations.test.ts`** (or store test if no such file — verify) — `listArchivedProjects returns all archived rows, most-recently-archived first`: create A/B/C, archive A then C then B, assert it returns `[B, C, A]` and `listProjects` returns none of them.
2. **`src/store/projects.test.ts`** — `archiving two projects then restoring the OLDER one succeeds and leaves the newer archived`: archive A then B; `restoreArchivedProject(A.id)`; assert `projects` has A not B, `archivedProjects` has B not A. (This is the direct regression test — no code path exists to even attempt it today.)
3. `restoring an archived project is undoable via the command log (undo re-archives it)`.
4. `archived list survives a store re-init` (reset + re-init + `loadArchivedProjects`) — proves persistence independent of the session-scoped undo.
5. Standing gates: `npm run verify:fast` green.

## Dependencies / ordering

Runs AFTER #10 (069) — both touch `src/store/projects.ts` (069 = `createProject`, this = new archive state/actions; additive, different functions). Independent of 068 but sits on top of it in the commit chain.

**References**: `src/db/mutations.ts:67-92` (archive/restore/list), `src/store/commandLog.ts` + `src/shell/AppShell.tsx:309-313` (the transient undo that's wiped on open), `src/store/status.ts` (single-slot announce), `src/components/ProjectsList.tsx` (row layout to reuse + entry point), `src/db/schema.ts:97` (`deleted_at`, already present), `docs/SITEMAP.md` §1 + `docs/STYLE_GUIDE.md` (query-param view pattern, tokens).
