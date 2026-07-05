# 010: Create and bind contexts from the canvas

- **Status**: SHIPPED
- **Milestone**: M2
- **Blocked by**: 009

## Slice

As a designer I create a context directly on the canvas: enter compose mode, click one parameter dot per arc (or type ahead), watch spokes attach, justify, done.

## Scope

- Compose mode: new draft context at circle center; clicking a parameter dot binds that dimension (click a bound dot to unbind); node migrates toward its centroid as bindings accumulate.
- Keyboard path: arrows move between dimensions, type-ahead picks parameters (same picker logic as register combobox — shared code).
- Duplicate-tuple badge appears live in compose mode (slice 005 logic).
- Composer bar in edit mode hosts justification before/after completion.

## Design brief

- **Entering compose**: toolbar "New context" or the `c` key; a draft node (dashed ring, next symbol pre-assigned) appears at circle center; the composer bar switches to edit mode with the active dimension highlighted.
- **Guided binding**: dimensions are prompted in sort order — the active dimension's arc labels render at full strength while others rest; clicking a dot (or type-ahead in the composer) binds and advances to the next unbound dimension. The node migrates toward its centroid after each bind (single 120ms ease-out).
- **Bind/unbind affordance**: bound dots show a filled ring; clicking a bound dot unbinds (read mode clicks only ever select — mode gates mutation).
- **Duplicate preview**: the `= β` badge appears live in the composer the moment the pending tuple matches an existing one — before commit, never blocking.
- **Exit paths**: Esc leaves compose mode keeping the draft (drafts are legal); the status line offers "Discard draft α" as one undoable action. No confirmation dialogs.
- **Touch**: dots rely on the ≥ 44px invisible hit circles; compose on < 400px containers falls back to the composer bar's pickers (canvas is read-mostly at that tier).
- **Haptics**: none — PWA scope, no reliable web haptics API; feedback is visual + instant.

**References**: SPEC §4.2, §4.4, invariants 1–2 · SITEMAP §4 (`c` global key, Esc order) · STYLE_GUIDE §7 (touch, responsiveness), §8 · issues 005 (badge), 006 (undo batching)

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Unit: compose-mode reducer — bind/unbind/re-bind transitions; completion event fires exactly when the nth dimension binds.
2. Component: dot click binds only in compose/edit mode (read mode clicks select, never mutate).
3. Component: hit targets — dots respond within the ≥ 44px invisible hit circle (STYLE_GUIDE § Canvas responsiveness).
4. e2e: recreate prototype image 1 purely on canvas: compose α, bind Comfort/Users/Engagement, justify — then assert the register row matches (mirrors SPEC §6 M2 done-when).

## Acceptance criteria

- [x] Canvas-created and register-created contexts are indistinguishable in the store (same mutation layer).
- [x] Compose mode is fully keyboard-operable.
- [x] Undo treats compose-and-bind as sensible steps (each bind = one step; consistent with slice 006 batching rules).

## Shipped notes

- **Pure reducer** (`src/domain/composeMode.ts`): store-free guided-compose state machine (bind/unbind/re-bind, next-unbound pointer, a `completed` event that fires exactly on the tuple-finishing bind). `firstUnbound()` exported so `DesignSurface` derives the displayed active dimension straight from the live generation-guarded store bindings — race-free under rapid clicks (a real bug caught only in the browser: deriving the active pointer from settling store state left a picker stuck "active").
- **Shared picker** (`src/components/ui/combobox.tsx`): the register grid cell and the composer's per-dimension pickers now use one primitive (Popover + cmdk, incl. the "— clear —" item), so "same picker logic" is met by sharing, not forking. `EditableGrid`'s combobox cell was refactored onto it; `ComboboxOption` re-exported from EditableGrid for existing callers. Register e2e still green.
- **Canvas** (`src/components/Canvas.tsx`): interactive dots with ≥44px invisible hit circles (`dotHitRadiusUnits()` maps 44px into viewBox units from measured width), bound-dot affordance, active-dimension highlight, transform-based node migration to centroid (`--motion-migrate: 120ms`). Stays presentational; compose state lives in `DesignSurface`.
- **Composer** (`src/components/Composer.tsx`): edit mode adds n pickers + live `= β` duplicate badge (slice 005 logic); read mode untouched.
- **Orchestration** (`src/components/DesignSurface.tsx`): `c` global key (capture-phase, editable-guarded per the 006 gotcha); compose-scoped Esc checks the DOM synchronously for an open picker popover and defers to Radix that press (the 009 Esc-ordering gotcha, not a listener race). `contexts.ts` gained `discard()` — one undoable archive backing the "Discard draft α" status offer. Selection field (`selectedContextId`/`select`) untouched → clean seam for 017.
- **Known UX choice**: "New context" is disabled while composing (start a second context by exiting compose first). Flagged for review if commit-and-restart is preferred instead.
- **Verified**: full `npm run verify` green on main (unit/component + e2e incl. `e2e/canvas-compose.spec.ts` recreating the M2 done-when flow). Manual chromium screenshots confirmed compose enter / spoke attach / migration / live duplicate badge.
