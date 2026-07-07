# 033: Authentication + account — Cognito (email/password) + hero + login screen

- **Status**: OPEN
- **Milestone**: M9 (Identity & tenancy)
- **Blocked by**: 030 (server/CDK app — shipped); provider decided by **ADR-0009** → **Amazon Cognito** (supersedes ADR-0008's better-auth)

> **Provider pivot (ADR-0009).** This issue was originally scoped around self-hosted **better-auth** on Fargate (ADR-0008). It is now **Amazon Cognito** — managed, no VPC compute, Google-Workspace-ready, and *cheaper* (removes an always-on Fargate task). Email/password ships here; **Google Workspace federation is a fast-follow issue** (a Cognito IdP config change, not a re-architecture).

## Slice

As a collaborator I land on a **hero page**, sign up / sign in through a **custom login screen** (Cognito email/password), hold a session, and see who I am in the app shell — so my edits are attributed and the server can scope data to me (the prerequisite for workspaces, sharing, and RLS). **Single-user local mode still works without an account**; auth is the on-ramp to the shared server, not a wall in front of the local app.

## Motivation

SPEC §1 frames v2 as "workspace RLS + realtime row-delta sync" — both need an identity to scope by; nothing multi-user is possible without it. ADR-0009 chooses **Cognito** so identity is a managed service (no self-hosted auth server to run/secure) that integrates with **Google Workspaces** as configuration, and *lowers* run cost by removing the better-auth Fargate task. This issue is the identity on-ramp: the hero + login that gate the shared features while preserving the account-free local app.

## Scope

- **Cognito (via CDK)**: a **`Gede-<Env>-Auth`** construct/stack — a **User Pool** (email sign-up, verification, password policy), an **App Client** (public SPA client, OIDC + PKCE / SRP, no client secret in the browser), and a **groups**/roles seam for later tenancy. Regional managed resource, **outside the VPC**. Google Workspace IdP is *out of scope here* (fast-follow).
- **Deployment change**: **remove** the `auth` Fargate service, its target group, and its ALB route from the `Gede-<Env>-Api` stack (ADR-0009) — Cognito replaces it. The Electric `sync` service is untouched. Net: one fewer always-on task.
- **Hero page**: an unauthenticated landing route — product framing + a `command`-style sign-in CTA (STYLE_GUIDE §2.2), design-system-native, served from the existing static PWA (no new infra). Links to the login screen.
- **Custom login screen**: a design-system screen (not Cognito Hosted UI) calling Cognito via the SDK (`amazon-cognito-identity-js` / OIDC PKCE) — sign-up, email verification, sign-in, sign-out, and the calm error surface (issue 015's error style). PKCE, no long-lived secret in the client.
- **Session + identity on the wire**: a durable Cognito session (token refresh across reload/SW boot); the client attaches the **Cognito JWT** to its sync/API connection (the hook 034's RLS reads via the `sub`/claim). The sync/API validates the JWT against Cognito's **JWKS**.
- **Shell integration**: an account affordance in the app bar (composed from `ui/` primitives — `Button`/`Popover`, not raw controls). Signed-out state, signed-in identity, sign-out.
- **Local mode preserved**: no account ⇒ the full single-user local-first app (PGlite/idb) still works; auth gates only the *shared* server features. Signing in later adopts existing local projects (the on-ramp is 037).

Out of scope: **Google Workspace federation** (fast-follow issue — Cognito IdP + Workspace SAML/OAuth setup); workspaces & RLS policy (034); sharing/roles/invitations (035); the sync wiring itself (032).

## Design brief

- **Auth is an on-ramp, not a gate**: the app is usable offline and account-free; identity unlocks collaboration, it doesn't block the tool (SPEC §1, TECH_STACK §5 "zero install friction"). The hero is the *first* thing a new visitor sees, but the local app never waits on an auth round-trip to boot.
- **Own the visual system**: custom hero + login screen (not Hosted UI) so the brand/design tokens carry through the very first screen; sign-in is a `command` button (issue 026), calm errors (015), quiet app-bar account chrome (STYLE_GUIDE §2.2/§4).
- **Least data, no client secrets**: store only what identity + attribution needs; PKCE public client, no long-lived secret in the browser; tokens in memory/secure storage with refresh.
- **Session ≠ sync**: Cognito establishes identity; 032 carries data. Keep them separable so the local app boots instantly and the JWT simply scopes the shared path when present.

**References**: **ADR-0009** (auth: Cognito) · ADR-0008 (v2 backend; auth portion superseded) · issue **030** (the CDK app + `Gede-<Env>-Api` stack this modifies) · `DEPLOYMENT.md §9` (v2 topology) · SPEC §1 (workspace RLS), §3 · TECH_STACK §5 (zero-friction PWA) · STYLE_GUIDE §2.2 (chrome), §4, §10 (focus/keyboard) · issues 026 (`command` button), 016 (app-bar/shell slots), 015 (calm error surface), 034 (RLS keys off the Cognito `sub`), 037 (adopt local projects on first sign-in).

## Test-first plan

1. **CDK assertion tests** (mirror `deploy/cdk/test/*`): the Auth stack creates a User Pool + public App Client (PKCE, no secret); the Api stack **no longer** has the `auth` Fargate service/target-group/route; app-wide tags propagate.
2. **Session lifecycle**: sign-up → verify → sign-in yields a session; sign-out clears it; the session/token persists (and refreshes) across reload respecting the SW/PWA boot.
3. **Local-mode preserved**: with no session, the full single-user app still boots and every existing e2e passes (auth is additive/gated) — the hero/login never block the local app.
4. **Identity on the wire**: an authenticated client presents a valid Cognito JWT to the server connection; the sync/API validates it against JWKS and rejects an invalid/expired token (the hook 034's RLS reads).
5. **Shell + screens a11y**: hero and login are keyboard-operable, focus-ordered (STYLE_GUIDE §10, SITEMAP §2), composed from `ui/` primitives (no new raw controls).

## Acceptance criteria

- [ ] Hero page + custom login screen (Cognito email/password: sign-up, verify, sign-in, sign-out) with a durable, refreshing session; account affordance in the app bar via `ui/` primitives.
- [ ] The Cognito JWT attaches to the server connection and validates against JWKS; no long-lived secret in the client (PKCE public client).
- [ ] The `auth` Fargate service/target-group/route is removed from `Gede-<Env>-Api`; a `Gede-<Env>-Auth` (Cognito) stack is added; CDK assertion tests cover both.
- [ ] Account-free local mode is fully preserved; no existing single-user test regresses.
- [ ] `npm run verify` green; CDK suite + offline synth green.

## Implementation notes

- **Cost**: Cognito removes the better-auth Fargate task (ADR-0009). Confirm the current Cognito **tier** (Lite/Essentials/Plus) that covers email/password (and, for the follow-up, Google/SAML federation) — at this scale it's free-to-single-digit-dollars/month.
- **Deployment**: Cognito is a regional managed resource **outside the VPC** — the SPA calls it directly, so no NAT/compute path. With only the `sync` task left in the private tier after this, a later optimization can drop the NAT gateway for VPC endpoints (ADR-0009, tracked separately).
- This is the natural moment to migrate the shell's raw `<button>`/`<input>` account/menu controls to `Button`/`Input`/`InlineEdit` and widen the lint scope to `src/shell/**` (HANDOFF deferred thread) — do it here rather than leave the new account control as another raw exception.
- **Fast-follow**: file the Google Workspace federation issue (Cognito IdP + Workspace SAML/OAuth app + attribute mapping + group→workspace mapping) once email/password is green.
