/**
 * The one email layout (DESIGN-SYSTEM §6 "Email"): a 600 px column on the sunken surface,
 * one white card with the brand lockup, a heading, body copy at 16 px, then either the
 * one-time code — the only thing in the live amber — or the one primary action with the
 * plain link beneath it, and a footer that says why the mail arrived.
 *
 * Every colour, radius and font comes from `generated/palette.ts` (derived from
 * packages/tokens at generation time); nothing here is written by hand. Styles are inline
 * for the clients that drop `<style>`, and the `<style>` block carries the dark swap for
 * the clients that honour `prefers-color-scheme` (Apple Mail, iOS Mail, Outlook for Mac).
 * Table layout, no flex, no grid, no web fonts: what renders everywhere.
 */
import { escapeHtml } from './escape.js';
import { palette, type ColorScheme } from './generated/palette.js';
import type { MailLocale } from './i18n.js';

/** The brand mark as the web app ships it (apps/web/public); a hosted image, not a data URI, so Gmail shows it. */
export const BRAND_MARK_URL = 'https://gede.work/icon-192.png';
export const BRAND_MARK_SIZE = 36;
export const COLUMN_WIDTH = 600;

export interface MailAction {
  readonly label: string;
  readonly href: string;
}

/** What one message says, independent of kind and locale; `renderHtml` / `renderText` lay it out. */
export interface MailContent {
  readonly locale: MailLocale;
  readonly subject: string;
  /** The inbox preview line; not shown in the body. */
  readonly preheader: string;
  readonly heading: string;
  /** Paragraphs before the code or the action. */
  readonly lead: readonly string[];
  /** A one-time code (or Cognito's `{####}` placeholder); exactly one of `code` / `action`. */
  readonly code?: string;
  readonly codeLabel?: string;
  readonly action?: MailAction;
  /** Introduces the plain link under the button. */
  readonly linkFallback?: string;
  /** Paragraphs after the code or the action (expiry, what happens next). */
  readonly trail: readonly string[];
  /** Why the recipient got this mail. */
  readonly why: string;
  /** "This email was sent to …", when the address is known. */
  readonly sentTo: string | null;
  readonly footer: string;
}

const c = (scheme: ColorScheme) => palette.colors[scheme];

/** Styles that carry a colour, keyed by class so the dark block can override them. */
function colourStyles(scheme: ColorScheme): Record<string, string> {
  const k = c(scheme);
  return {
    'gd-bg': `background-color:${k.surfaceSunken};`,
    'gd-card': `background-color:${k.surface};border:1px solid ${k.border};`,
    'gd-ink': `color:${k.ink};`,
    'gd-muted': `color:${k.inkMuted};`,
    'gd-link': `color:${k.link};`,
    'gd-code': `background-color:${k.accentSubtle};border:1px solid ${k.border};color:${k.accent};`,
    'gd-btn': `background-color:${k.actionBg};color:${k.actionFg};`,
    'gd-rule': `border-top:1px solid ${k.border};`,
  };
}

/** The dark swap, for clients that honour it; `!important` beats the inline light values. */
function darkStyleBlock(): string {
  const rules = Object.entries(colourStyles('dark'))
    .map(
      ([cls, style]) =>
        `.${cls}{${style
          .split(';')
          .filter((d) => d !== '')
          .map((d) => `${d} !important`)
          .join(';')}}`,
    )
    .join('');
  return `@media (prefers-color-scheme: dark){${rules}}`;
}

const light = colourStyles('light');
const type = {
  body: `font-family:${palette.fontUi};font-size:16px;line-height:1.6;`,
  heading: `font-family:${palette.fontUi};font-size:22px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;`,
  wordmark: `font-family:${palette.fontUi};font-size:20px;line-height:1;font-weight:600;letter-spacing:-0.035em;`,
  code: `font-family:${palette.fontMono};font-size:32px;line-height:1.3;font-weight:600;letter-spacing:0.18em;`,
  label: `font-family:${palette.fontUi};font-size:14px;line-height:1.5;font-weight:500;letter-spacing:0.02em;`,
  small: `font-family:${palette.fontUi};font-size:14px;line-height:1.5;`,
};

function p(cls: 'gd-ink' | 'gd-muted', text: string): string {
  return `<p class="${cls}" style="margin:0 0 16px 0;${type.body}${light[cls]}">${escapeHtml(text)}</p>`;
}

function codeBlock(code: string, label: string | undefined): string {
  return [
    label === undefined
      ? ''
      : `<p class="gd-muted" style="margin:0 0 8px 0;${type.label}${light['gd-muted']}">${escapeHtml(label)}</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">`,
    '<tr>',
    `<td class="gd-code" style="padding:16px 24px;border-radius:${palette.radiusMd};${type.code}${light['gd-code']}">${escapeHtml(code)}</td>`,
    '</tr>',
    '</table>',
  ].join('');
}

