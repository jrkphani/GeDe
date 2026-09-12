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
import { count } from '../metrics.js';
import type { Mail } from './templates.js';

export type MailDelivery = 'sent' | 'failed' | 'skipped';

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
 * counted on the `GeDe/Sync InviteMailFailures` metric (EMF, `Reason` = the
 * template), and answered as `failed`.
 */
export async function deliver(
  send: (mail: Mail) => Promise<void>,
  mail: Mail,
  log: Pick<Logger, 'info'>,
  context: { documentId: string; ref: string },
): Promise<MailDelivery> {
  try {
    await send(mail);
    return 'sent';
  } catch (error) {
    count(
      log,
      'InviteMailFailures',
      mail.template,
      { ...mailFailure(error), template: mail.template, ...context },
      `${mail.template} mail not sent; the ${mail.template === 'share.invite' ? 'invitation' : 'share'} stands`,
    );
    return 'failed';
  }
}
