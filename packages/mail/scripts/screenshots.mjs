#!/usr/bin/env node
/**
 * Renders the mail snapshots (`src/__snapshots__/*.html`, written by render.test.ts) with
 * Chromium at the 600 px column, light and dark, into contact sheets under
 * docs/mail-previews/ — the screenshots a PR that touches the templates attaches.
 *
 *   npm run test -w packages/mail          # refresh the snapshots first
 *   node packages/mail/scripts/screenshots.mjs
 *
 * Needs the Playwright browser the e2e suite installs (`npm run e2e:install`). The brand
 * mark is served from the web app's public folder instead of gede.work, so the run is
 * offline. Sheets: every kind in en-US (light, dark) and the sign-in code in the three
 * Indic locales plus en-GB / en-IN (light).
 */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const snapshots = resolve(here, '../src/__snapshots__');
const out = resolve(root, 'docs/mail-previews');
const mark = resolve(root, 'apps/web/public/icon-192.png');

const KINDS = ['signUpCode', 'signInCode', 'emailChangeCode', 'share.member', 'share.invite'];
const SHEETS = [
  { name: 'light', scheme: 'light', mails: KINDS.map((k) => `${k}.en-US`) },
  { name: 'dark', scheme: 'dark', mails: KINDS.map((k) => `${k}.en-US`) },
  {
    name: 'locales',
    scheme: 'light',
    mails: ['ta-IN', 'hi-IN', 'te-IN', 'en-GB', 'en-IN'].map((l) => `signInCode.${l}`),
  },
  {
    name: 'locales-share',
    scheme: 'light',
    mails: ['ta-IN', 'hi-IN', 'te-IN'].map((l) => `share.invite.${l}`),
  },
];

const available = new Set(readdirSync(snapshots).filter((f) => f.endsWith('.html')));

/** One page holding every mail of a sheet in its own iframe, 600 px wide, two per row. */
function sheetHtml(mails) {
  const frames = mails
    .map((id) => {
      const file = `${id}.html`;
      if (!available.has(file)) throw new Error(`no snapshot ${file}`);
      const doc = readFileSync(resolve(snapshots, file), 'utf8');
      return `<figure><figcaption>${id}</figcaption><iframe title="${id}" srcdoc="${doc.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></figure>`;
    })
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#888;font:12px monospace;display:grid;grid-template-columns:repeat(2,640px);gap:24px}
    figure{margin:0}figcaption{color:#fff;margin:0 0 6px}iframe{width:640px;height:760px;border:0;background:transparent}
  </style></head><body>${frames}</body></html>`;
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const sheet of SHEETS) {
    const context = await browser.newContext({
      viewport: { width: 1328, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: sheet.scheme,
    });
    await context.route('https://gede.work/icon-192.png', (route) =>
      route.fulfill({ path: mark, contentType: 'image/png' }),
    );
    const page = await context.newPage();
    await page.setContent(sheetHtml(sheet.mails), { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const file = resolve(out, `${sheet.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.error(`wrote ${file}`);
    await context.close();
  }
} finally {
  await browser.close();
}
