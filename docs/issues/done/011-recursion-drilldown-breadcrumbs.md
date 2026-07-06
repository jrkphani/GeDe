# 011: Recursion — drill into a context

- **Status**: SHIPPED
- **Milestone**: M3
- **Blocked by**: 010

## Slice

As a designer I open α and get its child canvas: α's n bound parameters become the dimensions, their sub-parameters populate the arcs, and sub-contexts (α1, α2…) live inside. Breadcrumbs take me up and down; register and canvas scope together (SPEC invariant 3, §4.1).

## Scope

- Store: drill-in seeds child `dimensions` rows one-per-parent-binding (`source_param_id` set) on first open; sub-parameter creation prompt when a seeded dimension has none.
- Sub-parameter management UI (reuses slice 003 components against `parent_param_id`).
- Symbol lineage: children auto-named `parent + index` (α1, α2), override allowed.
- Breadcrumb bar (`Root ▸ α ▸ α2`); browser back/forward integration; both projections scoped to the current canvas.
- Drill-down zoom transition (CSS, reduced-motion aware).

## Design brief

- **Drill-in**: double-click / Enter on a context zooms the canvas into the node (~200ms, the app's one choreographed transition; instant under reduced motion). The child canvas fades in on the same graph paper — same place, deeper scale.
- **Breadcrumbs**: mono symbols in a hairline bar (`Root ▸ α ▸ α2`), each crumb clickable; browser back/forward mirror it exactly. The current canvas's dimension names render beside the trail as muted context.
- **First-open seeding**: if seeded dimensions lack sub-parameters, the child canvas opens with the dimension manager popover already showing those dimensions and phantom rows ready — "α's canvas needs parameters. Its dimensions come from α's bindings." No blocking wizard; the designer can look around first.
- **Stale parent binding**: a hairline banner (warning color, not danger) atop the child canvas: "α re-bound *Users* → *Buyers*. This canvas now refines *Buyers* — 3 sub-bindings were retired (Undo)." Resolution is informational + undo, not a decision dialog (the rule itself is defined in scope).
- **Wayfinding**: child contexts show lineage in their register symbol column (α2, not 2); the canvas header names the parent tuple so "where am I" is always answerable.
- **Empty child canvas**: standard empty state plus one lineage line: "Refining {Comfort} {Users} {Engagement}".

**References**: SPEC §1, §4.1, invariant 3 · SITEMAP §1 (depth segments in URL), §2–3 (breadcrumbs in context bar, overflow rules) · STYLE_GUIDE §7, §8 (drill-down exception) · ADR-0002 · issues 002–003 (reused managers)

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Unit: first drill-in creates exactly n child dimensions mapped to the parent's bindings, idempotent on re-open; parent re-bind after drill-in flags the child dimension as stale (decide + test the resolution rule: child dimension follows the new parameter, existing sub-bindings soft-deleted with warning).
2. Unit: symbol lineage — α's children are α1…αk; deleting α2 doesn't renumber α3 (identity stability).
3. Unit: recursion depth — build a depth-5 chain; selectors stay scoped per canvas with no cross-level leakage.
4. e2e: reproduce the Numbers drill-down — α (Seating comfort/Users/Modality of engagement) → child canvas with the five Users sub-parameters → create α1–α4 → breadcrumb back → root canvas unchanged (SPEC §6 M3 done-when).

## Stale parent-rebind rule (DECIDED — issue 011)

When a parent context's binding for a dimension *d* changes from parameter *p_old*
to *p_new* **after** its child canvas already exists, on the next reconciliation
(drill-in / child-canvas open) the child dimension seeded from *p_old* **follows
the new parameter**:

- its `source_param_id` and display name update to *p_new* (in place — no
  duplicate dimension row, so re-open stays idempotent);
- any child-context sub-bindings on that child dimension are **retired
  (hard-deleted)** — they pointed at *p_old*'s sub-parameters, which are no
  longer selectable on the dimension;
- the child canvas surfaces a non-blocking **warning** banner (`--warning`, not
  `--danger` — nothing is lost destructively) naming the change and the
  retired-binding count, with an **Undo** that restores the child dimension to
  *p_old* and re-inserts the retired sub-bindings (`revertStaleRebind`).

The parent canvas is never mutated by this reconciliation — the child only ever
follows the parent. Reconciliation is idempotent: once the child dimension has
followed to *p_new* there is no further drift to detect. Covered by
`src/db/recursion.test.ts` (mutation-level: follow + retire + revert) and
`src/store/recursion.test.ts` (store-level: banner event + Undo).

## Acceptance criteria

- [x] Drill-in is non-destructive and repeatable (no duplicate child dimensions on second open).
- [x] The parent re-bind stale rule is decided, documented in this file, and covered by tests.
- [x] Browser back mirrors breadcrumb navigation exactly.

## Shipped notes

- **Migration** `0006_recursion_source_param` (journal idx 6): one column, `dimensions.source_param_id` (+ FK → `parameters`). `parameters.parent_param_id` (from 003) and `dimensions.context_id` were reused as intended — no other schema. (014 owns idx 5.)
- **Sub-parameter model**: per-child (`dimension_id = child dim` AND `parent_param_id = source`), so the parameters store / `ParameterList` / `Canvas` / register reuse unchanged. Child dimensions are seeded one-per-parent-binding on first open; symbol lineage `α → α1, α2` via existing `nextChildSymbol`.
- **Stale parent-rebind decision (the open rule)**: the child dimension **follows the new parameter** — on re-open its `source_param_id`/name update in place (idempotent, no dup rows) and child-context sub-bindings on it are retired (hard-deleted); a non-blocking `--warning` banner offers **Undo** (`revertStaleRebind` restores the dimension + re-inserts retired bindings). The parent is never mutated. Tested at mutation level (`src/db/recursion.test.ts`) and store level (`src/store/recursion.test.ts`).
- **Scope generalization** (`mutations.ts`, `store/contexts.ts`, `store/dimensions.ts`): dimension/context lists are now canvas-scoped (`contextId`/`parentId`); both projections (canvas + register) scope to the current canvas (SPEC invariant 3). Load actions set scope synchronously before awaiting (the paid-for CI race).
- **UI**: `Breadcrumbs.tsx` (`Root ▸ α ▸ α2`, mirrors browser back/forward — route already carried `contextPath`, so no `routes.ts`/`router.ts` change), `ChildCanvasBanners.tsx`, drill-in via double-click/Enter/register "Open ▸". Zoom is the app's one choreographed transition (`.canvas-zoom` keyed on canvas); resting state is the final state so `prefers-reduced-motion` renders it fully, not blank.
- **Merge note**: cherry-picked last onto the 010+012+014+017 tip. Conflicts resolved: `DesignSurface.tsx` (kept 011's breadcrumbs + parameterized `DimensionManager` **and** 012/014's view toggle/coverage stat/draft count; dropped a duplicate `navigate` import) and `_journal.json` (kept both idx 5 and idx 6). All else auto-merged.
- **Verified**: full `npm run verify` green on main. Manual chromium screenshots confirmed child-canvas seeding, breadcrumbs 2-deep, the stale-rebind banner + Undo, and reduced-motion child render.
