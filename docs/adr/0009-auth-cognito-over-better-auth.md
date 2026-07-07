# ADR-0009: Authentication via Amazon Cognito (supersedes ADR-0008's better-auth choice)

- **Status**: Accepted
- **Date**: 2026-07-07
- **Supersedes**: the **auth** decision in [ADR-0008](0008-v2-backend-cdk-rds-electricsql.md) (better-auth). ADR-0008's topology (CDK VPC + NAT + RDS + Fargate) and sync (ElectricSQL) decisions stand unchanged.

## Context

ADR-0008 chose **self-hosted better-auth** on Fargate for v2 authentication (issue 033), so the app would own the write path and auth alongside ElectricSQL sync. Since then two things changed the calculus:

1. **The v2 backend is deployed and its costs are real.** The `Gede-Test-Api` Fargate tier is now live; a self-hosted better-auth service means a *second* always-on Fargate task (~$10–15/mo) plus the operational surface of running an auth server, session store, and its own migrations.
2. **Google Workspace is the target identity source.** The maintainer wants sign-in that integrates with **Google Workspaces**. better-auth can federate, but standing up and securing enterprise SSO on a self-hosted service is real work; a managed identity provider does it as configuration.

## Decision

Use **Amazon Cognito User Pools** for v2 authentication.

- **Managed, no VPC compute.** The SPA authenticates against Cognito directly over the internet (OIDC + PKCE / SRP). There is **no auth service in the VPC** — the `auth` Fargate slot from issue 030 is **removed**, not filled.
- **Email/password first, Google Workspace federation next.** The first slice (issue 033, rewritten) ships Cognito native email/password sign-up/login. Google Workspace is added as a Cognito **identity provider** (OAuth social IdP, or SAML for full Workspace SSO) in a fast-follow issue — a configuration change to the same User Pool, not a re-architecture.
- **Custom login screen, not Hosted UI.** A design-system-native hero + login screen call Cognito via the SDK (`amazon-cognito-identity-js` / OIDC PKCE), so the visual system is fully owned. Cognito Hosted UI is not used.
- **JWT on the wire; RLS keys off the Cognito `sub`.** Sign-in yields a Cognito-issued JWT. The sync/API validates it against Cognito's JWKS (replacing better-auth sessions), and workspace RLS (issue 034) scopes rows by the Cognito `sub` (and a `workspace`/`tenant` claim or mapping), rather than a better-auth session identity.

## Why not stay with better-auth

- **Cost.** Cognito removes an always-on Fargate task; at this project's scale it lands in the free/low tier (thousands of MAUs free before per-MAU pricing; external-IdP/SAML federation sits in a paid tier but at single-digit dollars for a small team — confirm the current Cognito tier when implementing 033). Net: **auth cost goes down**, not up.
- **Google Workspace fit.** Enterprise/social federation is first-class Cognito configuration, exactly the stated goal.
- **Less to run and secure.** No self-hosted auth server, session store, or auth migrations to operate.

Trade-off accepted: some **AWS lock-in** for auth (mitigated — the app depends on standard OIDC/JWT, so the boundary is portable), and Cognito's UX quirks are avoided by owning the login screen.

## Consequences

- **Issue 033 is rewritten** from "better-auth on Fargate" to "Cognito auth + hero + login screen (email/password), JWT-gated app". Google Workspace federation becomes its own fast-follow issue.
- **Deployment delta**: add a **`Gede-<Env>-Auth`** CDK construct/stack (Cognito User Pool + App Client + groups; later the Google IdP) — a managed, regional resource **outside the VPC**. **Remove the `auth` Fargate service, its target group, and its ALB route** from the `Gede-<Env>-Api` stack. The ElectricSQL `sync` service and everything else in ADR-0008 are unchanged. Hero/login/account UI are **frontend only** — no new infra, served from the existing S3/CloudFront.
- **Issue 034 (RLS)** scopes by the Cognito `sub`/claim instead of a better-auth identity. **Issue 032 (sync)** validates the Cognito JWT on the connection.
- ADR-0008 gets a one-line "auth superseded by ADR-0009" note; `DEPLOYMENT.md §9` and the README index are updated to name Cognito.
- **Cost note**: this also opens a further lever — with only the `sync` task left in the private tier, the **NAT gateway (~$32/mo)** could later be replaced by VPC interface endpoints (ECR/Secrets/Logs) for that one task. Tracked separately, not part of this ADR.
