# 065: Project list — unclear clickable affordance + open-vs-edit ambiguity

- **Status**: SHIPPED
- **Milestone**: M6 (UX polish)
- **Severity**: Medium (usability) — new users can't tell rows are interactive, or where to click to *open* vs. *rename*.
- **Requested by**: product owner, 2026-07-10 (with screenshot): "hard to tell which project can be clicked on and where to click to edit and where to click to access the project… think about solution options apart from just mouseover highlight, but keep things simple."

## Symptom

The project list (`src/components/ProjectsList.tsx`) renders each project as plain bold text with a hairline separator (see screenshot: "Acceptance test / Testing / Tavalo / New project"). There's **no hover state, no cursor affordance, and no visible control**, so:
1. Rows don't *read* as clickable.
2. The two actions — **open** the project vs. **rename** it — have no distinct, discoverable targets.

Worse, today's interaction is **counter-intuitive**: clicking a project name starts an **inline rename** (issue 001/015 behavior: "click name, edit, Enter commits"), while **opening** requires Enter on the focused row. So the most obvious gesture (click the name) does the *less* expected thing (edit, not open).

## Goal

Make it obvious that rows are interactive and give **open** and **rename** clearly separated, discoverable targets — keeping the UI calm and simple (STYLE_GUIDE), not adding button clutter.

## Solution options (keep simple; recommended = A)

**A. Row-opens + hover affordance + hover-revealed rename (recommended).**
- Whole row is the primary **open** target: `cursor: pointer`, a calm **hover/focus background** (design token, e.g. a subtle surface tint) + optional trailing **"open" chevron** (`›`) so it reads as "go here". Keyboard: Enter/Space opens; row is focusable.
- **Rename** becomes a secondary, discoverable control: a **hover/focus-revealed pencil (edit) icon** at the row's trailing edge (and/or double-click / F2 on the row). Clicking it enters the existing inline-rename. This inverts today's default (click = open, explicit action = rename) to match user expectation.
- The phantom **"New project"** row stays visually distinct (muted, already the case) — typing there still creates.

**B. Split targets, no hover reveal.** Name text = open; a persistent small trailing edit icon = rename. Simpler discoverability than hover-reveal, slightly busier visually.

**C. Overflow menu (`⋯`).** Row opens; a trailing `⋯` menu holds Rename/Archive/Export. Cleanest row, but rename is one click less discoverable — good if the row gains several actions later.

Recommend **A** now (smallest change, fixes both complaints, stays calm); C is the natural evolution if per-row actions grow.

## Scope / files

- `src/components/ProjectsList.tsx` — row interaction model (open on row click/Enter/Space; rename via revealed control/double-click), affordances, focus order.
- CSS/tokens — hover/focus background + pointer + chevron/icon, all via STYLE_GUIDE design tokens (no hardcoded colors, lint-enforced); use `src/components/ui/` primitives / existing icons, no raw `<button>`.
- Preserve existing behaviors: inline rename commit/revert (Enter/Esc), phantom-row create, archive + Undo, drag/drop import panel.

## Test-first plan

- Row has an accessible **open** affordance: clicking a project row (not the rename control) **opens** it (navigates), and Enter/Space on the focused row opens it. (Red first — today click renames.)
- The **rename** control is reachable (hover/focus-revealed or double-click) and enters inline edit; Enter commits, Esc reverts (existing behavior preserved).
- Hover/focus applies the highlight class (assert the class/state, since jsdom has no real `:hover`); `cursor: pointer` present.
- Phantom "New project" row still creates on type; archive+Undo unaffected.
- A11y: rows are focusable with a clear name; the rename control has an accessible label; no raw button/input primitives.

## Dependencies / ordering

Independent of the sharing/auth threads (062/063/064). Touches only `ProjectsList` + its styles.

**References**: 001 (projects CRUD + inline rename — the behavior this reworks), 015 (export/import panel in the same list), STYLE_GUIDE §hover/interactive states + tokens, 019/020 (UI primitives + no-hardcoded-color enforcement), 024/026 (prior list/affordance polish for consistency).
