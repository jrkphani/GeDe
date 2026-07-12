# 076: ShapeProxy Lambda 15s timeout severs Electric's ~20s long-poll → read-path 502s + flaky sync

- **Status**: IMPLEMENTED (code-complete + cdk synth + cdk tests green; pending live deploy + smoke)
- **Milestone**: M8/M11 — cloud read-path reliability (infrastructure)
- **Severity**: **Critical** — the root cause of the non-deterministic read-path failures dogging the last several smokes. Content is written to RDS and delivered on the initial shape snapshot, but live-poll `502`s + a stuck "Sync error" intermittently prevent materialization; some sessions render, others don't, and previously-working tiers regress run-to-run.
- **Found via**: live e2e (persistent `502` on `live=true` long-poll + `[Electric] 409 without shape handle header`) → Electric container logs (`Req.TransportError socket closed`) → read-only CDK investigation.

## Root cause (proven, self-inflicted)

The ShapeProxy Lambda (`Gede-Test-Api-ShapeProxyFunction`, code `src/server/shapeProxy/albAdapter.ts`) proxies the client's `/sync` request to Electric. Its CDK **`timeout` is `Duration.seconds(15)`** (`deploy/cdk/lib/api-stack.ts:511`). Electric's `live=true` long-poll **holds the connection open ~20s** before responding (data or 204/up-to-date). So on a quiet long-poll, the **Lambda times out at 15s — before Electric responds** → the Lambda's in-flight `fetch()` to Electric is severed (Electric logs `socket closed`) → ALB returns **502** to the browser. The timeout ordering is inverted: `Lambda(15s) < Electric(~20s)`.

Downstream companions (not currently firing because the Lambda dies first, but must have headroom once it's raised):
- **ALB idle timeout** — not set anywhere (`grep idleTimeout deploy/cdk` → none) → default 60s. OK vs 15s today; keep ≥ Lambda timeout.
- **CloudFront origin `readTimeout`** for the `sync*` behavior — no override (`hosting-stack.ts:210-213`) → default 30s (CDK valid range 1–180s). OK vs 15s today; keep ≥ Lambda timeout.

**The `409`-without-handle warning** has **no CDK misconfiguration** (CloudFront forwards all origin headers by default — no `ResponseHeadersPolicy` on `sync*`; the Lambda forwards `electric-*` headers, stripping only `content-encoding`/`content-length`; `/sync` is same-origin so CORS-expose is N/A). It is most plausibly a **knock-on of the timeout bug** — a 409 arriving while the client recovers from a severed connection can lack the handle because the underlying fetch was cut short, not stripped by a proxy. Fix the timeout first, then re-observe; if it persists, it needs live ALB/CloudFront access-log analysis (separate).

Ruled out (verified correct, no change): `VITE_SYNC_URL` = same-origin `https://…cloudfront.net/sync` (`deploy.yml:128-135`, `src/sync/config.ts:21-23`); index.html caching (`hosting-stack.ts:104-137` noCachePolicy + `:299-311` invalidates `/index.html` every deploy — so the last smoke DID load the new bundle; 075 code ran).

## Fix (all in-place CDK updates — no resource replacement, no migration bump)

1. **`deploy/cdk/lib/api-stack.ts:511`** — `ShapeProxyFunction` `timeout: Duration.seconds(15)` → `Duration.seconds(30)` (Electric ~20s hold + DB workspace-lookup round trip + cold-start margin).
2. **`deploy/cdk/lib/api-stack.ts`** (the `ApplicationLoadBalancer`, ~178-183) — set `idleTimeout: Duration.seconds(60)` explicitly (already the default; make it explicit and ≥ the Lambda timeout).
3. **`deploy/cdk/lib/hosting-stack.ts:211`** — the `sync*` `HttpOrigin` → add `readTimeout: Duration.seconds(60)` so CloudFront doesn't clip the now-longer response.

Result ordering: `Electric ~20s  <  Lambda 30s  ≤  CloudFront readTimeout 60s`, `Lambda 30s  <  ALB idle 60s`.

## Test-first / verification

- **CDK assertion test** (`deploy/cdk/test/api-stack*.test.ts` / `hosting-stack*.test.ts`): assert the ShapeProxy Lambda `Timeout` = 30 and the `sync*` origin `OriginReadTimeout` = 60 (and ALB idle-timeout attribute = 60). Red against current 15/30-default, green after. Update any existing stack **snapshot** tests (the CloudFormation template changes).
- `cd deploy/cdk && npx cdk synth` succeeds; `npm test` (CDK suite) green.
- Root project `npm run verify:fast` unaffected (no src change) but run it if any shared config touched.
- **Live acceptance (post-deploy):** re-run the persistence smoke — `live=true` requests return 200/204 (no 502), the `409`-without-handle warnings drop, "Sync error" self-heals to "Synced", and the Design tier renders deterministically across repeat sessions.

## Notes

No schema/migration change; no `migration-*.test.ts` count bump. Deploys via push→CI like any CDK change (CloudFront distribution-config propagation takes a few minutes but is not a replacement). Architectural note: a buffered ALB→Lambda proxy is fine for Electric's long-poll (it's one JSON response, not a stream) **as long as the timeouts are ordered correctly** — this fix corrects the ordering; the topology is not the problem.

(The RLS-no-op + tenant-context-key latent bugs from 071 are now follow-up **issue 077**.)

**References**: `deploy/cdk/lib/api-stack.ts:505-514` (ShapeProxy Lambda timeout), `deploy/cdk/lib/api-stack.ts:178-183` (ALB), `deploy/cdk/lib/hosting-stack.ts:209-226` (`sync*` CloudFront behavior + origin), `src/server/shapeProxy/albAdapter.ts:109,136-139` (header forwarding — correct), `src/sync/config.ts:21-23` (`syncBaseUrl`).
