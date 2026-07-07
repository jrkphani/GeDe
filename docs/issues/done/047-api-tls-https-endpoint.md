# 047: HTTPS for the write API — end the mixed-content block

- **Status**: SHIPPED — code complete (CloudFront second-origin option; same-origin HTTPS, caching disabled for `/write*`); combined verify green (837 vitest + 87 CDK jest + `cdk synth --all`); integrated on `m11-close-write-loop`. **Live AWS deploy pending** (CI on merge to `main`); the mixed-content block clears live at that point.
- **Milestone**: M11 (Close the cloud write loop)
- **Blocked by**: 030 (ALB — SHIPPED)

## Slice

As the browser app served over **HTTPS** from CloudFront, I can make write calls to the API over **HTTPS too** — so the browser doesn't block them as mixed content. Today the API is reachable **only over plain HTTP**, which a page loaded from `https://d1nzod71m3rz6x.cloudfront.net` is forbidden to call.

## Motivation

This is the quiet blocker that would make 048 (the client write flush) fail even if everything else worked. The app is served over HTTPS (CloudFront default cert), but the ALB in front of the write Lambda has **no HTTPS listener** — only `HTTP:80`. A browser on an `https://` origin cannot issue a request to an `http://` endpoint (active mixed content is hard-blocked by every modern browser). So `fetch('http://…elb…/write')` from the deployed app is dead on arrival, independent of auth, schema, or handler.

## AWS ground truth (verified 2026-07-07)

- **ALB** `Gede-T-Alb16-7PG12HghU4Wa` (`a4936104fcde159b`), internet-facing, `active`. **Listeners: exactly one — `HTTP:80`. No `HTTPS:443`, no ACM certificate.** A live `https://…elb…/` probe times out (nothing listens on 443); `http://…elb…/write` reaches the stub.
- **Frontend origin**: `https://d1nzod71m3rz6x.cloudfront.net` (CloudFront default `*.cloudfront.net` cert). Cross-origin **and** cross-scheme relative to the ALB.
- **No custom domain** exists yet (DEPLOYMENT §7 — the `Gede-Test-Dns` stack is an inert seam), so a *trusted* TLS cert cannot be minted for the raw `*.elb.amazonaws.com` name (ACM won't issue for an AWS-owned domain you don't control).

## Scope

Two viable shapes — **prefer the first** (it also erases CORS and keeps one public surface):

- **Preferred — route the API through the existing CloudFront distribution.** Add the ALB as a **second origin** on the `Gede-Test-Hosting` CloudFront distribution under a path pattern (e.g. `/api/*` or `/write*`), origin-protocol HTTP to the ALB, viewer-protocol HTTPS. Result: the browser calls `https://d1nzod71m3rz6x.cloudfront.net/write` — **same-origin, HTTPS, no mixed content, no CORS, no new cert** (reuses CloudFront's cert). The ALB can stay HTTP internally (private-ish, and behind CloudFront). Add a cache policy that **disables caching** for the API path (it's a mutating POST).
- **Alternative — HTTPS listener on the ALB.** Requires a custom domain + DNS-validated ACM cert (activate the `Gede-Test-Dns` seam, DEPLOYMENT §7), add an `HTTPS:443` listener with that cert, and CORS-allow the CloudFront origin. Heavier; only worth it if the API needs its own `api.<domain>` hostname.

Also in scope regardless of shape:

- **CORS** only if a separate origin remains (the preferred CloudFront-path option makes it same-origin, so no CORS needed). If the alternative is chosen, allow exactly the CloudFront origin, methods `POST`/`OPTIONS`, and the `Authorization` header.
- **Redirect/refuse plain HTTP** for the API path once HTTPS exists.

Out of scope: the write handler (046); the client fetch (048); a registered public domain (that's the broader DNS/`prod` follow-up, DEPLOYMENT §7 — the preferred option needs no domain).

## Design brief

- **Same-origin beats CORS**: fronting the ALB with the existing CloudFront distribution gives HTTPS *and* same-origin in one move, and reuses the cert already in place — the cheapest correct fix, and it keeps a single public entry point (matches the "only the ALB/NAT are public" security posture, DEPLOYMENT §9, by putting the API behind the CDN too).
- **Don't cache mutations**: the API path must be a no-store passthrough — CloudFront caching a `POST` response would be a correctness bug.
- **No premature domain**: this issue must not depend on registering a domain; the CloudFront-path option deliberately avoids it.

**References**: DEPLOYMENT §2/§9 (CloudFront + ALB topology), §7 (DNS seam, why no cert yet) · issue 040 (Hosting/CloudFront stack), 043/046 (the ALB write path) · TECH_STACK §6 · SITEMAP §1.

## Test-first plan

1. **CDK assertion**: the distribution has an additional behavior for the API path pointing at the ALB origin with viewer-protocol-policy `redirect-to-https`/`https-only` and a **no-cache** policy; the ALB origin protocol is HTTP. (Or, for the alternative: an `HTTPS:443` listener with a cert + the HTTP listener redirecting.)
2. **No-cache guard**: assert the API behavior uses a caching-disabled policy (TTL 0 / `CachingDisabled`) so POSTs aren't cached.
3. **Live smoke (post-deploy)**: `https://d1nzod71m3rz6x.cloudfront.net/write` (POST) reaches the Lambda over HTTPS (503 today, real response after 046); a browser `fetch` from the app origin is **not** blocked as mixed content.
4. **Mixed-content regression (e2e)**: a Playwright check that the deployed app can issue the write request without a browser mixed-content/CSP violation in the console.

## Acceptance criteria

- [ ] The write API is reachable over **HTTPS from the app's own origin** with no mixed-content block and no CORS error.
- [ ] The API path is **not cached** (mutations pass through); plain-HTTP API access is redirected/refused.
- [ ] No dependency on a registered custom domain (preferred option) — or, if the ALB-HTTPS route is chosen, the DNS/ACM seam is activated per DEPLOYMENT §7.
- [ ] `npm run verify` + CDK assertions green; post-deploy smoke confirms an HTTPS same-origin call succeeds.

## Implementation notes

- The CloudFront-second-origin option touches `deploy/cdk/lib/hosting-stack.ts` (add origin + behavior) and reads the Api stack's ALB DNS (cross-stack ref) — mind the stack dependency direction (Hosting would depend on Api, or pass the DNS via context).
- This is a **hard prerequisite for 048**: the client can only POST to an HTTPS same-origin (or CORS-allowed HTTPS) endpoint. Land 047 before wiring 048's fetch.
- Deploy is CI's job — "done" here is merge-ready CDK + green synth/tests.
