# 020: Enforcement guardrails — typesafety, tokens, component usage

- **Status**: OPEN
- **Milestone**: M1 (foundation / pre-work)
- **Blocked by**: 019

## Slice

As the project owner I want the three disciplines — type safety, design-token usage, and shared-component usage — **mechanically enforced**, so an agent that hand-rolls a `<button>`, hardcodes a colour, or writes an unsafe cast fails `npm run verify` instead of shipping. This issue turns the conventions the audit confirmed into automated gates, and wires the gate into a hook + CI so it actually runs.

## Scope

**Type safety**
- `tsconfig.json`: add `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Fix fallout.
- `eslint.config.js`: `recommended` → `strictTypeChecked` + `stylisticTypeChecked` with `parserOptions.projectService`. Enables `no-unsafe-*`, `no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`, `no-unnecessary-type-assertion`. Add `eslint-plugin-react-hooks` (rules-of-hooks + exhaustive-deps).
- Kill the **34 `as` casts** that re-defeat `noUncheckedIndexedAccess`: add `src/db/util.ts` `firstOrThrow(rows, msg)` and replace the 15 `rows[0] as XRow` casts in `mutations.ts`; give TanStack `meta` a typed interface in `EditableGrid.tsx` to remove those casts.

**Design tokens**
- Add the missing type scale to `tokens.css`: `--text-title/-section/-body/-ui/-mono/-caption` + matching `--leading-*` (STYLE_GUIDE §3 values 22/28 · 17/24 · 14/20 · 13/20 · 12/16 · 11/16). Replace the 19 hardcoded `font-size`s (+ 3 `line-height`s) in `base.css`.
- Add `stylelint` + `stylelint-config-standard` + `stylelint-declaration-strict-value`: force `color`/`background`/`background-color`/`border-color`/`fill`/`stroke` to be `var(--…)` (carve-outs: `transparent`, `currentColor`, `inherit`). Optionally extend to `font-size`/`line-height` now that tokens exist. Carve out literal `1px`/`2px` borders/outlines and documented shell-band heights.
- Add `lint:css` script; fold into `verify`.

**Component / pattern usage**
- `eslint.config.js` `no-restricted-syntax` scoped to `src/components/**` **excluding** `src/components/ui/**`: ban raw `<button>`, `<input>`, `<select>` JSX (must come from `ui/`). Message points at the primitive to use.
- `no-restricted-imports`: ban `@radix-ui/*`, `cmdk`, `@dnd-kit/*` outside `src/components/ui/**` (primitives are wrapped once). Tighten the existing db rule `**/db/*` → `**/db/**` so `src/db/migrations/*` is also caught.

**Automation (make the gate real)**
- `husky` + `lint-staged`: `pre-push` runs `npm run verify`; `pre-commit` runs `tsc --noEmit` + `eslint` + `stylelint` on staged files.
- `.github/workflows/verify.yml`: `npm ci && npx playwright install --with-deps && npm run verify` on PR + push to `main`. (Note: HANDOFF flags CI as previously deferred on an AWS decision — this workflow is verify-only, no deploy, so it is unblocked.)
- Drop `--quiet` from `lint` (or ensure every rule is `error`) so warnings can't pass silently.

## Design brief

- **Enforcement matches reality.** Colour discipline is already ~100%; the token rules should pass on day one except the font-size tokenization done in this same issue. Type rules will surface real casts — fix them, don't suppress them.
- **`ui/` is the sanctioned escape hatch.** The `no-restricted-syntax`/`no-restricted-imports` rules are *scoped out* of `src/components/ui/**` — that directory is where raw primitives and third-party libs legitimately live. This is what makes "always use the component library" a lint error elsewhere.
- **Fail loud, fail early.** `pre-commit` catches the cheap stuff locally; `pre-push` + CI run the full `verify` so nothing type-unsafe or lint-failing reaches `main`.

**References**: audit 2026-07-05 (tsconfig gaps, 34 casts, no CI/hooks) · STYLE_GUIDE §3 (type scale) · eslint layer-boundary rule (issue 001) · HANDOFF §"How to work" (verify gate) · TECH_STACK §6.4 (CI/OIDC — deploy still deferred)

## Test-first plan

1. Land a **deliberately bad** commit on a scratch branch to prove each gate bites, then revert: a raw `<button>` in a component (→ `no-restricted-syntax` error), a `#hex` in `base.css` (→ stylelint error), an `as any` (→ `no-explicit-any`/`no-unsafe-*`), a floating promise (→ `no-floating-promises`). Each must fail `verify`.
2. `npm run verify` green on the real tree after all fixes (types + lint + css-lint + unit + e2e).
3. CI: workflow runs green on a PR (or `act`/dry-run locally if no GitHub runner yet).
4. `git push` to a scratch branch triggers the `pre-push` verify.

## Acceptance criteria

- [ ] A raw `<button>`/`<input>` outside `ui/`, a hardcoded colour in CSS, an `as any`, or a floating promise each **fail `npm run verify`**.
- [ ] Zero `as` casts remain that defeat `noUncheckedIndexedAccess` in `mutations.ts` (replaced by `firstOrThrow`).
- [ ] No hardcoded `font-size` in `base.css`; all reference `--text-*`.
- [ ] `pre-push` runs `verify`; `.github/workflows/verify.yml` runs on PRs.
- [ ] `lint` no longer hides warnings (`--quiet` dropped or all rules `error`).
