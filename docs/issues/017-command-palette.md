# 017: Command palette (⌘K)

- **Status**: OPEN
- **Milestone**: M2
- **Blocked by**: 016, 004

## Slice

As a designer I press ⌘K and type to jump anywhere — tier, canvas, context — or run a verb ("New context", "Export project…"), Zed-style.

## Scope

- Palette panel per SITEMAP §3: type-ahead over tier jumps, canvases (lineage-labelled), contexts (symbol/name/justification match), and registered verbs; recent-first ordering.
- Verb registry: features register commands (016's shell exposes the API); palette stays feature-agnostic.
- Selection of a context result navigates to its canvas *and* selects it (reuses the shared selection field).

## Design brief

- **Surface**: centered panel, 0 radius, the popover shadow token, mono for symbols/tuples in results; max 8 results, no scrolling hunt.
- **Ranking is legible**: exact symbol match first (`α2`), then name, then justification text; each result row shows its kind as a muted 11px label (tier · canvas · context · action).
- **Speed**: opens < 100ms, filters per keystroke with no debounce visible at local scale.
- **Focus**: traps while open; Esc closes and returns focus to the exact origin element; executing a navigation moves focus to the target surface.
- **Empty state**: "No matches — Enter creates a context named '…'" only when the query could be a symbol/name; otherwise plain "No matches".
- **A11y**: combobox pattern (`aria-activedescendant`), results announced; fully operable with arrows + Enter.

**References**: SITEMAP §3, §4 · STYLE_GUIDE §3 (mono), §4 (shadow), §10 · issues 016 (command registry), 009 (selection field)

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Unit: ranking — symbol beats name beats justification; recents float; verbs match by prefix and synonym ("export" finds "Export project…").
2. Component: combobox a11y contract (activedescendant moves, announcements); focus return to origin on Esc.
3. Component: registry — a feature-registered verb appears without palette code changes.
4. e2e: ⌘K → type `α2` → Enter → Design tier at α's child canvas with α2 selected.

## Acceptance criteria

- [ ] Every SITEMAP §1 destination and every registered verb is reachable via the palette, keyboard-only.
- [ ] Palette contains zero feature-specific imports (registry only).
- [ ] Open-to-interactive < 100ms measured in a perf test.
