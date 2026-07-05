# 009: Canvas selection, spokes, composer bar, register sync

- **Status**: OPEN
- **Milestone**: M2
- **Blocked by**: 008

## Slice

As a designer I click a context on the canvas and see its n colored spokes, its tuple, and its justification in the composer bar — and the same row highlights in the register. One selection, two projections (SPEC invariant 6).

## Scope

- Selection state in the store (shared, UI-agnostic); canvas click/keyboard focus and register row click both set it.
- Spokes render for the selected context only; unselected contexts dim (STYLE_GUIDE §5).
- Composer bar (read mode): per-dimension legend, tuple readout `{…} {…} {…}` in dimension order, justification text.
- Justification editable in place from the composer bar (same commit grammar as cells).

## Design brief

- **Selection vocabulary**: selected node gets the accent ring + its n spokes in dimension colors; all other contexts dim to 40%; the register row takes the accent wash + 2px left rule. One selection, everywhere, from one store field.
- **Spokes**: appear within 100ms (opacity fade, no draw-on choreography — snappy over elegant); `prefers-reduced-motion` makes it instant.
- **Composer bar**: full-width panel under the canvas, hairline top border: per-dimension swatch+parameter legend, mono tuple readout in dimension order, justification text editable in place with the standard grammar. Drafts render placeholders (`—`) for unbound dimensions.
- **Hover (desktop)**: nodes get a subtle ink halo + cursor pointer; hover never selects.
- **Keyboard**: canvas is a focusable widget — arrows cycle contexts in deterministic layout order, Enter opens drill-down (later), Esc clears selection. Focus ring per token.
- **A11y**: each node is a button named by its content: "α — Comfort, Users, Engagement, draft". Selection changes announce via the same polite live region as undo.
- **Sync rule**: selecting in either projection scrolls the other to reveal (register scrolls row into view; canvas selection never pans the page).

**References**: SPEC §4.2–4.4, invariant 6 · SITEMAP §2 (Design surface + composer slot), §4 (Esc order, globals not shadowed) · STYLE_GUIDE §2.2, §7, §8, §10 · ADR-0001

## Test-first plan

1. Unit: selection selector yields the same context to both projections; selecting a draft yields partial tuple readout with placeholders.
2. Component: canvas — click node → spokes appear with dimension colors; Esc clears selection; arrow keys cycle contexts deterministically (layout order).
3. Component: register row highlight follows canvas selection and vice versa.
4. e2e: select α on canvas → composer shows tuple + justification → edit justification in composer → register cell shows the new text.

## Acceptance criteria

- [ ] Selection is one store field; neither projection owns it.
- [ ] Keyboard-only selection and composer editing work end-to-end.
- [ ] `prefers-reduced-motion` disables spoke animation (assert class/attribute in component test).
