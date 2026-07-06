# 033: Authentication + account

- **Status**: OPEN
- **Milestone**: M9 (Identity & tenancy)
- **Blocked by**: 030 (server); coupled to 031 (if Supabase wins, auth folds into it)

## Slice

As a collaborator I sign in, hold a session, and see who I am in the app shell — so my edits are attributed and the server can scope data to me (the prerequisite for workspaces, sharing, and RLS). Single-user local mode still works without an account; auth is the on-ramp to the shared server, not a wall in front of the local app.

## Motivation

TECH_STACK §6.3 lists an `auth` service — **better-auth or Supabase auth** — as an open choice; SPEC §1 frames v2 as "workspace RLS + realtime row-delta sync", both of which need an identity to scope by. Nothing multi-user is possible without it. The exact provider is decided alongside 031 (Supabase bundles auth; Electric leaves it to better-auth).

## Scope

- **Provider** (decide with 031's ADR): **better-auth** (self-hosted, pairs with Electric) *or* **Supabase auth** (if Supabase is the sync engine). This issue implements whichever the ADR names.
- **Session**: sign-in / sign-out, a durable session token, and the client attaching identity to its sync/API connection (so 034's RLS can scope rows).
- **Shell integration**: an account affordance in the app bar (composed from `ui/` primitives — `Button`/`Popover`, not raw controls; note the shell currently holds raw controls, HANDOFF "deferred threads" — migrate the ones this touches). Signed-out state, signed-in identity, sign-out.
- **Local mode preserved**: a user with no account keeps the full single-user local-first app (PGlite/idb); auth gates only the *shared* server features. Signing in later can adopt existing local projects (the on-ramp is 037).

Out of scope: workspaces & RLS policy (034), sharing/roles/invitations (035), SSO/enterprise providers (revisit later), the sync wiring itself (032).

## Design brief

- **Auth is an on-ramp, not a gate**: the app is usable offline and account-free; identity unlocks collaboration, it doesn't block the tool. This protects the "zero-friction, local-first" promise (SPEC §1, TECH_STACK §5 "zero install friction").
- **Quiet chrome** (STYLE_GUIDE §2.2/§4): the account control is app-bar chrome — ink + the one accent, square, hairline; sign-in is a `command` button (issue 026), not a loud CTA.
- **Least data**: store only what identity + attribution needs; no profile sprawl.
- **Session ≠ sync**: auth establishes identity; 032 carries data. Keep them separable so the local app never waits on an auth round-trip to boot.

**References**: TECH_STACK §6.3 (auth service, better-auth/Supabase), §5 (PWA, zero-friction) · SPEC §1 (workspace RLS), §3 · STYLE_GUIDE §2.2 (chrome), §4, §10 (focus/keyboard) · issue 026 (`command` button variant), 016 (app-bar/shell slots), 031 (provider decision), 037 (adopt local projects on first sign-in).

## Test-first plan

1. **Session lifecycle**: sign-in yields a session; sign-out clears it; the session persists across reload (respecting the SW/PWA boot).
2. **Local-mode preserved**: with no session, the full single-user app still boots and every existing e2e passes (auth is additive/gated).
3. **Identity on the wire**: an authenticated client presents identity to the server connection (the hook 034's RLS reads) — asserted at the integration boundary.
4. **Shell a11y**: the account control is keyboard-operable, focus-ordered per the shell bands (STYLE_GUIDE §10, SITEMAP §2), and composed from `ui/` primitives (no new raw controls).

## Acceptance criteria

- [ ] Sign-in/out with a durable session; identity attaches to the server connection; the account affordance lives in the app bar via `ui/` primitives.
- [ ] Account-free local mode is fully preserved; no existing single-user test regresses.
- [ ] Provider matches 031's ADR; no long-lived secrets in the client.
- [ ] `npm run verify` green.

## Implementation notes

- If Supabase is chosen (031), auth + RLS + sync share one stack — 034 shrinks accordingly; if better-auth, auth is its own Compose service (030's `auth` slot) separate from Electric.
- This is the natural moment to migrate the shell's raw `<button>`/`<input>` account/menu controls to `Button`/`Input`/`InlineEdit` and widen the lint scope to `src/shell/**` (HANDOFF deferred thread) — do it here rather than leave the new account control as another raw exception.
