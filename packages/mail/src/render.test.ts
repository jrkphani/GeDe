/**
 * The rendered mail, every kind in every locale: file snapshots (also the source of the
 * PR's screenshots, `scripts/screenshots.mjs`), well-formed HTML, Cognito's placeholder
 * exactly once, the size Cognito accepts, the accent reserved for the code, escaping.
 */
import { describe, expect, test } from 'vitest';

import { palette } from './generated/palette.js';
import { MAIL_LOCALES } from './i18n.js';
import {
  CODE_MAIL_KINDS,
  renderCodeMail,
  renderShareMail,
  SHARE_MAIL_KINDS,
  type RenderedMail,
} from './kinds.js';
import { BRAND_MARK_URL, COLUMN_WIDTH } from './layout.js';

/** Cognito's placeholder for the code (`request.codeParameter`). */
const CODE = '{####}';
/** Cognito refuses an `emailMessage` over this many UTF-8 characters. */
const COGNITO_EMAIL_MAX = 20_000;

const share = {
  to: 'sembian@example.com',
  actorName: 'Meenarapan D',
  actorEmail: 'meena@example.com',
  documentTitle: '1Cloudhub - Workscape',
  link: 'https://gede.work/d/6f1b2c3d-0000-4000-8000-00000000e2e0?invite=abc',
  validDays: 14,
};

function every(): RenderedMail[] {
  const out: RenderedMail[] = [];
  for (const locale of MAIL_LOCALES) {
    for (const kind of CODE_MAIL_KINDS)
      out.push(renderCodeMail(kind, locale, { code: CODE, email: 'sembian@example.com' }));
    for (const kind of SHARE_MAIL_KINDS) out.push(renderShareMail(kind, locale, share));
  }
  return out;
}

const VOID = new Set(['meta', 'img', 'br', 'hr', 'link']);
const ENTITY = /^&(amp|lt|gt|quot|#\d+);/;

/**
 * A strict well-formedness check for the HTML this package writes: every tag closed in
 * order, every attribute quoted, every void element self-closed, no bare `<` or `&` in
 * text. Stricter than any mail client, so a rendering bug fails here first.
 */
function assertWellFormed(html: string): void {
  expect(html.startsWith('<!DOCTYPE html>\n')).toBe(true);
  const stack: string[] = [];
  let i = '<!DOCTYPE html>\n'.length;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === '<') {
      const end = html.indexOf('>', i);
      expect(end, `unclosed tag at ${i}`).toBeGreaterThan(i);
      const tag = html.slice(i + 1, end);
      if (tag.startsWith('/')) {
        expect(stack.pop(), `closing </${tag.slice(1)}>`).toBe(tag.slice(1));
      } else {
        const m = /^([a-z][a-z0-9]*)((?:\s+[a-z-]+="[^"<]*")*)\s*(\/?)$/i.exec(tag);
        expect(m, `malformed tag <${tag}>`).not.toBeNull();
        const name = m![1]!.toLowerCase();
        const selfClosed = m![3] === '/';
        if (VOID.has(name)) expect(selfClosed, `<${name}> must self-close`).toBe(true);
        else if (!selfClosed) stack.push(name);
      }
      i = end + 1;
    } else if (ch === '&') {
      expect(ENTITY.test(html.slice(i, i + 8)), `bare & at ${i}`).toBe(true);
      i += 1;
    } else {
      expect(ch, `bare > at ${i}`).not.toBe('>');
      i += 1;
    }
  }
  expect(stack).toEqual([]);
}

