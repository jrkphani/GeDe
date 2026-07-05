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

## Test-first plan

1. Unit: selection selector yields the same context to both projections; selecting a draft yields partial tuple readout with placeholders.
2. Component: canvas — click node → spokes appear with dimension colors; Esc clears selection; arrow keys cycle contexts deterministically (layout order).
3. Component: register row highlight follows canvas selection and vice versa.
4. e2e: select α on canvas → composer shows tuple + justification → edit justification in composer → register cell shows the new text.

## Acceptance criteria

- [ ] Selection is one store field; neither projection owns it.
- [ ] Keyboard-only selection and composer editing work end-to-end.
- [ ] `prefers-reduced-motion` disables spoke animation (assert class/attribute in component test).
