# 017: Command palette (⌘K)

- **Status**: SHIPPED
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

- [x] Every SITEMAP §1 destination and every registered verb is reachable via the palette, keyboard-only.
- [x] Palette contains zero feature-specific imports (registry only).
- [x] Open-to-interactive < 100ms measured in a perf test.

## Shipped notes

- **Verb registry** (`src/store/commandRegistry.ts`) is the 016 seam: `registerProvider(() => CommandItem[]) → disposer` for dynamic lists, `registerCommand(item) → disposer` as sugar; `collect()` dedups first-id-wins so a feature can't clobber a core command; `markUsed(id)`/`recentIds` drive recent-first ordering. `CommandItem = { id, kind:'tier'|'canvas'|'context'|'action', title, symbol?, keywords?, run }`. The palette reads only this store + the pure ranking module — zero feature imports.
- **Ranking** (`src/domain/paletteRanking.ts`, pure + perf-tested): exact symbol → name → justification, recents float; empty-state copy included.
- **Palette surface** (`src/components/CommandPalette.tsx`) composes `ui/command` (added `CommandDialog`/`CommandGroup` exports so cmdk stays wrapped in `ui/`). Centered panel, mono symbols, max-8, kind labels; focus trap; Esc returns focus to the exact origin element (captured at ⌘K press), a navigation moves focus to `.surface` (rAF beats cmdk's own close-focus).
- **Shell wiring** (`src/shell/AppShell.tsx`): ⌘K joins the existing capture-phase shortcut effect; app-bar `⌘K` trigger; core sources registered on mount via `src/shell/coreCommands.ts` (tier jumps, Root canvas + Coverage, live contexts — selecting one navigates + reuses 009's `selectedContextId`). `--scrim` token added (both themes). No routes/schema change.
- **Deliberately deferred** (per orchestration guidance): feature verbs (010 compose "New context", 014 export) are NOT wired — the seam is ready for them. The empty-state "Enter creates a context…" copy shows but doesn't yet create (needs a contexts-feature verb).
- **a11y note**: `aria-activedescendant` moves across results when ≥2 match; a cmdk quirk under `shouldFilter=false` leaves it unset for a single result, but that sole option is `aria-selected="true"` (announced) and Enter-operable.
- **Verified**: full `npm run verify` green on main (276 unit/component incl. ranking/registry/a11y + perf, e2e incl. `e2e/command-palette.spec.ts`). Manual chromium screenshots confirmed open/ranking/empty-state/dark.
