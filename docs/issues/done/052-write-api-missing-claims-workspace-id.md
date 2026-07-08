# 052: Write API rejected every signed-in write with 401 missing_claims

- **Status**: SHIPPED — fixed in commit `b2b4ec8` (`fix(050): derive write-path workspace from sub, not a custom:workspace_id claim`), verified live 2026-07-08 as part of 050's end-to-end write-loop test.
- **Milestone**: M11 (Close the cloud write loop)
- **Found via**: 050's live end-to-end smoke (sign-in → create project → verify in RDS via 049)

## Symptom

`POST /write` returned `401 {"reason":"missing_claims"}` for a validly-signed, validly-issued Cognito JWT.

## Root cause

`src/server/writeApi/jwt.ts` required a `custom:workspace_id` token claim (043's original design). But 050 deliberately uses a **deterministic workspace id derived from `sub`** (`workspaceIdForSub(sub)`) instead — no Cognito custom attribute, because adding one would force a User Pool replacement. Since no such claim is ever issued, every token failed the claim check.

The failure reason (`missing_claims`, not `invalid_token`) was the diagnostic signal: it confirmed the JWT signature and issuer were already validating correctly, and only the claim-derivation step was wrong.

## Fix

Shipped in commit `b2b4ec8`. `src/server/writeApi/jwt.ts` now derives the workspace id server-side from the verified `sub`, matching what the client scopes writes to:

```ts
if (!sub) return { ok: false, reason: 'missing_claims' }
return { ok: true, claims: { sub, workspaceId: workspaceIdForSub(sub) } }
```

The `custom:workspace_id`-claim check and the now-unused `WORKSPACE_CLAIM` constant were removed.

## Follow-up

None required — server and client now compute `workspaceIdForSub(sub)` identically by construction (same shared pure function, per 050's design).

**References**: 050 (deterministic `workspaceIdForSub`, the design this fix aligns the server with), 043 (original write-path JWT verification, the claim this replaces), 034 (workspaces/RLS tenancy).
