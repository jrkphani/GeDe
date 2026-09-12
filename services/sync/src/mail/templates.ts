/**
 * Share mail (DESIGN-SYSTEM §6, "Email"): rendered by `@gede/mail` — the branded layout
 * and the six-locale catalogue every GeDe mail shares — in the recipient's locale.
 * Subject at most 60 characters, front-loaded with the actor; one primary action with
 * the plain link beneath it; reply-to the actor when one exists; never any document
 * content; invitations say they expire in 14 days. Sender is `no-reply@<WEB_ORIGIN host>`.
 *
 * Two templates:
 *   - `share.member` — the address already has an account; the share exists
 *     the moment the mail is sent. Locale: the member's own, else the sharer's.
 *   - `share.invite` — no account yet; the link carries the invitation's
 *     token and mentions that sign-in is a passkey or an email code. Locale:
 *     the inviter's (the address has no account to ask).
 */
import { renderShareMail, resolveMailLocale, SUBJECT_MAX, type ShareMailKind } from '@gede/mail';

import { INVITE_VALID_DAYS } from '../repo/types.js';

export { SUBJECT_MAX };

export interface Mail {
  readonly to: string;
  readonly from: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Which template produced it, for logs and tests. */
  readonly template: ShareMailKind;
}

export interface ShareMailInput {
  readonly to: string;
  readonly from: string;
  /** Who shared: their display name, else their address, else "Someone". */
  readonly actorName: string | null;
  readonly actorEmail: string | null;
  readonly documentTitle: string;
  /** The URL the button and the plain link open. */
  readonly link: string;
  /**
   * The recipient's locale (I18N-05): the invitee's `users.locale` when the address has
   * an account, else the inviter's; null or unknown renders en-US.
   */
  readonly locale: string | null;
}

/** The sender for a web origin: `no-reply@gede.work` for `https://gede.work`. */
export function senderFor(webOrigin: string): string {
  return `no-reply@${new URL(webOrigin).hostname}`;
}

function shareMail(kind: ShareMailKind, input: ShareMailInput): Mail {
  const rendered = renderShareMail(kind, resolveMailLocale(input.locale), {
    to: input.to,
    actorName: input.actorName,
    actorEmail: input.actorEmail,
    documentTitle: input.documentTitle,
    link: input.link,
    validDays: INVITE_VALID_DAYS,
  });
  return {
    to: input.to,
    from: input.from,
    replyTo: input.actorEmail,
    subject: rendered.subject,
    template: kind,
    text: rendered.text,
    html: rendered.html,
  };
}

export function shareMemberMail(input: ShareMailInput): Mail {
  return shareMail('share.member', input);
}

export function shareInviteMail(input: ShareMailInput): Mail {
  return shareMail('share.invite', input);
}
