# 011: Recursion — drill into a context

- **Status**: OPEN
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

## Test-first plan

1. Unit: first drill-in creates exactly n child dimensions mapped to the parent's bindings, idempotent on re-open; parent re-bind after drill-in flags the child dimension as stale (decide + test the resolution rule: child dimension follows the new parameter, existing sub-bindings soft-deleted with warning).
2. Unit: symbol lineage — α's children are α1…αk; deleting α2 doesn't renumber α3 (identity stability).
3. Unit: recursion depth — build a depth-5 chain; selectors stay scoped per canvas with no cross-level leakage.
4. e2e: reproduce the Numbers drill-down — α (Seating comfort/Users/Modality of engagement) → child canvas with the five Users sub-parameters → create α1–α4 → breadcrumb back → root canvas unchanged (SPEC §6 M3 done-when).

## Acceptance criteria

- [ ] Drill-in is non-destructive and repeatable (no duplicate child dimensions on second open).
- [ ] The parent re-bind stale rule is decided, documented in this file, and covered by tests.
- [ ] Browser back mirrors breadcrumb navigation exactly.
