# 018: shadcn/ui + Tailwind v4 foundation

- **Status**: SHIPPED
- **Milestone**: M1 (foundation / pre-work)
- **Blocked by**: —

## Slice

As a contributor (human or agent) I have a shared UI primitive layer to build on, so I never hand-roll a button, input, or popover again. This issue lays the mechanical foundation — Tailwind v4 wired to the existing design tokens, plus the shadcn `cn()`/`components.json` scaffolding — **without changing a single component**. The app must render pixel-identically before and after.

## Why (context)

Audit finding: primitives are hand-rolled and duplicated (the same in-place editor is re-implemented 4×; buttons are raw `<button className="row-action">` everywhere; there is no `src/components/ui/`). We are adopting shadcn/ui to own a consistent primitive layer. shadcn requires Tailwind — but Tailwind **v4** is CSS-variable-native, so `tokens.css` stays the single source of truth and Tailwind reads *from* it via `@theme`. STYLE_GUIDE is not rewritten; it gains a mapping.

## Scope

- Add deps: `tailwindcss@4`, `@tailwindcss/vite`, `clsx`, `tailwind-merge`, `class-variance-authority`, `tw-animate-css`, `lucide-react`.
- `@tailwindcss/vite` plugin in `vite.config.ts`.
- `src/styles/theme-bridge.css`: `@import "tailwindcss"`, `@custom-variant dark` bound to `[data-theme='dark']` (project convention, **not** `.dark`), and an `@theme inline` block aliasing shadcn semantic colors to GeDe tokens (`--color-primary: var(--accent)`, `--color-background: var(--paper)`, `--radius: 0px`, etc.). Imported in `main.tsx` **after** `tokens.css`, **before** `base.css`.
- `src/lib/utils.ts` exporting `cn()` (clsx + tailwind-merge).
- `components.json` (shadcn config: style, CSS path, `@/*` alias, RSC false).
- `@/*` path alias in `tsconfig.json` **and** `vite.config.ts` resolve.

## Design brief

- **No visual change.** This is the acceptance bar. The `@theme` bridge exists so that when primitives arrive in 019 they inherit GeDe tokens automatically; nothing consumes Tailwind utilities yet.
- **Token bridge is one-directional**: Tailwind aliases point at GeDe vars, never the reverse. `tokens.css` and STYLE_GUIDE remain authoritative. `--radius: 0px` preserves STYLE_GUIDE §4 "everything square." Dark mode inherits for free because every alias resolves through a token that already flips under `[data-theme='dark']`.
- **Preflight risk** (the real work here): Tailwind's preflight resets `button`/`input`/margins app-wide and `base.css` assumes some browser defaults. Screenshot-diff every route (light + dark) and fix any `base.css` regressions in this issue so 019 starts from a clean baseline.

**References**: STYLE_GUIDE §2–§4 (tokens) · TECH_STACK (stack decisions) · ADR-0007 (this decision, added in issue 020/Phase 4) · audit 2026-07-05

## Test-first plan

1. `npm run verify` stays green (typecheck → lint → vitest → playwright) with only the config/dep additions.
2. Manual: `npm run dev`, screenshot each route in light + dark; diff against a pre-change baseline captured before installing. Zero visual delta is the pass condition.
3. Build sanity: `npm run build` succeeds and produces a Tailwind stylesheet (proves the plugin is wired), even though no utilities are used yet.

## Acceptance criteria

- [ ] `tokens.css` unchanged in meaning; STYLE_GUIDE still authoritative (bridge is one-directional).
- [ ] Dark mode toggles correctly through `[data-theme='dark']` (not `.dark`).
- [ ] No component file changed; app renders pixel-identically in both themes.
- [ ] `npm run verify` green; `npm run build` succeeds.
- [ ] `@/` alias resolves in both tsc and Vite.
