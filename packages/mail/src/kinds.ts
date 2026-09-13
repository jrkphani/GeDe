/**
 * The messages GeDe sends, by kind. Three carry a one-time code from Cognito (the
 * custom-message trigger in infra/assets/custom-message fills `code` with Cognito's
 * `{####}` placeholder); two announce a share from services/sync.
 *
 * The PRD sends nothing else: no welcome mail, no passkey notice, no tour mail.
 */
import { subjectFor, translate, type MailLocale, type MessageParams } from './i18n.js';
import { renderHtml, renderText, type MailContent } from './layout.js';

export const CODE_MAIL_KINDS = ['signUpCode', 'signInCode', 'emailChangeCode'] as const;
export type CodeMailKind = (typeof CODE_MAIL_KINDS)[number];

export const SHARE_MAIL_KINDS = ['share.member', 'share.invite'] as const;
export type ShareMailKind = (typeof SHARE_MAIL_KINDS)[number];

export const MAIL_KINDS = [...CODE_MAIL_KINDS, ...SHARE_MAIL_KINDS] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export interface CodeMailInput {
  /** The code, or the sender's placeholder for it (Cognito: `{####}`). Appears exactly once. */
  readonly code: string;
  /** The recipient, for the "sent to" line; null when the sender does not disclose it. */
  readonly email: string | null;
}

export interface ShareMailInput {
  readonly to: string;
  /** Who shared: their display name, else their address, else the locale's "Someone". */
  readonly actorName: string | null;
  readonly actorEmail: string | null;
  readonly documentTitle: string;
  /** The URL the button opens; also written out in plain text beneath it. */
  readonly link: string;
  /** How long an invitation stands (`share.invite` only). */
  readonly validDays: number;
}

export interface RenderedMail {
  readonly kind: MailKind;
  readonly locale: MailLocale;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function finish(kind: MailKind, content: MailContent): RenderedMail {
  return {
    kind,
    locale: content.locale,
    subject: content.subject,
    html: renderHtml(content),
    text: renderText(content),
  };
}

/**
 * Cognito validates a message template — the pool's own and what the custom-message
 * trigger returns — against `MessageTemplateType`'s pattern, which admits letters, marks,
 * symbols, numbers, punctuation and whitespace only. A format character (`\p{Cf}`: the
 * zero-width non-joiner Telugu uses after a virama in loanwords, U+200C) is none of those
 * and would make Cognito refuse the message, and with it the sign-in. So a code mail
 * drops them; the share mail, sent through SES, keeps the catalogue as written.
 */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
const forCognito = (text: string) => text.replace(FORMAT_CHARACTERS, '');

export function renderCodeMail(
  kind: CodeMailKind,
  locale: MailLocale,
  input: CodeMailInput,
): RenderedMail {
  const t = (suffix: 'subject' | 'heading' | 'body' | 'expires' | 'why') =>
    forCognito(translate(locale, `${kind}.${suffix}`));
  const layout = (key: 'code.label' | 'layout.sentTo' | 'layout.footer', params?: MessageParams) =>
    forCognito(translate(locale, key, params));
  return finish(kind, {
    locale,
    subject: t('subject'),
    preheader: t('body'),
    heading: t('heading'),
    lead: [t('body')],
    code: input.code,
    codeLabel: layout('code.label'),
    trail: [t('expires')],
    why: t('why'),
    sentTo: input.email === null ? null : layout('layout.sentTo', { email: input.email }),
    footer: layout('layout.footer'),
  });
}

export function renderShareMail(
  kind: ShareMailKind,
  locale: MailLocale,
  input: ShareMailInput,
): RenderedMail {
  const actor = input.actorName ?? input.actorEmail ?? translate(locale, 'share.someone');
  const params = { actor, title: input.documentTitle, days: input.validDays };
  const t = (suffix: 'heading' | 'body' | 'next' | 'action' | 'why') =>
    translate(locale, `${kind}.${suffix}`, params);
  return finish(kind, {
    locale,
    subject: subjectFor(locale, `${kind}.subject`, params),
    preheader: t('body'),
    heading: t('heading'),
    lead: [t('body'), t('next')],
    action: { label: t('action'), href: input.link },
    linkFallback: translate(locale, 'layout.linkFallback'),
    trail: [],
    why: t('why'),
    sentTo: translate(locale, 'layout.sentTo', { email: input.to }),
    footer: translate(locale, 'layout.footer'),
  });
}
