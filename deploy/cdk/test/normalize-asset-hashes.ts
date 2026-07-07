/**
 * Defense-in-depth for issue 041.
 *
 * The primary fix is the injectable `HostingStack.siteSourcePath` (tests pin
 * the committed placeholder explicitly, so `BucketDeployment`'s asset hash
 * never depends on the ambient `dist/`). This helper is belt-and-suspenders
 * on top of that: it normalizes *any* CDK asset hash (the 64-hex-char SHA256
 * CDK derives from an asset's content, e.g. an S3 object key
 * `<hash>.zip`) to a stable token before a snapshot assertion, so a *future*
 * asset-bearing construct (another `BucketDeployment`, a `lambda.Code.fromAsset`,
 * the `BucketDeployment` custom-resource handler's own code asset, etc.)
 * can never reintroduce a machine/content-dependent value into a committed
 * snapshot without the test author needing to remember why.
 *
 * Deep-clones `value` via JSON round-trip and replaces every run of 64 hex
 * characters (CDK's asset-hash format) with `<ASSET_HASH>` wherever it
 * appears — as an S3 key (`<hash>.zip`), inside a logical ID, etc.
 */
const ASSET_HASH_RE = /[0-9a-f]{64}/g;

export function normalizeAssetHashes<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(ASSET_HASH_RE, '<ASSET_HASH>')) as T;
}
