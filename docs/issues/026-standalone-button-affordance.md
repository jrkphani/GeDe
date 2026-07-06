# 026: Standalone buttons (no background fill) are hard to spot

- **Status**: OPEN
- **Milestone**: M6 (Polish / a11y)
- **Blocked by**: 019 (SHIPPED)

## Slice

As any user I can **see the buttons**. Standalone command buttons (e.g. "Import project", "Use as dimension…") have a resting affordance — enough contrast to read as clickable at rest — instead of only becoming visible on hover.

## Bug report (from user testing)

> "All buttons of this nature with no background fill are really difficult to spot."

Confirmed in `src/components/ui/button.tsx` + `base.css`. The default button variant (`rowAction`) maps to `.row-action`:

```css
.row-action { color: var(--ink-muted); background: transparent; border: 1px solid var(--hairline); }
.row-action:hover { color: var(--ink); }        /* contrast only arrives on hover */
.row-action { visibility: hidden; }              /* hidden until row hover/focus-within in tables */
```

Root cause: `.row-action` is designed for **hover-revealed row affordances** — quiet by intent, and literally `visibility: hidden` until the row is hovered (progressive disclosure, STYLE_GUIDE §6). But **standalone command buttons reuse the same class/variant**, so a primary always-on action like "Import project" renders as muted `--ink-muted` text with a `--hairline` border and no fill — against the graph-paper ground it is nearly invisible until hovered. This also risks failing STYLE_GUIDE §10's "UI glyphs ≥ 3:1" resting contrast.

## Scope

- Give **standalone command buttons** a resting affordance distinct from hover-revealed row actions: readable text contrast and a visible boundary or subtle fill at rest (not only on hover).
- Introduce this as a proper Button **variant** (the primitive already uses `cva`) so callers opt in explicitly, rather than overloading `rowAction`.
- Audit and reassign existing standalone buttons currently using the quiet `rowAction`/`.row-action` chrome (project menu actions "Export…/Import…", "Use as dimension…", any always-visible toolbar verbs).

Out of scope: the hover-revealed **row** actions inside tables (drag handle, add-child, per-row delete) — those *should* stay quiet/progressive (STYLE_GUIDE §6); this issue is about buttons that are always on screen. Also out of scope: the `danger` variant (already has fill) and icon-only affordances.

## Design brief

- **Two clearly different button intents**:
  - *Row action* (unchanged): quiet, hover/focus-revealed, transparent — the table progressive-disclosure affordance.
  - *Command button* (new/adjusted): a resting affordance — e.g. a filled wash (`--paper`/surface tint) **or** a firmer border + `--ink` (not `--ink-muted`) text, so it reads as clickable at rest. Keep radius `0` (STYLE_GUIDE §4) and token-driven colors only (no hardcoded values, ADR-0007/§11).
- **Contrast**: resting state must meet STYLE_GUIDE §10 (text ≥4.5:1, UI boundary ≥3:1) in **both** themes (light canonical, dark verified — STYLE_GUIDE §2).
- **Hierarchy without new colors** (STYLE_GUIDE §3/§2.2 "hierarchy from weight and spacing, never additional colors"): the accent stays reserved for chrome/selection; a command button's affordance comes from fill/weight/border, not a new hue. A true primary (e.g. the one accent CTA) may use the accent per §2.2 — decide the primary/secondary split in the design brief.
- **Focus** unchanged: `2px --accent` on `:focus-visible` (STYLE_GUIDE §4).

**References**: STYLE_GUIDE §2.2 (Ink & chrome), §4 (space, shape, elevation), §3 (hierarchy from weight/spacing), §6 (row progressive disclosure — the pattern being disentangled from), §10 (contrast ≥4.5:1 / ≥3:1) · issue 019 (Button primitive / `cva` variants) · ADR-0007 / §11 (token + Tailwind-bridge enforcement)

> This adjusts a button treatment defined in STYLE_GUIDE §2.2/§6. Because it changes the resting appearance of a design-system component, the exact resting style (subtle fill vs. firmer border, primary vs. secondary split) should be **agreed as a small STYLE_GUIDE amendment** before implementing — it is a design decision, not a free implementation choice.

## Test-first plan

1. Component (`button.test.tsx`): the new command-button variant renders with a resting affordance (assert the resting class / computed non-transparent boundary or fill), distinct from `rowAction`.
2. Visual/contrast: a snapshot or token-contrast assertion that the command button's resting text/boundary meets §10 thresholds in light and dark (extend the existing M2 contrast test harness if present).
3. Audit test/lint: no always-visible standalone button still uses the `rowAction`/`.row-action` quiet chrome (grep-guard or a component-level assertion for the known standalone buttons).
4. Regression: hover-revealed row actions remain `visibility: hidden` at rest (unchanged).

## Acceptance criteria

- [ ] Standalone command buttons are legibly clickable **at rest** (not only on hover), meeting STYLE_GUIDE §10 contrast in both themes.
- [ ] A distinct Button variant expresses "command button" vs. quiet "row action"; existing standalone buttons are reassigned to it.
- [ ] Table row-hover affordances are unchanged.
- [ ] STYLE_GUIDE §2.2/§6 amended to document the two button intents; `npm run verify` green.

## Implementation notes

- `button.tsx`: add a `command` (or `secondary`) variant to `buttonVariants` (cva) with its own class; keep `rowAction` for progressive-disclosure row affordances and `danger` as-is.
- `base.css`: new class for the command variant — resting `background`/`border`/`color` from tokens (`--paper`/surface + `--ink` + a firmer border), hover deepens rather than *introduces* contrast. Do **not** touch `.row-action`'s `visibility: hidden` (it's correct for rows).
- Reassign callers: project menu "Export…/Import…", "Use as dimension…" (`t2-promote-trigger` is accent text — decide if it stays a text action or becomes a command button), and any always-on toolbar verbs.
- Lint stays green: colors via tokens/Tailwind bridge only (no hardcoded hex — stylelint `declaration-strict-value`).
