# 025: Architecture promote/selection bar drifts to the table bottom

- **Status**: OPEN
- **Milestone**: M6 (Polish)
- **Blocked by**: 014 (SHIPPED)

## Slice

As a designer selecting architecture entries to promote, the selection summary + "Use as dimension…" action stays **near what I selected and always in view**, instead of pinned to the bottom of a table that may be dozens of rows tall.

## Bug report (from user testing)

> "The on-select menu appearing at the bottom of the table may be a problem as the number of rows becomes larger. We are probably better off having it to the side and nearer to the first selection."

Confirmed in `ArchitectureSurface.tsx` + `base.css`: the `.t2-selection-bar` (count + `Use as dimension…`) renders **after the grid**, inside the panel, with `border-top` — a bottom bar. With few rows it sits just under the selection; as a table grows the action is pushed far below the selected rows (and below the fold), so the user selects near the top and must scroll to the bottom to act.

## Scope

- Reposition the selection summary + promote trigger so it is **always visible and close to the selection** regardless of row count — a sticky/floating anchor rather than end-of-list flow.
- Preserve the existing progressive-disclosure behavior (appears only once `selected.size > 0`) and the promote popover (`Use as dimension…`) unchanged.
- Per-table (each `t2-table` panel owns its own selection today) — keep that scoping.

Out of scope: the promote flow itself (issue 014), multi-table selection, keyboard selection model.

## Design brief

- **Placement options** (pick in implementation, grounded in STYLE_GUIDE §4 elevation/shape — square, hairline, no shadow unless a floating layer warrants the sanctioned popover shadow):
  1. **Sticky within the panel** — the bar sticks to the top or bottom edge of the panel's scroll viewport so it never leaves view while scrolling a tall table (least structural change; stays a bar).
  2. **Side rail** — a slim action column to the right of the table, vertically aligned near the **first selected row** (matches the user's "to the side and nearer to the first selection").
  3. **Floating anchor** — a small action cluster anchored to the first selected row's right edge, following selection.
- **Recommended**: start with **(1) sticky** for correctness with minimal risk; consider **(2)/(3)** if the side placement is explicitly wanted. Confirm direction before building (this changes layout structure).
- **Quiet until needed** (progressive disclosure, issue 014): no bar with zero selection; appears calmly (STYLE_GUIDE §8 motion — ≤100ms, no bounce).
- **Consistency**: the count uses `--ink-muted` label type as now; the promote trigger stays the accent-text action. If it becomes a floating layer, it uses the one sanctioned popover shadow (STYLE_GUIDE §4), else stays flat with a hairline.

**References**: STYLE_GUIDE §4 (space, shape, elevation), §8 (motion), §10 (focus order — the action must remain reachable/visible) · issue 014 (Tier 2 promote flow, selection bar) · SPEC §4.6 (Promote to Design)

## Test-first plan

1. Component (`ArchitectureSurface.test.tsx`): with a tall table (many entries) and a selection at the top, the selection bar/action is rendered in a sticky/anchored container (assert the positioning class/role), not appended after the last row.
2. Component: bar still appears only when `selected.size > 0` and still opens the promote popover.
3. e2e (extend `architecture.spec.ts`): select an entry near the top of a long table; the "Use as dimension…" trigger is in the viewport without scrolling to the bottom.
4. Regression: existing promote e2e passes unchanged.

## Acceptance criteria

- [ ] The selection summary + promote action stays visible and near the selection for tables of any height (no scroll-to-bottom to act).
- [ ] Progressive-disclosure and promote-popover behavior unchanged.
- [ ] `npm run verify` green; no visual regression for the empty/single-selection case.

## Implementation notes

- Today: `ArchitectureSurface.tsx` renders `{selected.size > 0 && <div className="t2-selection-bar">…}` after `<EditableGrid>`; `.t2-selection-bar` uses `border-top` at the panel bottom.
- Sticky path: move the bar into a `position: sticky` container within the panel's scroll region (or make the panel body scroll and the bar stick). Mind the frozen-column/scroll setup already in the register (HANDOFF gotcha about `border-collapse` + shadows) if the table introduces its own scroll.
- Side/anchor path: needs the first-selected row's offset — track it from the selection Set + row geometry; heavier, only if the side placement is chosen.
- Keep it token-driven (no hardcoded colors/shadows); reuse the popover-shadow token only if it becomes a floating layer (ADR-0007, STYLE_GUIDE §11).
