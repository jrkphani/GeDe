# ADR-0007: shadcn/ui + Tailwind v4 as the UI primitive layer

- **Status**: Accepted
- **Date**: 2026-07-05

## Context

Through issues 001–016 every component hand-rolled its own primitives: the same in-place editor (Enter/Esc/blur grammar) was re-implemented four times; buttons were raw `<button className="row-action">` throughout; there was no shared `src/components/ui/` layer and nothing stopped the next contributor (human or agent) from rolling another. An audit (2026-07-05) confirmed the pattern but also found the foundations strong: design-token discipline was ~100% (zero hardcoded colors), TypeScript was `strict` + `noUncheckedIndexedAccess`, and the complex primitives already sat on the right headless libraries (Radix Popover, cmdk, TanStack Table).

We wanted an owned, consistent primitive layer and mechanical enforcement of type-safety, token usage, and component usage going forward.

## Decision

Adopt **shadcn/ui's model** — own the primitive code in `src/components/ui/`, composed over headless libs, with `cn`/`cva`/`forwardRef` — on **Tailwind v4**. Tailwind v4 is CSS-variable-native, so `tokens.css` (STYLE_GUIDE §2–§4) stays the single source of truth: `theme-bridge.css` maps shadcn's semantic names onto GeDe tokens **one-directionally** (`--color-primary: var(--accent)`, `--radius: 0`, dark via `[data-theme='dark']`). No parallel styling system, no token rewrite.

Primitives **reuse the existing cascade-connected CSS classes** (`.row-action`, `.inplace-input`) rather than re-styling with utilities — those classes carry contextual rules (hover-reveal actions, per-context input metrics) that utilities can't replicate without migrating every override. The primitives own the *behavior* (the actual duplication); Tailwind is available for new styling.

`EditableGrid` (ADR-0004) is treated as a first-class grid primitive that owns its own cells — not migrated to the shared inline editors, since its cell grammar differs (blur commits, Enter moves down a row, nav-integrated).

Enforcement (issue 020): type-aware ESLint (`strictTypeChecked`), stricter tsconfig, `no-restricted-syntax`/`no-restricted-imports` forbidding raw `<button>`/`<input>` and raw `@radix-ui`/`cmdk` outside `ui/`, stylelint forcing `var(--…)` colors, and a husky/CI `verify` gate.

## Consequences

- One home for each primitive (`Button`, `InlineEdit`, `PhantomInput`, `Popover`, `Command`, `Swatch`, `Input`); the 3 duplicated editors collapsed to one. New UI must go through `ui/` or it fails lint.
- Pixel parity preserved through the migration (verified by screenshot + the unchanged component/e2e suites) — the only intended visual change was the empty context bar correctly collapsing (a pre-existing bug preflight surfaced).
- Tailwind utilities are available but **not** required; existing distinctive chrome stays in `base.css`. A future "utility restyle" pass, if the canonical shadcn look is ever wanted, is a separate scoped effort.
- react-hooks is limited to the classic `rules-of-hooks` + `exhaustive-deps`; the v7 compiler rules were rejected (false positives on TanStack Table and the guided-start state machine).
