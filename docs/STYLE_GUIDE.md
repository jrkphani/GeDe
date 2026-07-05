# GeDe — Style Guide

## v0.1 · 2026-07-05 · companion to SPEC.md v0.2

Design north star: the app should feel like the source Numbers document — a calm, typographic, table-first design surface — with the canvas as its one expressive visual. Prototypes are dark-first; both themes ship (SPEC §4.7).

---

## 1. Principles

1. **Document, not dashboard.** Surfaces read like a well-set document: generous whitespace, few borders, hierarchy through type and spacing rather than boxes.
2. **In-place, always.** No modals or side-forms for data entry. Cells edit where they are; the composer is a bar, not a dialog.
3. **Color is data.** Chromatic color belongs to dimensions and their arcs/spokes only. Chrome stays neutral. Never reuse a dimension color for UI states.
4. **Position is derived.** Nothing on the canvas is draggable-to-mean-something. Selection, not arrangement, is the user's spatial verb.

## 2. Color

- **Dimension palette** (assigned in dimension sort order, user-overridable): `#7C6FDE` purple · `#1E9E6A` green · `#D9542B` orange · then 5 more categorical slots to seed n ≤ 8 (final values validated for contrast in both themes at M2).
- **Neutrals**: near-black ink on paper-white (light); warm off-white on `#1A1A1A` (dark). Greek context nodes are always the ink color at high contrast (per prototypes: black chip, white symbol).
- States: documented = filled dot; unexplored = hollow; draft context = dashed ring.

## 3. Typography

- Single sans family (system stack or Inter). Weight and size carry hierarchy: tier/section headers, table column heads (small caps or muted), cell text, canvas labels (muted gray, never bolder than data).
- Ranks and degree notation render as in the source document: `1°`, `2°`, `Zero°`, `p₃ₓ` — superscripts/subscripts preserved.

## 4. Tables (Numbers grammar)

- Row hover reveals affordances (drag handle, add-child); otherwise rows are quiet.
- Click or Enter begins editing in place — borderless input, same metrics as the display text (no layout shift). Enter commits + moves down; Tab moves right; Esc reverts.
- New row = start typing in the phantom row at the bottom of a group.
- Nested rows indent by one level-width; no tree lines.
- Validation is inline and non-blocking: duplicate-tuple warnings appear as a muted badge, never a popup.

## 5. Canvas

- Arcs are thick, rounded strokes with gaps between dimensions; parameter dots sit on the arc; labels outside the circle.
- Selected context: n colored spokes + composer bar populated; unselected contexts dim slightly.
- Drill-down (breadcrumb push) animates a zoom-into-node transition when motion is allowed; instant otherwise. `prefers-reduced-motion` respected everywhere.

### Canvas responsiveness

Geometry is scale-free: layout computes in a fixed 1000×1000 abstract space and the SVG `viewBox` scales it uniformly to any container. Responsiveness is governed by these rules, driven by **container queries** (the canvas shares a row with the register, so viewport media queries are the wrong signal):

| Container width | Labels | Chrome |
| --- | --- | --- |
| ≥ 640px | Full external labels | Register beside canvas; composer bar below canvas |
| 400–640px | Truncated labels + tooltip on hover/focus | Register stacks below canvas (SPEC §4.1 toggle) |
| < 400px | Labels off; legend chips + tap-to-reveal | Canvas capped at `min(100%, 60vh)`; read-mostly |

- The circle always renders 1:1 (a squashed circle is never acceptable); the square viewport is `min(container width, available height)` and the container centers it.
- **Touch targets**: every parameter dot and context node carries an invisible hit circle ≥ 44px at rendered scale, independent of visual radius.
- Label collision at any size: labels shrink one step, then truncate, then drop to legend — deterministic, no jiggling.
- High n (> 8 dimensions): arcs compress, labels go legend-only — functional but explicitly outside the optimized range (ADR-0002).

## 6. Motion

- CSS transitions only, 150–250ms, ease-out; one thing moves at a time.
- Reserved for: selection spokes drawing in, drill-down zoom, row insertion. Never on data commit (commits must feel instant).

## 7. Voice

- UI copy is quiet and specific: "12 / 45 tuples documented", "α2 needs 1 more binding". No exclamation marks, no anthropomorphism.
