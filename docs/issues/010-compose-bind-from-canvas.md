# 010: Create and bind contexts from the canvas

- **Status**: OPEN
- **Milestone**: M2
- **Blocked by**: 009

## Slice

As a designer I create a context directly on the canvas: enter compose mode, click one parameter dot per arc (or type ahead), watch spokes attach, justify, done.

## Scope

- Compose mode: new draft context at circle center; clicking a parameter dot binds that dimension (click a bound dot to unbind); node migrates toward its centroid as bindings accumulate.
- Keyboard path: arrows move between dimensions, type-ahead picks parameters (same picker logic as register combobox — shared code).
- Duplicate-tuple badge appears live in compose mode (slice 005 logic).
- Composer bar in edit mode hosts justification before/after completion.

## Test-first plan

1. Unit: compose-mode reducer — bind/unbind/re-bind transitions; completion event fires exactly when the nth dimension binds.
2. Component: dot click binds only in compose/edit mode (read mode clicks select, never mutate).
3. Component: hit targets — dots respond within the ≥ 44px invisible hit circle (STYLE_GUIDE § Canvas responsiveness).
4. e2e: recreate prototype image 1 purely on canvas: compose α, bind Comfort/Users/Engagement, justify — then assert the register row matches (mirrors SPEC §6 M2 done-when).

## Acceptance criteria

- [ ] Canvas-created and register-created contexts are indistinguishable in the store (same mutation layer).
- [ ] Compose mode is fully keyboard-operable.
- [ ] Undo treats compose-and-bind as sensible steps (each bind = one step; consistent with slice 006 batching rules).
