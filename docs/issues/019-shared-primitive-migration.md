# 019: Shared UI primitives + component migration

- **Status**: OPEN
- **Milestone**: M1 (foundation / pre-work)
- **Blocked by**: 018

## Slice

As a contributor I compose UI from a small set of owned primitives in `src/components/ui/`, so behaviour (keyboard grammar, focus, a11y) is defined once and reused. This issue introduces the primitives and migrates the four existing components onto them — deleting the duplicated hand-rolled code the audit found.

## Scope (phased — one commit per sub-phase)

**19a — primitives + the duplication kill**
- `ui/button.tsx` (cva variants: `default`/`ghost`/`row-action`, mapped to existing chrome), `ui/input.tsx`.
- `ui/inline-editor.tsx` — the single home for the Enter-commits / Esc-reverts / blur-cancels / `autoFocus`+select grammar currently duplicated in `ProjectsList`, `ParameterList`, `DimensionManager`, and `EditableGrid`. Props: `value`, `onCommit`, `onCancel`, `mono?`, `validate?`, `stopPropagation?` (DimensionManager needs it), plus an `escapeGuard` seam for the popover Esc-order rule.
- Migrate `ProjectsList` + `ParameterList`.

**19b — remaining call sites**
- Migrate `DimensionManager` (rename input) + `EditableGrid` (`TextOrMonoCell`) to `InlineEditor`.

**19c — overlay primitives**
- `ui/popover.tsx` (wraps `@radix-ui/react-popover`, bakes in `sideOffset`, the `.popover` styling, and the SITEMAP §4 Esc-order guard).
- `ui/command.tsx` + `ui/combobox.tsx` (wraps `cmdk`; the EditableGrid combobox cell reuses it).
- `ui/swatch.tsx` (the palette button + hex-entry picker from `DimensionManager.SwatchPicker`).
- Migrate `DimensionManager` popover + `SwatchPicker` and `EditableGrid`'s combobox cell.

## Design brief

- **Primitives are thin.** Each wraps the headless lib the project already uses (Radix Popover, cmdk, native input) + `cn()` + token-driven classes. No new visual language — pixel parity with today, verified per sub-phase.
- **`InlineEditor` owns the grammar, callers own the data.** Same contract as `EditableGrid` cells (caller supplies `value`/`onCommit`). Preserves every existing behaviour: `stopPropagation` on keydown (DimensionManager), the `#RRGGBB` validation (SwatchPicker hex), refocus-after-commit (phantom rows).
- **Data-colour stays inline.** Swatch backgrounds are user data (`style={{ background }}`) — sanctioned by STYLE_GUIDE principle 3, unchanged.
- **Escape order preserved** (SITEMAP §4): editor closes on first Esc, popover on second. The guard moves from ad-hoc `onEscapeKeyDown` in `DimensionManager` into `ui/popover.tsx` + `ui/inline-editor.tsx` so it is correct by construction everywhere.

**References**: audit 2026-07-05 · STYLE_GUIDE §4, §9, §10 · SITEMAP §4 (Esc order) · issue 004 (EditableGrid cell contract) · issue 002 (DimensionManager)

## Test-first plan

1. Component: `InlineEditor` — Enter commits trimmed non-empty value & calls `onCommit`; Esc calls `onCancel` without commit; blur cancels; `validate` blocks commit on invalid.
2. The **existing** component + e2e suites (ProjectsList, ParameterList, DimensionManager, EditableGrid, ContextRegister) must pass **unchanged in behaviour** after each migration — they are the regression net. Update only selectors/markup assertions that legitimately changed, never behaviour.
3. Component: `Popover`/`Combobox`/`Swatch` render and keyboard-navigate as the inlined versions did (reuse the jsdom polyfills from `src/test/setup.ts`).
4. Screenshot diff per sub-phase (light + dark): zero visual delta.

## Acceptance criteria

- [ ] The `inplace-input` Enter/Esc/blur logic exists in exactly **one** place (`ui/inline-editor.tsx`); the 4 former copies are gone.
- [ ] `EditableGrid` and `ContextRegister` behave identically (issue 004 acceptance still holds); tier tables (013/014) can still reuse `EditableGrid` unchanged.
- [ ] No raw `@radix-ui/*` or `cmdk` import remains outside `src/components/ui/` (this becomes lint-enforced in 020).
- [ ] `npm run verify` green after every sub-phase; pixel parity in both themes.
