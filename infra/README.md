# infra

CDK app for GeDe: `GeDe-Pipeline` (CodePipeline, ap-southeast-1) deploying the `GeDe-Prod-*`
stacks. Day-to-day conventions are in `CLAUDE.md`; this file is the one-time bootstrap.

## One-time bootstrap

Done once, from a laptop, with the `phani-quadnomics` profile (account 975049998516).

1. **Domain.** Register `gede.work` in Route 53 (or create the public hosted zone and delegate).
   Copy the hosted zone id into `infra/cdk.json` → `context.hostedZoneId`, replacing
   `REPLACE_AFTER_DOMAIN_REGISTRATION`.
2. **GitHub connection.** The CodeConnections ARN in `cdk.json` must be in `AVAILABLE` state:
   AWS console → Developer Tools → Connections → complete the GitHub handshake for
   `jrkphani/GeDe`.
3. **CDK bootstrap** (already done for this account):
   `npx cdk bootstrap aws://975049998516/ap-southeast-1 aws://975049998516/us-east-1 --profile phani-quadnomics`.
   us-east-1 holds the CloudFront certificate and WAF web ACL.
4. **First deploy of the pipeline only:**
   ```bash
   npm ci
   cd infra && npx cdk deploy GeDe-Pipeline --profile phani-quadnomics
   ```
   From here on, every merge to `main` runs the pipeline; it deploys the stage stacks and
   updates itself. Do not `cdk deploy` again.
5. **Confirm the alerts subscription** email sent to `jrkphani@icloud.com` (SNS) and the
   budget notification, otherwise alarms go nowhere.
6. **SES.** The domain identity and DKIM records are created by `GeDe-Prod-Auth`. Request
   production access for SES in ap-southeast-1, then follow the SES switch in `CLAUDE.md`.

## Local checks

```bash
npx tsc -b infra && npx eslint infra --quiet && npm test -w infra
cd infra && npx cdk synth --quiet -c hostedZoneId=Z0000000000000000TEST && npx cdk ls
```
