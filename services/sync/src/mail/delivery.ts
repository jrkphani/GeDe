/**
 * What became of a share mail, as the API reports it (#121). The row a mail
 * announces — a share, an invitation — is written before the mail goes out
 * and stands whatever the send did: the mail is the notification, not the
 * grant. So a refused send (SES in the sandbox: unverified recipient; a
 * throttle; an outage) is answered, never rolled back, and the sender is told
 * so they can share the link another way or resend.
 *
 *   - `sent`    — SES accepted the message.
 *   - `failed`  — SES refused it; the row stands, Resend is offered.
 *   - `skipped` — nothing was sent: a repeated invitation for an address whose
 *                 invitation already stands (idempotent POST).
 */
import type { Logger } from '../logger.js';
import type { Mail } from './templates.js';

export type MailDelivery = 'sent' | 'failed' | 'skipped';

/**
 * The `GeDe/Sync` metric a refused share mail counts on, dimensioned by the
 * template that failed — one datapoint per refused send, so the sandbox (or a
 * later outage) shows on the dashboard rather than only in the log stream.
 *
 * TODO(#119): fold into `metrics.ts` `count()` once it is on main; this is the
 * same CloudWatch embedded-metric-format envelope, written here so the
 * metric exists before that PR merges.
 */
export const INVITE_MAIL_FAILURES = 'InviteMailFailures';

export function mailFailureLine(template: Mail['template'], at = Date.now()) {
  return {
    _aws: {
      Timestamp: at,
      CloudWatchMetrics: [
        {
          Namespace: 'GeDe/Sync',
          Dimensions: [['Reason']],
          Metrics: [{ Name: INVITE_MAIL_FAILURES, Unit: 'Count' as const }],
        },
      ],
    },
    Reason: template,
    [INVITE_MAIL_FAILURES]: 1,
  };
}

/** SES error messages name the recipient; the log line carries the class of failure only. */
export function mailFailure(error: unknown): { errName: string; errCode?: string } {
  const errCode =
    typeof error === 'object' && error !== null && 'Code' in error ? String(error.Code) : undefined;
  return {
    errName: error instanceof Error ? error.name : typeof error,
    ...(errCode !== undefined && { errCode }),
  };
}

/**
 * Send one share mail and report the outcome. Never throws: a refused send is
 * logged (template, failure class and the request ref — never the address),
 * counted on `InviteMailFailures`, and answered as `failed`.
 */
export async function deliver(
  send: (mail: Mail) => Promise<void>,
  mail: Mail,
  log: Pick<Logger, 'warn'>,
  context: { documentId: string; ref: string },
): Promise<MailDelivery> {
  try {
    await send(mail);
    return 'sent';
  } catch (error) {
    log.warn(
      {
        ...mailFailure(error),
        ...mailFailureLine(mail.template),
        template: mail.template,
        ...context,
      },
      `${mail.template} mail not sent; the ${mail.template === 'share.invite' ? 'invitation' : 'share'} stands`,
    );
    return 'failed';
  }
}
