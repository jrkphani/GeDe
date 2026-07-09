# 064: Hero / landing page with integrated sign-up + sign-in (shadcn `login-05`), product brief, sign-out destination

- **Status**: SHIPPED
- **Milestone**: M9 (Identity & tenancy) — the signed-out on-ramp; pairs with 063 (sign-out lands here)
- **Requested by**: product owner, 2026-07-10 — "create a hero page with sign up and sign in functionality … give a brief about the GeDe product and follow the style guide and ensure use of Shadcn components like `npx shadcn@latest add login-05`."

## Problem / Goal

Today's signed-out on-ramp (issue 033) is minimal: `src/components/Hero.tsx` is a one-line panel ("Design generative systems, together." + Sign in / Use locally), and `src/components/LoginScreen.tsx` is a separate 3-mode form (sign-in / sign-up / verify) at `/login`. There is no real **product brief**, and the auth screen isn't a polished landing experience.

Upgrade the signed-out experience to a proper **hero / landing page** that (a) briefly explains what GeDe is, (b) offers **sign up and sign in** in one polished surface, (c) follows the STYLE_GUIDE, (d) is built with shadcn components — specifically the **`login-05`** block (`npx shadcn@latest add login-05`), and (e) is the canonical destination a user lands on when signed out (including **after sign-out** — see 063).

## Design brief

- **Layout — shadcn `login-05`.** `login-05` is the two-column auth block (a marketing/brand panel beside the auth card). Use it as the structural base:
  - Run `npx shadcn@latest add login-05` (the repo already has shadcn/ui set up — issue 018, `components.json`). It will scaffold the block plus any missing primitives (likely `card`, `label`, possibly `field`/`separator`) into `src/components/ui/`. If the CLI can't reach the registry from this environment, hand-port the block's structure faithfully instead — do NOT block on the network.
  - **Adapt to this repo's system:** Tailwind v4 + the STYLE_GUIDE **design tokens** — NO hardcoded CSS colors (lint-enforced, issue 020); no raw `<button>/<input>` outside `src/components/ui/` (use the primitives). Reconcile the block's default palette with the GeDe tokens.
- **Brand / marketing panel — the product brief.** A concise, accurate description of GeDe. Keep it truthful to the product (a local-first tool for designing generative *systems* — dimensions, parameters, contexts, tiers, canvas; syncs across devices/collaborators when signed in). 2–4 short value points, GeDe voice per STYLE_GUIDE. Not marketing fluff.
- **Auth card — reuse the existing Cognito wiring.** Do NOT reimplement auth. Drive the block's form with the existing `useAuthStore` actions (`signIn`, `signUp`, `confirmSignUp`, `resendCode`) and preserve all three modes (sign-in / sign-up / email verify) that `LoginScreen.tsx` already handles. Sign-up + sign-in are the headline ask.
- **Preserve local-first.** Keep a clear **"Use locally"** (no-account) affordance — GeDe works offline with no account (a product pillar; 063 chose "clear-on-sign-out", not full gating). The hero must not become a hard wall.
- **Routing.** This page is the signed-out on-ramp (`/login`, and/or the signed-out `/` hero). It is the **sign-out redirect target** — coordinate with 063 so sign-out (after clearing local data) navigates here.

## Scope / files

- `src/components/ui/*` — new primitives from `login-05` (card/label/etc.), token-adapted.
- A hero/landing component (evolve `Hero.tsx` + fold in `LoginScreen.tsx`, or a new `src/components/HeroLanding.tsx`) using the block; wire to `useAuthStore`.
- `src/shell/routes.ts` / `AppShell.tsx` — render it for signed-out users; expose it as the sign-out destination for 063.
- STYLE_GUIDE-conformant CSS/tokens; keep `Hero.test.tsx` / `LoginScreen.test.tsx` behaviors (migrate/extend, don't regress).

## Test-first plan

- Renders the **product brief** copy and both **Sign in** and **Sign up** entry points.
- Each mode works end-to-end against a mocked `useAuthStore`: sign-in calls `signIn`; sign-up calls `signUp` then routes to verify; verify calls `confirmSignUp`. (Migrate the existing `LoginScreen.test.tsx` assertions.)
- The **"Use locally"** affordance is present and routes to the local app (no-account path intact).
- A11y: labelled inputs, a single `<h1>`, keyboard-navigable; no raw button/input primitives (component-lint passes).
- No hardcoded colors (stylelint token rule passes).

## Dependencies / ordering

Builds on 033 (existing hero/login + Cognito wiring) and 018/019/020 (shadcn foundation + guardrails). Pairs with **063** (sign-out clears local data **and** redirects here). Independent of the 062/#8 sharing thread.

**References**: 033 (`done/033-auth-account.md` — the hero/login this upgrades), 026 (the `command` sign-in CTA affordance), 063 (sign-out redirect + clear-on-sign-out), STYLE_GUIDE (voice, tokens, layout), SITEMAP §3 (on-ramp), 018/019/020 (shadcn/ui + enforcement). shadcn block: `login-05`.
