# 063: No protected routes — signed-out users still access project data in the same browser

- **Status**: OPEN — needs a product/design decision before implementation (see "Design decision required")
- **Milestone**: M9/M10 — auth-gating vs. local-first reconciliation
- **Severity**: Medium (security/privacy on shared devices) — but entangled with a core architectural stance, so **not** a blind fix.
- **Found via**: Tester report (2026-07-10): "the browser does not redirect me away from the project upon sign out. I can still access the project without signing in as long as it is the same browser. I don't think we have implemented any protected pages."

## Symptom

After **sign out**, the app does not redirect away from a project, and the project remains fully viewable/editable in the same browser without signing back in. There are no route guards gating project pages behind an authenticated session.

## Root cause (this is partly by-design, which is why it needs a decision)

GeDe is **local-first**: all project data lives in the browser's PGlite/IndexedDB and the app is fully usable **offline and with no account** (v1's entire model; see `DEPLOYMENT.md §2`). Auth (Cognito, v2) was added for **cloud sync + sharing**, not to gate the local app. So:

- Signing out clears the Cognito session/tokens and stops cloud sync, but **does not** clear local PGlite or gate any route.
- A signed-out (or never-signed-in) user therefore sees whatever is in that browser's local database — which is the intended offline/no-account experience, but on a **shared browser** it leaks the previous user's projects.

## Design decision required (pick the intended model before building)

These are materially different products — the fix depends on which is intended:

1. **Local-first preserved + clear-on-sign-out (recommended default).** Keep no-account/offline usage, but on **sign out** wipe the *cloud/workspace-scoped* local data (and ideally the whole local DB if the session was cloud-backed) so the next person on that browser starts clean. Projects that were local-only (no workspace) — decide whether to keep or also clear. Least disruptive to the local-first bet; addresses the shared-device leak.
2. **Gate cloud content only.** Local-only projects stay accessible signed-out (offline-first intact); **workspace/shared** projects require an authenticated, authorized session to open (route guard + a membership check on load). Signing out hides cloud projects but keeps the local sandbox.
3. **Full auth-gate (abandons no-account use).** Every route requires sign-in; signed-out → redirect to `/login`. Simplest mental model, but **removes** the offline/no-account capability that is a stated product pillar — a real strategic change, not just a fix.

## Fix direction (once a model is chosen)

- **Route guards:** a wrapper in `src/shell/` (router at `src/shell/router.ts`/`routes.ts`) that redirects to the login/hero screen when a page requires auth and `useAuthStore` has no session.
- **Sign-out teardown:** in `useAuthStore` sign-out, in addition to clearing tokens/sync, clear the relevant local data (drop/reset the PGlite instance, clear the workspace store) per the chosen model.
- **Load-time authorization:** for gated cloud projects, verify membership before rendering (defense-in-depth alongside RLS/shape-proxy scoping).

## Test-first plan (model-dependent)

- Route-guard test: navigating to a protected route while signed out redirects to login.
- Sign-out test: after sign-out, the chosen-scope local data is no longer readable/rendered (e.g. `listProjects` returns the expected reduced set; the previously-open project is gone from the view).
- Regression: whichever offline/no-account path is intended to survive still works signed-out.

**References**: 033 (Cognito auth), `DEPLOYMENT.md §2` (local-first, no-server v1 — the model this must reconcile with), 034 (workspace RLS — server-side authz that a client route guard complements), `src/store/auth.ts` (sign-out), `src/shell/routes.ts`. Independent of #8/062, but same overall v2 auth surface.
