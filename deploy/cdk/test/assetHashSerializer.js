/**
 * Normalizes CloudFormation asset S3Keys inside stack snapshots.
 *
 * A bundled Lambda's asset key is `<sha256-of-the-bundle>.zip` — BUILD OUTPUT,
 * not template structure. It changes whenever any handler's source changes, so
 * an unrelated product PR that edits `src/server/writeApi/handler.ts` fails the
 * ApiStack snapshot for a reason that has nothing to do with the template.
 *
 * That is not merely noisy, it is unmergeable in sequence: two open PRs that
 * each touch bundled Lambda source produce two different hashes, so whichever
 * merges second carries a snapshot computed before the first landed — and main
 * goes red on a file neither PR meaningfully changed. Refreshing per-PR cannot
 * fix that; the hash has to stop being part of the contract.
 *
 * What the snapshot still guards is everything that actually describes the
 * infrastructure: resources, properties, IAM, wiring, env vars, tags. That a
 * bundle was produced at all is already proven by `cdk synth` succeeding, and
 * its CONTENT is covered by the handler's own unit tests.
 *
 * Plain CommonJS on purpose: Jest loads `snapshotSerializers` modules and reads
 * `.test`/`.serialize` off the export directly, so a TS `export default` (which
 * ts-jest emits as `exports.default`) fails with "plugins[p].test is not a
 * function".
 */
const ASSET_KEY = /^[0-9a-f]{64}\.zip$/;

module.exports = {
  test: (value) => typeof value === 'string' && ASSET_KEY.test(value),
  serialize: () => '"[ASSET_HASH].zip"',
};
