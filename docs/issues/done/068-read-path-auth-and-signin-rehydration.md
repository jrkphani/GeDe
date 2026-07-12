# 068: Electric read-path is never authenticated + sign-in never rehydrates — projects vanish after sign-out/in, and shared projects never reach invitees

- **Status**: SHIPPED (deployed + verified live 2026-07-12 — shape reads return 200, no 401s post-sign-in; sign-in rehydrates the project list)
- **Milestone**: M9/M8 — sharing correctness + cloud read loop (the keystone that closes both)
- **Severity**: **Critical** — the client Electric read-path has never delivered a single row to a real authenticated client, and sign-in never restarts it. Root cause of GitHub **#11** (projects missing after sign-out/in) **and** GitHub **#8 / issue 055** (invitees never receive the shared project).
- **Found via**: parallel read-only investigation of GitHub #9/#10/#11 (2026-07-10), then direct code verification.

## Symptom / discrepancy

- **#11**: create projects → sign out → sign in with the same account → projects are gone.
- **#8 / 055**: an invited user never sees the shared project stream in, despite the write-path landing the invite in RDS and Electric replicating.

## Root cause — two compounding defects (both verified in code)

**Defect A — sign-in never re-fetches or restarts the read-path.**
`useAuthStore.signIn()` (`src/store/auth.ts:163-178`) and `hydrate()` (`:113-131`) only call `applyWorkspaceScope(sub)` (sets `useSyncStore.workspaceId` + kicks a write-only `flush()`). Neither calls `useProjectsStore.getState().refreshProjects()` nor restarts Electric. `useProjectsStore.init()` (`src/store/projects.ts:89-102`) — the only place that lists projects + starts sync — runs exactly once from `App.tsx:92-99` (empty-deps effect) and never re-runs on sign-in within the SPA session. So after 063's `clearLocalDataOnSignOut()` sets `projects: []` on sign-out, nothing repopulates it on the next sign-in. (Contrast the *correct* existing pattern: `useWorkspaceStore.acceptInvitation()` (`src/store/workspace.ts:290-296`) explicitly calls `refreshProjects()` after a membership change.)

**Defect B — the read-path is never authenticated (foundational).**
`useSyncStore.start(db)` (`src/store/sync.ts:187`) is always called with **no options** (`projects.ts:98`, `:261`), so `SyncOptions.getAuthToken` defaults to `noAuth` (`src/sync/authToken.ts` → `Promise.resolve(null)`; `syncEngine.ts:60` `options.getAuthToken ?? noAuth`). `defaultShapeStreamFactory`'s `Authorization` header (`syncEngine.ts:66-68`) is therefore always empty. Server-side, the shape proxy (`src/server/shapeProxy/handler.ts:79-85`) requires a bearer token and returns **401 `missing_token`** with no bypass (even under `-c debugApi=true`). **Result: every synced table 401s — zero rows ever reach a real authenticated client.** The write path has JWT wiring (`getAuthHeaders`, `src/auth/wireIdentity.ts`, used by `sync.ts` `flush`); the read path never got an equivalent. Confirmed: `getAuthToken` is supplied nowhere in `src/` outside tests (which inject a `streamFactory`, bypassing the auth code).

**Bonus trap:** `refreshProjects()` (`projects.ts:257-262`) only restarts the read-path `if (sync.enabled)`, but 063's `resetSyncStore()` sets `enabled: false` on sign-out — so calling `refreshProjects()` from `signIn()` as-is would re-list (empty) and **not** restart sync. `sync.start()` itself is internally safe to call unconditionally (its guards are env/config-based: `isSyncEnabled()`, `shouldSkipReadPath()`), so the guard must be loosened, not just a new caller added.

**Why this was invisible until now:** before 063, owners always saw their own *local* PGlite data, so the broken read-path never surfaced. 063 (clear-on-sign-out) didn't introduce the bug — it *unmasked* it. And every "sharing works" check to date was a same-browser local-data illusion or a unit test — the cross-user live smoke that would have caught Defect B was never run.

## Fix direction (minimal)

1. **`src/store/sync.ts`** `start()` (~187-211) — default `options.getAuthToken` to `() => useAuthStore.getState().getIdToken()` when the caller doesn't inject one (mirror how `flush()` already imports `useAuthStore`/`getAuthHeaders` in this same file). Closes Defect B centrally at the one production entry point; tests inject their own `streamFactory` so they're unaffected.
2. **`src/store/projects.ts`** `refreshProjects()` (251-263) — loosen the `if (sync.enabled)` gate so it unconditionally `sync.stop(); sync.start(db)` (both are internally safe no-ops when sync isn't configured), making fix #3 take effect after a sign-out disabled the engine.
3. **`src/store/auth.ts`** — in `signIn()` (163-178) and `hydrate()` (113-131), after `applyWorkspaceScope(sub)` succeeds, call `useProjectsStore.getState().refreshProjects()`. `useProjectsStore` is already imported (line 7).

## Test-first plan (red first)

1. **`src/store/auth.test.ts`** — `signIn` calls `refreshProjects()` after workspace scope is established (spy asserted called once, after `workspaceId` non-null). Same for `hydrate()`. *Fails today.*
2. **`src/store/projects.test.ts`** — `refreshProjects()` restarts sync via `sync.start` even when `sync.enabled` is `false` (simulate post-sign-out reset; injected `streamFactory` invoked again). *Fails today (guard blocks it).*
3. **`src/store/sync.test.ts`** — `start()` with no caller override passes a `getAuthToken` that resolves the signed-in id token (not `null`/`noAuth`). *Fails today (never injected).*
4. Standing gates: `npm run verify:fast` green (typecheck → eslint → stylelint → vitest).

## Acceptance

- Tests 1–3 green + `verify:fast` clean.
- **Live smoke (post-deploy, orchestrator/user):** signed-in create → sign out (local wiped) → sign in → **projects re-stream in** (proves read-path auth + rehydration). Then the two-identity sharing smoke (#8): a separate-profile invitee accepts and the project streams in. Confirm via the invitee's shape request returning **200** (not 401) in the shape-proxy / Electric CloudWatch logs.

## Dependencies / ordering

**Keystone** — land and deploy this before #10 (069) and #9 (070); both rebase on the reshaped `refreshProjects`/`sync.start`. Closes the read half of 055/#8 and all of #11.

**References**: `src/sync/authToken.ts` + `syncEngine.ts:59-70` (the `noAuth` seam this fills), `src/server/shapeProxy/handler.ts:79-85` (401 the fix satisfies), `src/auth/wireIdentity.ts` (write-path JWT pattern to mirror), `src/store/workspace.ts:290-296` (the correct `refreshProjects`-after-scope-change precedent), 063 (`clearLocalDataOnSignOut` that unmasked this), 050 (workspace provisioning on sign-in).
