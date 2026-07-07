# 044: Frontend Cognito config — enable live sign-in in the deployed build

- **Status**: SHIPPED — code complete; combined verify green (837 vitest + 87 CDK jest + `cdk synth --all`); integrated on `m11-close-write-loop`. **Live AWS deploy pending** (CI on merge to `main`); the live-smoke acceptance items verify at that point.
- **Milestone**: M11 (Close the cloud write loop)
- **Blocked by**: 033 (Auth stack + LoginScreen — SHIPPED; the User Pool exists, the client just isn't given its ids)

## Slice

As a visitor to the **live** app (https://d1nzod71m3rz6x.cloudfront.net), when I open `/login` I can actually sign in with email/password against the real Cognito User Pool — instead of the current dead-end where the form renders but reports *"Sign-in isn't configured for this build"* and the button is disabled.

## Motivation

The Auth stack is deployed and the User Pool is live, but **the frontend build was shipped without the `VITE_COGNITO_*` env vars**, so `getCognitoConfig()` (`src/auth/config.ts`) returns `null`, `useAuthStore.configured` is `false`, and `LoginScreen` correctly degrades to its "not configured" state. The result: every cloud feature gated on a signed-in identity (workspaces, sharing, sync, the write path) is unreachable from the deployed app, because no JWT can ever be minted. This is the first of the four gaps that keep the v2 cloud loop from working end-to-end (HANDOFF follow-up #1).

## AWS ground truth (verified 2026-07-07, acct `975049998516`, `us-east-1`)

- **Auth stack outputs** (`Gede-Test-Auth`): `UserPoolId = us-east-1_d0qKGDQmC`, `UserPoolClientId = 5qbs9mgmms9mcf0u7r26npi3g2`, `UserPoolJwksUri = https://cognito-idp.us-east-1.amazonaws.com/us-east-1_d0qKGDQmC/.well-known/jwks.json`. The output descriptions already say *"consumed by the frontend build (VITE_COGNITO_USER_POOL_ID / …_CLIENT_ID)"* — the consumer was never wired.
- **Deployed bundle** (`/assets/index-*.js`): grep for `us-east-1_d0qKGDQmC` → **absent**. The pool id is not inlined, confirming the build ran without the env vars.
- **Live runtime**: `/login` renders "Sign-in isn't configured for this build — continue with the local app instead." with a `disabled` submit button (Playwright, 2026-07-07).

## Scope

- **Thread the Auth stack outputs into the frontend build** as `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`, `VITE_COGNITO_REGION` at `npm run build` time in CI (`.github/workflows/deploy.yml`). Source them from the `Gede-Test-Auth` stack outputs (CloudFormation `describe-stacks`/`ExportName`) rather than hardcoding — a redeploy of Auth must not silently desync the frontend.
- **Keep auth an on-ramp, not a gate** (ADR-0009): the account-free local app must still boot instantly when the vars are present *and* when they're absent (local dev, tests). No new blocking on boot.
- **No secrets in the bundle**: the User Pool id + public app-client id are non-secret by design (they're in every Cognito SPA); document this so the values aren't mistaken for credentials. No client secret is used (public SPA client, PKCE).

Out of scope: the write-path Lambda's issuer wiring (046); applying RDS migrations (045); Google Workspace federation (a 033 fast-follow).

## Design brief

- The login UI already exists and is correct — this issue only feeds it real config. Success is the *same screen* losing its "not configured" banner and enabling the button.
- Build-time injection, not runtime fetch: the ids are compile-time constants (Vite inlines `import.meta.env.VITE_*`), matching how `config.ts` already reads them.

**References**: ADR-0009 (Cognito, on-ramp-not-gate) · issue 033 (LoginScreen, Hero, `src/auth/config.ts`) · TECH_STACK §6.4 (OIDC CI is the only deploy path) · DEPLOYMENT.md §9 · SITEMAP §1 (`/login`).

## Test-first plan

1. **Config presence (unit)**: with `VITE_COGNITO_USER_POOL_ID`/`_CLIENT_ID` set, `getCognitoConfig()` returns a non-null config and `useAuthStore.configured` is `true`; unset → `null` and `configured` false (already partially covered — extend to assert the store flag drives the LoginScreen banner).
2. **LoginScreen states (component)**: `configured=false` renders the "not configured" banner + disabled button; `configured=true` renders an enabled sign-in form with no banner.
3. **Build wiring (CI assertion)**: a check that the deploy workflow exports the three `VITE_COGNITO_*` vars from the Auth stack outputs before `vite build` (grep/lint the workflow, or a smoke step asserting the built bundle contains the pool id).
4. **Live smoke (post-deploy, manual/e2e)**: `/login` on the deployed URL shows an enabled form; a sign-up + confirm + sign-in round-trip against the real pool yields a JWT in the auth store.

## Acceptance criteria

- [ ] The deployed `/login` renders an **enabled** email/password form (no "not configured" banner); the bundle contains the live pool id.
- [ ] `getCognitoConfig()`/`configured` are driven by the injected vars; local + test boots are unchanged (still account-free, still instant).
- [ ] CI sources the vars from the `Gede-Test-Auth` stack outputs (no hardcoded ids in the workflow).
- [ ] `npm run verify` green; a manual sign-in round-trip against `us-east-1_d0qKGDQmC` succeeds.

## Implementation notes

- Fastest correct path: in the deploy job, `aws cloudformation describe-stacks --stack-name Gede-Test-Auth` → export `VITE_COGNITO_USER_POOL_ID`/`_CLIENT_ID` into the `vite build` step's env. Region is `us-east-1` (config defaults it).
- This unblocks 048 (the client needs a real JWT to attach to `/write` calls) and pairs with 046 (the Lambda must validate JWTs from *this same* issuer).