describe('rendered mail', () => {
  for (const mail of every()) {
    test(`I18N-05 ${mail.kind} in ${mail.locale} matches its snapshot`, async () => {
      await expect(mail.html).toMatchFileSnapshot(`__snapshots__/${mail.kind}.${mail.locale}.html`);
      await expect(`Subject: ${mail.subject}\n\n${mail.text}\n`).toMatchFileSnapshot(
        `__snapshots__/${mail.kind}.${mail.locale}.txt`,
      );
    });
  }

  test('every kind in every locale is well-formed HTML with the locale on the root, the dark-mode meta and the 600 px column', () => {
    for (const mail of every()) {
      assertWellFormed(mail.html);
      expect(mail.html).toContain(`<html lang="${mail.locale}" dir="ltr"`);
      expect(mail.html).toContain('<meta name="color-scheme" content="light dark" />');
      expect(mail.html).toContain('<meta name="supported-color-schemes" content="light dark" />');
      expect(mail.html).toContain('@media (prefers-color-scheme: dark)');
      expect(mail.html).toContain(`width="${COLUMN_WIDTH}"`);
      expect(mail.html).toContain(`<img src="${BRAND_MARK_URL}" width="36" height="36"`);
      // Body copy at 16 px; the only web-safe stack is the tokens' UI stack.
      expect(mail.html).toContain('font-size:16px');
      expect(mail.html).toContain(palette.fontUi);
      expect(mail.html).not.toMatch(/@import|<link|fonts\.googleapis/);
    }
  });

  test('AUTH-03 AUTH-04 every code mail carries the placeholder exactly once, in the HTML and in the text, and stays under Cognito’s 20,000 characters', () => {
    for (const mail of every()) {
      const inHtml = mail.html.split(CODE).length - 1;
      const inText = mail.text.split(CODE).length - 1;
      const isCode = (CODE_MAIL_KINDS as readonly string[]).includes(mail.kind);
      expect(inHtml, `${mail.kind} ${mail.locale} html`).toBe(isCode ? 1 : 0);
      expect(inText, `${mail.kind} ${mail.locale} text`).toBe(isCode ? 1 : 0);
      expect(mail.subject).not.toContain(CODE);
      expect(mail.html.length, `${mail.kind} ${mail.locale}`).toBeLessThan(COGNITO_EMAIL_MAX);
    }
  });

  test('DESIGN-SYSTEM §6 the live amber is reserved for the code: once in a code mail, absent from a share mail; one action in a share mail, none in a code mail', () => {
    const accent = new RegExp(palette.colors.light.accent, 'g');
    for (const mail of every()) {
      const isCode = (CODE_MAIL_KINDS as readonly string[]).includes(mail.kind);
      // The inline light value; the dark block names its own accent once more.
      const inline = mail.html.replace(/<style>[\s\S]*?<\/style>/, '');
      expect(inline.match(accent)?.length ?? 0, `${mail.kind} ${mail.locale}`).toBe(isCode ? 1 : 0);
      expect(mail.html.match(/<a /g)?.length ?? 0, `${mail.kind} ${mail.locale}`).toBe(
        isCode ? 0 : 1,
      );
      // The footer says why the mail arrived.
      expect(mail.html).toContain('gd-rule');
      expect(mail.text.trim().length).toBeGreaterThan(0);
    }
  });

  test('SHARE-02 the title, the actor and the link are HTML-escaped in the HTML part and verbatim in the text part (#76 review)', () => {
    const scripted = renderShareMail('share.invite', 'en-US', {
      ...share,
      actorName: 'Eve <script>alert(1)</script>',
      documentTitle: '<b>bold</b> & co',
      link: 'https://gede.work/d/x?invite=a"b',
    });
    expect(scripted.html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; co');
    expect(scripted.html).toContain('Eve &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(scripted.html).toContain('href="https://gede.work/d/x?invite=a&quot;b"');
    expect(scripted.html).not.toContain('<script>');
    expect(scripted.text).toContain('<b>bold</b> & co');
    expect(scripted.text).toContain('Accept invitation: https://gede.work/d/x?invite=a"b');
    assertWellFormed(scripted.html);
  });

  test('SHARE-02 the actor falls back to the address, then to the locale’s “Someone”; the invitation says how long it stands', () => {
    const byAddress = renderShareMail('share.member', 'en-US', { ...share, actorName: null });
    expect(byAddress.subject.startsWith('meena@example.com shared')).toBe(true);
    const nobody = renderShareMail('share.member', 'en-US', {
      ...share,
      actorName: null,
      actorEmail: null,
    });
    expect(nobody.subject.startsWith('Someone shared')).toBe(true);
    const hi = renderShareMail('share.invite', 'hi-IN', {
      ...share,
      actorName: null,
      actorEmail: null,
    });
    expect(hi.subject.startsWith('किसी ने')).toBe(true);
    const invite = renderShareMail('share.invite', 'en-US', share);
    expect(invite.text).toContain('valid for 14 days');
    expect(invite.text).toContain('passkey');
  });
});
