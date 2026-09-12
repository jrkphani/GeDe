/**
 * Command line of the container: no arguments is the server; `--job` selects
 * a one-off task run by EventBridge Scheduler (purge) or an operator
 * (reproject). Kept apart from `main.ts` so it can be tested without booting.
 */
export type Invocation =
  | { kind: 'server' }
  | { kind: 'job'; job: 'purge' }
  | { kind: 'job'; job: 'reproject'; target: string };

/** `--job purge` | `--job reproject <docId|all>`; anything else is the server. Throws on a malformed job. */
export function parseInvocation(argv: readonly string[]): Invocation {
  const at = argv.indexOf('--job');
  if (at < 0) return { kind: 'server' };
  const job = argv[at + 1];
  if (job === 'purge') return { kind: 'job', job };
  if (job === 'reproject') {
    const target = argv[at + 2];
    if (target === undefined || target === '' || target.startsWith('--')) {
      throw new Error('--job reproject needs a document id or "all"');
    }
    return { kind: 'job', job, target };
  }
  throw new Error(`unknown job ${JSON.stringify(job ?? '')}; expected purge or reproject`);
}
