/**
 * Share mail (DESIGN-SYSTEM §6, "Email"): subject at most 60 characters,
 * front-loaded with the actor; one primary action with the plain link
 * beneath it; reply-to the actor when one exists; never any document content;
 * invitations say they expire in 14 days. Sender is `no-reply@<WEB_ORIGIN host>`.
 *
 * Two templates:
 *   - `share.member` — the address already has an account; the share exists
 *     the moment the mail is sent.
 *   - `share.invite` — no account yet; the link carries the invitation's
 *     token and mentions that sign-in is a passkey or an email code.
 */
import { INVITE_VALID_DAYS } from '../repo/types.js';

export interface Mail {
  readonly to: string;
  readonly from: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Which template produced it, for logs and tests. */
  readonly template: 'share.member' | 'share.invite';
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
}

export const SUBJECT_MAX = 60;

/** The sender for a web origin: `no-reply@gede.work` for `https://gede.work`. */
export function senderFor(webOrigin: string): string {
  return `no-reply@${new URL(webOrigin).hostname}`;
}

function actor(input: Pick<ShareMailInput, 'actorName' | 'actorEmail'>): string {
  return input.actorName ?? input.actorEmail ?? 'Someone';
}

/** Trim a title so the subject fits; the title is the one variable-length part. */
function subjectWithin(prefix: string, title: string, suffix: string): string {
  const room = SUBJECT_MAX - prefix.length - suffix.length;
  const shown = title.length > room ? `${title.slice(0, Math.max(0, room - 1))}…` : title;
  return `${prefix}${shown}${suffix}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function html(body: { heading: string; lines: string[]; action: string; link: string }): string {
  const paragraphs = body.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n');
  const href = escapeHtml(body.link);
  return [
    '<!doctype html>',
    '<html lang="en"><body>',
    `<h1>${escapeHtml(body.heading)}</h1>`,
    paragraphs,
    `<p><a href="${href}">${escapeHtml(body.action)}</a></p>`,
    `<p>${href}</p>`,
    '</body></html>',
  ].join('\n');
}

export function shareMemberMail(input: ShareMailInput): Mail {
  const who = actor(input);
  const subject = subjectWithin(`${who} shared “`, input.documentTitle, '” with you');
  const lines = [
    `${who} shared the workscape “${input.documentTitle}” with you on GeDe.`,
    'Open it with the link below; sign in with your passkey or a code sent to this address.',
  ];
  return {
    to: input.to,
    from: input.from,
    replyTo: input.actorEmail,
    subject,
    template: 'share.member',
    text: [...lines, '', `Open workscape: ${input.link}`].join('\n'),
    html: html({ heading: subject, lines, action: 'Open workscape', link: input.link }),
  };
}

export function shareInviteMail(input: ShareMailInput): Mail {
  const who = actor(input);
  const subject = `${who} invited you to a GeDe workscape`.slice(0, SUBJECT_MAX);
  const lines = [
    `${who} invited you to the workscape “${input.documentTitle}” on GeDe.`,
    `The invitation is valid for ${String(INVITE_VALID_DAYS)} days. Accept it with the link below, then create your account with this address: GeDe signs in with a passkey or a code by email, so there is no password to choose.`,
  ];
  return {
    to: input.to,
    from: input.from,
    replyTo: input.actorEmail,
    subject,
    template: 'share.invite',
    text: [...lines, '', `Accept invitation: ${input.link}`].join('\n'),
    html: html({ heading: subject, lines, action: 'Accept invitation', link: input.link }),
  };
}
