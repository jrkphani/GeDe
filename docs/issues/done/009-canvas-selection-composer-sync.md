# 009: Canvas selection, spokes, composer bar, register sync

- **Status**: SHIPPED
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

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Unit: selection selector yields the same context to both projections; selecting a draft yields partial tuple readout with placeholders.
2. Component: canvas — click node → spokes appear with dimension colors; Esc clears selection; arrow keys cycle contexts deterministically (layout order).
3. Component: register row highlight follows canvas selection and vice versa.
4. e2e: select α on canvas → composer shows tuple + justification → edit justification in composer → register cell shows the new text.

## Acceptance criteria

- [x] Selection is one store field; neither projection owns it.
- [x] Keyboard-only selection and composer editing work end-to-end.
- [x] `prefers-reduced-motion` disables spoke animation (assert class/attribute in component test).

## Shipped notes

- **Selection**: `selectedContextId`/`select()` on `useContextsStore` (mirrors `dimensions.ts`'s `editingId` pattern), reset on project switch. `Canvas` stays fully presentational (props in, zero store imports, as shipped in 008) — `selectedContextId`/`onSelect` are just two more props, so its existing plain-prop test suite kept working unchanged. `ContextRegister` reads the field directly from its already-imported `useContextsStore` (its established pattern since 004/005) rather than being converted to props.
- **New shared primitive**: `src/components/ui/multiline-editor.tsx`'s `MultilineEdit` — the auto-grow textarea grammar extracted from `EditableGrid.tsx`'s grid-nav-coupled `MultilineCell`, minus the grid-navigation parts. Unlike `InlineEdit`, it commits an emptied value (justification is nullable/clearable). `EditableGrid.tsx` itself is untouched; its exemption from the shared-primitive rule stands.
- **Spokes**: computed in `Canvas.tsx` from already-computed geometry (selected node position → each bound dimension's dot position), not in the pure `layout()` — one line per *bound* dimension only, since an unbound dimension has no dot to point to (a necessary reading of the design brief's literal "n spokes" for a draft context).
- **Reduced motion**: a spoke's resting `opacity` is `1` (the correct final state); a `canvas-spoke-in` keyframe animation only dips it to 0 at mount and eases back up. This was deliberately not built the "obvious" way (`opacity: 0` + `animation-fill-mode: forwards`) — that shape breaks under this repo's existing blanket `prefers-reduced-motion` rule (`animation: none !important`), which would strand the spoke at its un-animated resting opacity: 0, invisible forever for reduced-motion users. Caught before shipping, not after.
- **Keyboard model**: nodes get a roving `tabIndex` (selected node = 0, else −1, defaulting to the first node when nothing is selected). Arrow keys move both DOM focus and selection through `geometry.nodes` order (already `layout()`'s deterministic order — no new sort). Escape-clears-selection is wired locally on each node (bubble-phase), which is correct for the primary flow (arrow/click into a node, then Escape) but has a real, deliberately-accepted gap: once focus leaves the canvas entirely (e.g. after committing a composer justification edit), a bare Escape press no longer reaches any node's handler. A `document`-level global listener was considered and rejected — its registration-order relative to a *dynamically opened* Radix popover's own Escape handler isn't guaranteed, risking the wrong "close popover vs. clear selection" precedence (SITEMAP §4) in a way that's worse than the narrow gap it would fix. Instead, clicking the canvas background (the `<svg>` itself, guarded by `e.target === e.currentTarget` so it doesn't fire redundantly when a node-click bubbles) clears the selection — the standard "click away to deselect" pattern, with no ordering risk, verified to be the actual gap-closer via manual browser testing.
- **A11y**: `src/domain/contextDescription.ts`'s `describeContext()`/`tupleReadout()` back both the canvas node's `aria-label` and the status-bar selection announcement (`useStatusStore.announce`, already `aria-live="polite"`) from one function, so the two can't drift apart.
- **Register sync**: `EditableGrid.tsx` grew one optional prop, `onRowClick?: (row: TRow) => void`, wired to the existing `<tr>` (previously had no `onClick`). Cell-level `onClick`s don't call `stopPropagation` (only their `onKeyDown`s do, for an unrelated reason — grid arrow-key navigation), so clicking a cell to edit it and selecting its row both fire, which is the intended behavior. Selecting a context scrolls its register row into view (`scrollIntoView`, no `.focus()` — canvas-driven selection must never steal keyboard focus from the canvas).
- **Composer**: read-mode only this slice (full parameter pickers are issue 010) — presentational like `Canvas`, `DesignSurface` looks up the selected `ContextRow` and passes it down. Renders directly in `DesignSurface.tsx` below `.design-surface-row` (no composer slot exists in the shell's context bar per SITEMAP §2 — this is main-surface content, not chrome).