function actionBlock(action: MailAction, linkFallback: string | undefined): string {
  const href = escapeHtml(action.href);
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">`,
    '<tr>',
    `<td class="gd-btn" style="border-radius:${palette.radiusMd};${light['gd-btn']}">`,
    `<a class="gd-btn" href="${href}" style="display:inline-block;padding:12px 20px;border-radius:${palette.radiusMd};${type.body}font-weight:600;text-decoration:none;${light['gd-btn']}">${escapeHtml(action.label)}</a>`,
    '</td>',
    '</tr>',
    '</table>',
    linkFallback === undefined
      ? ''
      : `<p class="gd-muted" style="margin:0 0 4px 0;${type.small}${light['gd-muted']}">${escapeHtml(linkFallback)}</p>`,
    `<p class="gd-link" style="margin:0 0 24px 0;${type.small}word-break:break-all;${light['gd-link']}">${href}</p>`,
  ].join('');
}

export function renderHtml(content: MailContent): string {
  const middle =
    content.code !== undefined
      ? codeBlock(content.code, content.codeLabel)
      : content.action !== undefined
        ? actionBlock(content.action, content.linkFallback)
        : '';
  const lines = [
    '<!DOCTYPE html>',
    `<html lang="${content.locale}" dir="ltr" xmlns="http://www.w3.org/1999/xhtml">`,
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="color-scheme" content="light dark" />',
    '<meta name="supported-color-schemes" content="light dark" />',
    `<title>${escapeHtml(content.subject)}</title>`,
    `<style>${darkStyleBlock()}</style>`,
    '</head>',
    `<body class="gd-bg" style="margin:0;padding:0;${light['gd-bg']}">`,
    // Preview text: read by the inbox list, invisible in the body.
    `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:transparent;">${escapeHtml(content.preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="gd-bg" style="${light['gd-bg']}">`,
    '<tr>',
    '<td align="center" style="padding:32px 16px;">',
    `<table role="presentation" width="${COLUMN_WIDTH}" cellpadding="0" cellspacing="0" border="0" class="gd-card" style="width:${COLUMN_WIDTH}px;max-width:100%;border-radius:${palette.radiusLg};${light['gd-card']}">`,
    '<tr>',
    '<td style="padding:32px 40px 8px 40px;">',
    // Brand lockup: the mark and the wordmark, the one place Title Case lives.
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    '<tr>',
    `<td style="padding:0 12px 0 0;vertical-align:middle;"><img src="${BRAND_MARK_URL}" width="${BRAND_MARK_SIZE}" height="${BRAND_MARK_SIZE}" alt="" style="display:block;border:0;border-radius:${palette.radiusMd};" /></td>`,
    `<td class="gd-ink" style="vertical-align:middle;${type.wordmark}${light['gd-ink']}">GeDe</td>`,
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '<tr>',
    '<td style="padding:24px 40px 8px 40px;">',
    `<h1 class="gd-ink" style="margin:0 0 16px 0;${type.heading}${light['gd-ink']}">${escapeHtml(content.heading)}</h1>`,
    ...content.lead.map((text) => p('gd-ink', text)),
    middle,
    ...content.trail.map((text) => p('gd-ink', text)),
    '</td>',
    '</tr>',
    '<tr>',
    `<td class="gd-rule" style="padding:16px 40px 32px 40px;${light['gd-rule']}">`,
    `<p class="gd-muted" style="margin:0 0 8px 0;${type.small}${light['gd-muted']}">${escapeHtml(content.why)}</p>`,
    content.sentTo === null
      ? ''
      : `<p class="gd-muted" style="margin:0 0 8px 0;${type.small}${light['gd-muted']}">${escapeHtml(content.sentTo)}</p>`,
    `<p class="gd-muted" style="margin:0;${type.small}${light['gd-muted']}">${escapeHtml(content.footer)}</p>`,
    '</td>',
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '</table>',
    '</body>',
    '</html>',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

export function renderText(content: MailContent): string {
  const lines: string[] = [content.heading, '', ...content.lead];
  if (content.code !== undefined) {
    lines.push(
      '',
      content.codeLabel === undefined ? content.code : `${content.codeLabel}: ${content.code}`,
      '',
    );
  } else if (content.action !== undefined) {
    lines.push('', `${content.action.label}: ${content.action.href}`, '');
  }
  lines.push(...content.trail, '', content.why);
  if (content.sentTo !== null) lines.push(content.sentTo);
  lines.push(content.footer);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
