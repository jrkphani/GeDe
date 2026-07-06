# 024: Table legibility — alternating row colors + vertical column hairlines

- **Status**: OPEN
- **Milestone**: M6 (Polish)
- **Blocked by**: 004 (SHIPPED)

## Slice

As a designer reading any register/architecture/foundation table I can easily track **rows** (subtle alternating row background) and tell **columns apart** (faint vertical hairline between columns) — so wide, tall tables stay legible without becoming a spreadsheet cage.

## Bug report (from user testing)

> "We need some sort of visual to show one column apart from the next."
> "I think we can have alternating row color for the rows and hairline for vertical."

Confirmed in `base.css`: `.editable-grid th`/`td` carry only `border-bottom: 1px solid var(--hairline)` — **no vertical rules** between columns and **no row banding**. On a wide register (Symbol · Documented · one column per dimension · Justification · Children · Duplicate) adjacent columns run together, and long tables are hard to track across a row.

## Design decision (STYLE_GUIDE §6 amendment)

STYLE_GUIDE §6 currently reads: *"hairline row separators only (no vertical rules except between frozen symbol column and the rest)"* and *"Otherwise rows are quiet."* Chosen resolution (user, this session):

1. **Alternating row background** (zebra) — a very subtle wash on alternate rows for horizontal tracking.
2. **Vertical hairlines between all columns** (header + body) for column separation.

This issue includes the **§6 amendment** documenting both (superseding the "no vertical rules" clause and the "rows are quiet / hairline row separators only" clause). The frozen-symbol-column separation stays and may read one step stronger to keep its affordance.

## Scope

- Add a subtle **alternating row background** across `EditableGrid` body rows.
- Add a `--hairline` **vertical rule between every column** (header + body).
- Apply to **all** consumers (register, Foundation, Architecture, parameters, dimensions) — shared grid.
- Preserve: row-hover wash, selection state, the frozen symbol-column cue, the phantom row, in-place editor pixel-parity.

Out of scope: column resizing, changing the row-hover treatment itself (it composes with zebra), sortable headers.

## Design brief

- **Zebra weight**: alternate rows use a barely-there wash derived from the surface tokens (e.g. a `--paper`-tinted step), quiet enough that the table still reads as "comfortable Numbers density" (STYLE_GUIDE §6), never harsh banding. Row **hover** wash and **selection** must still be distinguishable *on top of* both zebra states (STYLE_GUIDE §4/§6) — check contrast for hover-on-odd and hover-on-even, selected-on-odd/even, in both themes.
- **Vertical hairlines**: same `--hairline` token as row separators — a quiet channel per column, header through last row; no rule after the last column (panel border closes it).
- **Phantom row**: the "type to add" phantom row should read as distinct from the zebra body (it's an affordance, not data) — keep its existing treatment; ensure zebra doesn't tint it into looking like a data row.
- **Frozen symbol column**: keep it visually distinct from ordinary inter-column hairlines (it uses `border-collapse: separate` + `--shadow-frozen-col` to survive horizontal scroll — HANDOFF gotcha). Bump one step if the uniform rules flatten the frozen cue.
- **Both themes**: verify zebra + hairlines are visible-but-quiet in light (canonical) and dark (STYLE_GUIDE §2); zebra must not fight the graph-paper ground.
- **Zero layout shift**: borders on `border-collapse: separate` + `border-spacing: 0` (already set) and background changes don't move cell metrics; editors stay pixel-parity (STYLE_GUIDE §6).
- **A11y**: banding/rules are decorative; they must not be the sole signal for anything (STYLE_GUIDE §10) and must preserve text contrast ≥4.5:1 on every row tint.

**References**: STYLE_GUIDE §6 (Tables — amended by this issue), §4 (hover/selection elevation), §2 (surface/hairline tokens, both themes), §10 (contrast on tinted rows) · ADR-0004 (EditableGrid owns cell chrome) · issue 004 (grid core), issue 005 (frozen symbol column / `border-collapse: separate` rationale)

## Test-first plan

1. Component (`EditableGrid.test.tsx`): body rows alternate a background class/token (assert odd/even distinction); the phantom row is exempt.
2. Component: every non-last column cell/header carries a right vertical hairline; last column does not; frozen symbol column keeps its distinct cue.
3. Component: row **hover** and **selection** remain visually distinct on both zebra states (assert the hover/selected class wins over the zebra tint).
4. Contrast: text meets §10 (≥4.5:1) on both row tints in light and dark (extend the M2 contrast harness if present).
5. Regression: existing grid e2e/component specs pass unchanged; no layout shift (cell widths/editor metrics unchanged).

## Acceptance criteria

- [ ] Body rows alternate a subtle background; the phantom row stays distinct.
- [ ] Every column is separated by a `--hairline` vertical rule (header + body), all consumers, both themes.
- [ ] Row hover + selection remain clearly distinguishable over the zebra; text contrast ≥4.5:1 on every tint.
- [ ] Frozen symbol column stays visually distinct; no layout shift.
- [ ] STYLE_GUIDE §6 amended (zebra + vertical hairlines); `npm run verify` green.

## Implementation notes

- `base.css`: `.editable-grid tbody tr:nth-child(even)` (or an explicit data-row index, since the phantom row is a real `<tr>` — key off a class rather than raw `:nth-child` so the phantom/selection don't get mis-striped) gets a surface-tinted background token; add `border-right: 1px solid var(--hairline)` to `.editable-grid th`/`td` with the trailing column exempt. Token-only (stylelint `declaration-strict-value`); may need a new `--row-zebra` surface token in `tokens.css` (both themes) rather than reusing `--paper` if contrast requires.
- Ordering of tints: selection > hover > zebra (later/more-specific rules win) — verify the cascade so a selected even row still reads as selected.
- Confirm interaction with the frozen `.grid-col--symbol` treatment (issue 005): `border-collapse: separate` is kept; ensure zebra background applies to the frozen cell too so a striped row is continuous across the freeze.
- Update STYLE_GUIDE §6: replace the "rows are quiet / hairline row separators only / no vertical rules" bullets with the amended rule (subtle zebra rows + faint vertical hairline between all columns; frozen column one step stronger; hover/selection still win).
