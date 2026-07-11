# 069: Duplicate project entry on the home screen — `createProject`'s optimistic prepend is not re-entrancy-safe

- **Status**: SHIPPED
- **Milestone**: M6 — projects list correctness
- **Severity**: Medium — a real duplicated DB row (survives reload), not a render glitch. GitHub **#10**.
- **Found via**: read-only investigation (2026-07-10), reproduced in a standalone PGlite harness.

## Symptom / discrepancy

Reported repro: create a new project → open it → return to the home screen → the same project appears **twice** in the list.

## Root cause

`useProjectsStore.createProject` (`src/store/projects.ts:114-150`) is the **only** store mutation that isn't re-entrancy-safe. Every sibling (`renameProject`, `archiveProject`, `importProject`, `adoptProject`, `refreshProjects`) re-reads the canonical list via `set({ projects: await dbList(db) })`. `createProject` instead does an **unconditioned optimistic prepend**:

```ts
const row = await dbCreate(db, ...)
set({ projects: [row, ...get().projects] })
```

Two overlapping `createProject` calls both complete and both prepend — **two distinct uuidv7 rows, same name, both persisted in PGlite** (verified empirically). `PhantomInput` (`src/components/ui/inline-editor.tsx:121-149`) gives no "creating…" feedback and never disables while a submit is in flight, so an impatient retry (or a stray duplicate submit) starts a second independent create before the first settles.

**Empirically ruled out** (by the investigation, not just inspection): plain SPA navigation (mount → unmount → remount does not touch the array; `App.tsx` `init()` runs once); Electric read-path echo (`src/store/sync.ts` `onApplied` never writes `useProjectsStore.projects` for `projects`); client/server id mismatch (`src/server/writeApi/store.ts:457-463` inserts the client's own uuidv7 verbatim). **Caveat**: the confirmed mechanism is *concurrent* create; the exact single-create+navigate repro wasn't reproduced — the fix below is robust to both, and the red test will pin the real trigger.

## Fix direction (minimal)

1. **`src/store/projects.ts` `createProject` (114-150)** — make it re-entrancy-safe. Simplest and most consistent: re-read via `set({ projects: await dbList(db) })` like every sibling mutation, instead of the bespoke optimistic prepend. (Or an in-flight lock / dedupe-by-id before prepend.)
2. **`src/components/ProjectsList.tsx` (~108, the `projects.map`)** — defense-in-depth: dedupe by `id` before rendering, so any upstream duplication can never surface as a visibly duplicated row.
3. **`src/components/ui/inline-editor.tsx` (`PhantomInput`, 121-149)** — track a local "submitting" flag so a second Enter before the first commit lands is a no-op. Note `onSubmit` is currently typed `(value: string) => void`; guarding in the input requires either an awaited return or lifting the guard to the caller — keep the contract change minimal.

## Test-first plan (red first)

1. **`src/store/projects.test.ts`** — `two concurrent createProject calls for the same input do not produce two projects`: `await Promise.all([createProject('Tavalo'), createProject('Tavalo')])`; assert `projects` length 1 and `listProjects(db)` length 1. *Fails today (length 2).*
2. **`src/components/ProjectsList.test.tsx`** — render dedup: seed the store with a duplicated id (`setState({ projects: [dup, dup] })`), render, assert `getAllByText('Tavalo')` length 1. *Fails today (no dedup).*
3. **`src/components/ui/inline-editor.test.tsx`** (optional companion) — two Enters before a promise-returning `onSubmit` resolves invoke it once until settled.
4. Standing gates: `npm run verify:fast` green.

## Dependencies / ordering

Rebased on **068** (keystone) — `refreshProjects`/`sync.start` were reshaped there. Re-verify the create path against the loosened `refreshProjects()` gate (068 makes it restart sync more often). Runs before #9 (070); both touch `src/store/projects.ts` (different functions) — sequence, don't parallel-edit.

**References**: `src/store/projects.ts` (`createProject` + sibling mutations pattern), `src/components/ProjectsList.tsx`, `src/components/ui/inline-editor.tsx`, `src/server/writeApi/store.ts:457-463` (server-side id passthrough, ruled out as cause).
