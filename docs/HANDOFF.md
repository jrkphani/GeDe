# HANDOFF — 2026-08-24 (zoom-over-tables root-caused + shipped; design-prose-references Phases 1–3 shipped, Phase 4 next)

**Two workstreams this session.** (1) A user bug report — "zoom doesn't work when the cursor is over a table" — investigated with an explicit red-team/green-team split before touching code, then fixed with a long-term architectural change (not a patch). (2) A large new feature, **design-prose-references** (`@`-mention citations from Design justification prose to Architecture entries), executed as a user-approved 9-phase plan; Phases 1–3 shipped this session, Phase 4 is next. Both workstreams used **cloud/remote agents for implementation**, with the orchestrating session independently re-verifying every agent's actual git state (not its self-report) before pushing — this caught real problems twice (see Patterns).

---

## Current state

HEAD: **`3954c73`**. Working tree clean, **0 open PRs**, `main` green, deploy pipeline healthy (`verify`/`migration-parity` gate `deploy`, confirmed on every merge this session including the one that ran a real migration against production Postgres).

### What shipped THIS session — 6 PRs, all CI-green + deployed

- **`#23` — uniform canvas zoom gesture router (`570467f`).** Root cause (confirmed against `@xyflow/react`/`d3-zoom` source, not assumption): every table node body carried React Flow's `nodrag nopan nowheel` classes, and that filter is a **pure DOM-ancestry check with zero modifier-key awareness** — it blocked Cmd/Ctrl+wheel zoom and trackpad pinch (a `wheel` event with `ctrlKey:true` and no real Control keydown) unconditionally whenever the gesture started over a table. Canvas and tables were never separate render layers (tables already sit inside the zoomed/panned React Flow nodes) — the bug was purely event routing. Fix: `src/components/canvasGestureRouter.ts`, one capture-phase listener on `.workspace-canvas` that neutralizes `nowheel` (lets React Flow's own already-correct wheel/zoom handling run everywhere), keeps `nopan` real (protects single-pointer drag-inside-a-table), and self-drives real two-finger touch pinch (replicating d3-zoom's own `zoom' = zoom * dist'/dist` formula) since native pinch is gated by that same `nopan` filter. Verified in a **real running browser**, not just tests — screenshots of Cmd/Ctrl+wheel actually zooming a table body to 200%. 5 new e2e specs, one of them a genuine (not simulated) two-finger CDP pinch.
- **`#21`/`#22` (pre-existing at session start, listed for continuity) — `#21` un-fixme'd 3 emulated-touch specs into a new `touch-serial` Playwright project; `#22` had to re-quarantine the drag-reorder one after it flaked twice more in CI even with pacing.** This resolved last session's own backlog item ("un-bank the touch specs now that canvas-serial exists") — 2 of 3 are live; the third stays `test.fixme`, a genuine CI-load flake unrelated to product code (mouse twin covers the behavior reliably).
- **`#24`/`#25`/`#26` — design-prose-references Phases 1–3.** See below.

---

## design-prose-references — feature status

**The model:** Design context `justification` prose (Lexical JSON) gets `@`-reference tokens by stable `referenceId`; a new `design_prose_references` table maps each token to a recursive Architecture (`tier2_entries`) row. Names/paths/siblings/children always resolve live, never copied into the document.

**Before building anything**, the user's own proposal was validated with a red-team/green-team pass against the actual codebase (not taken on faith) — caught two real corrections: the reference node **cannot be a Lexical `DecoratorNode`** (`src/domain/richText.ts` explicitly bans them; must be a `TextNode` subclass so plain-text extraction works for free), and `ContextRegister`'s "justification editor" **isn't a standalone component** — it's a `kind:'richtext'` column config on the shared `EditableGrid` (`ContextRegister.tsx:219-236`), which is good news: that component is shared between the React Flow canvas AND the non-canvas fallback surface (`WorkspaceSurface.tsx`, which is **real production behavior** for narrow/data-saver clients per `canvasMode.ts`'s `canvasCapable()` gate, not a dev-only path as an old code comment claimed), so one integration point covers both.

- **Phase 1 (`#24`, `7736fa7`)** — pre-flight cleanup (one dead re-export removed from `projectEnvelope.ts`) + full test baselines + `src/domain/entryTreeFixtures.ts` (scale fixtures: `manyTables`, `deepChain`, `wideSiblings`, `duplicateNamedEntries`, composed `bigArchitectureFixture()` — 40 tables/25-deep/60-wide/3-duplicate).
- **Phase 2 (`#25`, `54e4824`)** — `src/domain/entryReferenceIndex.ts`, a pure domain module: `buildEntryReferenceIndex(tables, entries)` does one DFS pass per table (not per-node `subtreeIds`, which would be O(n²) at fixture scale) producing candidates with full ancestor path, sort-ordered siblings/children, archived state; `searchEntryReferences` does tiered case-insensitive scoring (name-prefix 100 / name-substring 70 / path-substring 40 / description-substring 20) mirroring `paletteRanking.ts`'s `rankCommands`. Deliberately builds in-memory from already-fetched store data — this schema has **no FK-column indexes anywhere** (confirmed by grep during validation), so a DB-query-based index would have hit that gap; this design sidesteps it.
- **Phase 3 (`#26`, `3954c73`)** — `src/db/migrations/0019_design_prose_references.sql` + `designProseReferences` in `schema.ts`: direct-`workspace_id`-read RLS (matching `dimensions`/`contexts`/`canvases`, verified against `0017_canvases.sql` line-for-line — **not** the FK-chain subquery pattern `parameters`/`tier2_entries`/`bindings` use), indexed on both FKs (a deliberate, commented deviation from this schema's usual no-FK-index convention). `setContextJustificationWithReferences` (`db/mutations.ts`) commits prose text + reference-row diffing as one `db.transaction` — treats `referencedEntryIds` as a **multiset** (duplicates meaningful: same entry cited twice = two rows), matches live rows first, then revives tombstoned ones, then inserts fresh, then tombstones anything left unclaimed — keeping ids stable across repeated commits (undo/redo replays the setter with captured prior state, not a row snapshot). `src/store/contexts.ts`'s `setJustificationWithReferences` wraps it with one command-log entry + per-row sync enqueueing. **This is purely additive — the existing `setJustification` the live UI actually calls is untouched**, so none of this is reachable from production yet. Required wiring the table into several exhaustive `Record<TableName,...>` type maps (`syncDelta.ts`, `db/sync.ts`, `syncScope.ts`, `electricProtocol.ts`, `mutationProtocol.ts`, `server/writeApi/store.ts`, `sync/writeTransport.ts`) purely for type-soundness — no live server route was stood up; project-envelope (import/export) wiring was deliberately deferred and is explicitly excluded via `projectIO.test.ts`'s `NON_ENVELOPE_TABLES` guard, not silently missing.

### Remaining phases (not started)

- **Phase 4** — Envelope v6→v7 (confirmed current version is 6, not the placeholder v6→v7 guess — that part of the plan was already right), register the table through gather/restore/reconciliation, wire into sync scope/delta client-queue handling (most of this got pulled forward mechanically in Phase 3 already — Phase 4's real remaining work is mainly the envelope).
- **Phase 5** — Server write path + tenancy validation — **this is where the table becomes live-reachable for the first time.** `NATURAL_KEY_CONFLICT` must NOT include this table (no uniqueness constraint on `(context_id, source_entry_id)` is deliberate).
- **Phase 6** — Lexical `TextNode` reference node in `richText.ts` — land with a second `RICH_TEXT_NODES_WITH_REFERENCES` array + an `allowReferences` option defaulting `false` on `safeRichTextJson`, so the allowlist widening doesn't leak into every rich-text field (tier1 prose, grid cells) before Phase 8's UI exists to use it.
- **Phase 7** — Caret-anchored `@`-autocomplete (`src/components/ui/command.tsx` + `popover.tsx`'s `PopoverAnchor` are the existing primitives to build on — `combobox.tsx` is the closest precedent).
- **Phase 8** — Wire into `ContextRegister`'s justification column via an opt-in `EditableGrid` cell flag (same pattern as `roomy`) — **this is the phase that makes `setJustificationWithReferences` reachable from the live UI.**
- **Phase 9** — Component + e2e validation, screenshots, full gate.

---

## Backlog (OPEN)

- **design-prose-references Phases 4-9** — the main actionable item. Phase 5 (server/tenancy) and Phase 6 (Lexical allowlist) both touch security-relevant surfaces; give them the same line-by-line review this session gave Phase 3, not just the agent's self-report.
- **`099` remainder — mostly still MANUAL-ONLY, but narrower now.** `#23` added a genuine (not simulated) 2-finger CDP touch-pinch e2e spec that passes reliably — CDP *can* dispatch true multi-touch. What remains un-automatable is specifically **physical hardware fidelity**: momentum, palm rejection, real capacitive-touch platform gesture recognition. Narrow this item's scope in the next update rather than carrying it forward unchanged.
- **Consolidate the two CDK asset-hash normalizers** (`normalize-asset-hashes.ts` vs. the `#19` serializer) — still both present, still unresolved, not touched this session.
- **CDK tests leak `cdk.out*` into `$TMPDIR`** — still unresolved, not touched this session.
- **Status bar reads "Syncing…" while signed out** — still unresolved, not touched this session.

---

## Patterns (this run — reuse)

### Cloud/remote agents — never trust the self-report, verify the worktree

- **A "completed" task-notification is not proof of a real, final state.** Three separate background agents this session sent an early notification whose `result` was just meta-text ("I'll pause and wait for the monitor…") while still actively working — the REAL completion (with commits) arrived in a **second, later** notification on the same task-id. Acting on the first one (running `recover-agent`, independently re-verifying) was safe and correct; the danger is racing your own verification against the agent's still-running process.
- **Concrete failure mode hit twice: running your own `npm run verify` in the same worktree while the agent's background process is still alive causes a real port/dev-server collision** (`ERR_CONNECTION_REFUSED` cascades that look exactly like a real regression). Diagnosis: check for a lingering `@playwright/test/cli.js test-server` process — if it's idle (0% CPU, no recent file writes), it's a leftover daemon, kill it and re-run clean; if it's actively consuming CPU, the agent is still working, wait.
- **Worktrees from `isolation:"remote"` don't always get a real `npm ci`.** One agent worked around a missing `node_modules` by patching `vite.config.ts`'s `server.fs.allow` instead of installing — explicitly self-flagged as "not part of any approved change," but still had to be caught and reverted before committing. Always check `node_modules/.bin/vite` exists before trusting a worktree's test run; `npm ci` if not, never a config workaround.
- **A "5 files max" phase scope can legitimately balloon under a strict type system.** Phase 3 touched 15 files, not 5 — adding one table to a discriminated union (`TableName`) cascaded through every exhaustive `Record<TableName,...>` map the compiler enforces. This was a genuine, honestly-disclosed resolution to a contradiction in the phase's own instructions (required `enqueueIfSyncing` wiring while also saying "don't do Phase 4/5 scope") — verified safe by tracing that none of the extra files stood up a live endpoint or changed any function the live UI actually calls, not by trusting the "mechanical" label.

### Investigation before building

- **Red-team/green-team validation caught real errors before they became code.** For the zoom bug: red team confirmed the exact `nowheel`/`nopan` filter mechanism against `@xyflow/system`/`d3-zoom` source (not memory of "how these libraries usually work"). For the reference-system plan: the same split caught the `DecoratorNode` ban and the `ContextRegister`-isn't-a-component misconception before Phase 6/8 would have hit them mid-implementation.
- **A live-browser check found what tests couldn't.** After PR #23 merged, driving the actual deployed app with a real (headless) Chromium session — not just re-running e2e — visually confirmed the fix at 200% zoom. Incidentally surfaced an unrelated `ProjectsList` row-click hit-testing quirk (a `role="button"` div with nested Rename/Archive buttons occasionally intercepts a coordinate-based click during a layout transition) — not acted on, flagged for whoever touches that component next.

### CI (reinforcing last session's own lesson)

- **"Never hardcode a count that a routine change bumps" struck again, one property later.** Last session it was `MigrationFileCount` as a raw literal in a snapshot; this session the SAME property broke again, correctly, because `#26` added a real 19th→20th migration file — this time it was already snapshot-derived (not hardcoded), so the fix was just `npx jest test/migration-stack.test.ts -u` after confirming the diff was exactly that one line. The lesson generalizes: any CDK snapshot touching a **count or structural property**, not just asset hashes, needs a diff read before `-u`, every time a migration is added.

---

## Non-negotiables & tooling

- **Deploy = push to `main`** → CI `verify` + `migration-parity` (parallel) → `deploy` via `workflow_run` gated on **`migration-parity`, not `verify`** (confirmed repeatedly this session — deploy can complete while `verify`'s e2e suite is still finishing; treat `verify` as a confirmatory gate, not the deploy trigger, when checking status quickly).
- **Schema only via migrations.** `#26` correctly added `0019`; RLS pattern must be chosen deliberately (`dimensions`/`contexts`/`canvases`'s direct-`workspace_id` read vs. `parameters`/`tier2_entries`/`bindings`'s FK-chain subquery) — don't copy the nearest template without checking which convention it actually uses.
- **eslint:** 0 errors (7 pre-existing warnings, unchanged all session). **Envelope:** current `FORMAT_VERSION = 6` (`projectEnvelope.ts:58`) — Phase 4 bumps to 7.
- **MANDATORY adversarial review for any store/render/write-path or schema/RLS touch** — this session that meant literally reading the migration SQL and the write-path type maps line-by-line before pushing Phase 3, not trusting the implementing agent's report.

## Definition of done / next
6 PRs (`#21`–`#26`) merged and **DEPLOYED**; `main` = `3954c73`, clean, 0 open PRs. The zoom-over-tables bug is fully fixed and live-verified. design-prose-references Phases 1–3 are shipped and live (inert until Phase 8 wires the UI). **Next session: Phase 4 (envelope v6→v7 + sync registries) of design-prose-references**, continuing the same red/green-validate → cloud-agent-build → independent-verify → merge cadence, with extra scrutiny on Phase 5 (server/tenancy) and Phase 6 (rich-text allowlist widening) when they come up.

---

*History (archived to `docs/issues/done/` / prior handoff): 084; 087–098; 089 (D1/D2/D3-graduation); 100; 101/102/103; 104; 105; 106; 107; 088; 014-020 (release-engineering unfreeze, 2026-08-16). PRs this run: #21 #22 #23 #24 #25 #26. OPEN: 099 (narrowed to physical-hardware-only) + design-prose-references Phases 4–9 + 3 pre-existing infra follow-ups (asset-hash normalizer dup, cdk.out leak, "Syncing…" label). Updated 2026-08-24.*
