import { type Page } from '@playwright/test';
import { computedTokenColor, expect, test } from './fixtures/test.js';

/**
 * The error catalogue (ARCHITECTURE-DIGEST §3): every page names what
 * happened, what it means, one thing to do next, and a copyable reference;
 * 4xx is amber, 5xx is red. Only the 404 has a real route without a backend
 * (`*`); the rest are mounted by the e2e harness (`/e2e/harness/?status=`),
 * which renders the real `ErrorCell` with the real config. Copy below is
 * asserted against the digest, not against the component's own catalogue.
 */

interface Expected {
  name: string;
  tone: 'amber' | 'red';
  kicker: string;
  title: string;
  body: string;
  cta: string;
  alt: string;
  ref: string;
}

const PAGES: Record<number, Expected> = {
  400: {
    name: 'Bad request',
    tone: 'amber',
    kicker: 'request',
    title: 'That link is not a workscape',
    body: 'The address is incomplete or has been altered. If you followed it from an email, the link may have been broken across two lines.',
    cta: 'Go to my workscapes',
    alt: 'Paste the link again',
    ref: 'ref 400·req',
  },
  401: {
    name: 'Unauthenticated',
    tone: 'amber',
    kicker: 'session',
    title: 'Your session ended',
    body: 'You were signed out after a period of inactivity, or from another device. Any edits you had made are held on this device and will sync once you are back.',
    cta: 'Sign in',
    alt: 'Switch account',
    ref: 'ref 401·sess',
  },
  403: {
    name: 'No access',
    tone: 'amber',
    kicker: 'permission',
    title: 'You do not have access to this workscape',
    body: 'It exists, but you are not on its participant list. The owner can add you; requesting access sends them a single message.',
    cta: 'Request access',
    alt: 'Back to my workscapes',
    ref: 'ref 403·wsp',
  },
  404: {
    name: 'Not found',
    tone: 'amber',
    kicker: 'address',
    title: 'Nothing at this address',
    body: 'The workscape may have been deleted by its owner. Anything deleted in the last 30 days can still be recovered from Recently Deleted.',
    cta: 'Open Recently Deleted',
    alt: 'Go to my workscapes',
    ref: 'ref 404·nf',
  },
  429: {
    name: 'Too many requests',
    tone: 'amber',
    kicker: 'throttled',
    title: 'Slow down for a moment',
    body: 'This document received an unusual number of changes in a short time. Editing resumes automatically in a few seconds; nothing has been lost.',
    cta: 'Retry now',
    alt: 'Work offline',
    ref: 'ref 429·rl',
  },
  500: {
    name: 'Server error',
    tone: 'red',
    kicker: 'server',
    title: 'Something failed on our side',
    body: 'Your edits are safe on this device and will sync when the service recovers. The failure has been reported automatically with the reference below.',
    cta: 'Retry',
    alt: 'Go to my workscapes',
    ref: 'ref 500·7fd1e9',
  },
  503: {
    name: 'Unavailable',
    tone: 'red',
    kicker: 'maintenance',
    title: 'GeDe is updating',
    body: 'A new version is rolling out. This usually takes under two minutes. This page checks for you and will continue on its own.',
    cta: 'Check now',
    alt: 'Go to status page',
    ref: 'ref 503·dep',
  },
  504: {
    name: 'Timeout',
    tone: 'red',
    kicker: 'timeout',
    title: 'This is taking longer than expected',
    body: 'The document is large or the service is busy. The request is still being attempted in the background; you can keep working offline in the meantime.',
    cta: 'Keep waiting',
    alt: 'Work offline',
    ref: 'ref 504·tmo',
  },
};

/** 500 appends the first six characters of the server request id to its reference. */
const harnessUrl = (status: number) =>
  status === 500
    ? `/e2e/harness/?status=500&requestId=7fd1e9ab-0000-4000-8000-000000000000&attempts=4`
    : `/e2e/harness/?status=${status}`;

const HEALTH_URL = 'https://gede.work/api/health';

const errorPage = (page: Page) => ({
  main: page.getByRole('main'),
  cell: page.locator('.gd-error__cell'),
  rowRuler: page.locator('.gd-error__row--code'),
  code: page.locator('.gd-error__code'),
  kicker: page.locator('.gd-error__kicker'),
  title: page.getByRole('heading', { level: 1 }),
  body: page.locator('.gd-error__body'),
  meta: page.locator('.gd-error__meta'),
  ref: page.locator('button.gd-error__ref'),
  live: page.getByTestId('live-region'),
});

for (const [statusText, expected] of Object.entries(PAGES)) {
  const status = Number(statusText);
  test(`A11Y-04 A11Y-05 ${status} error page: catalogue copy, ${expected.tone} rule in words and colour, copyable ref`, async ({
    page,
    checkA11y,
  }) => {
    // No page under test may reach the network: the harness is static and the API is stubbed.
    await page.route(HEALTH_URL, (route) => route.fulfill({ status: 503, body: '' }));
    await page.goto(harnessUrl(status));
    const e = errorPage(page);

    // The status code sits in the row ruler where a row number would be.
    await expect(e.rowRuler).toHaveText(String(status));
    await expect(e.code).toHaveText(`${status} · ${expected.name}`);
    await expect(e.kicker).toHaveText(expected.kicker);
    await expect(e.title).toHaveText(expected.title);
    await expect(e.body).toHaveText(expected.body);
    await expect(page.getByRole('button', { name: expected.cta, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: expected.alt, exact: true })).toBeVisible();

    // 4xx amber, 5xx red; the card's top rule carries the colour (never hue alone: the
    // code and kicker say the severity in words as well).
    const token = expected.tone === 'amber' ? '--warning' : '--danger';
    const toneColor = await computedTokenColor(page, token);
    await expect(e.main).toHaveClass(
      new RegExp(`gd-error--sev${expected.tone === 'amber' ? 4 : 5}`),
    );
    const topRule = await e.cell.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.borderTopColor, width: cs.borderTopWidth };
    });
    expect(topRule).toEqual({ color: toneColor, width: '3px' });

    // The reference is a button that copies itself.
    await expect(e.ref).toHaveText(expected.ref);
    await e.ref.click();
    await expect(e.live).toHaveText('Reference copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected.ref);

    await checkA11y(`error ${status}`);
  });
}

test('ARCHITECTURE §3 A11Y-05 404 an unknown address renders the not-found cell from the real router, inside the shell, and announces the copied reference', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/no/such/workscape');
  const e = errorPage(page);
  await expect(e.rowRuler).toHaveText('404');
  await expect(e.title).toHaveText(PAGES[404]!.title);
  await expect(e.ref).toHaveText(PAGES[404]!.ref);
  // The live region is the shell's, present before anything is announced (#48).
  await expect(e.live).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('[aria-live], [role=status], [role=alert]')).toHaveCount(1);
  await e.ref.click();
  await expect(e.live).toHaveText('Reference copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PAGES[404]!.ref);
  await checkA11y('error 404 via router');
});

/** Every focusable on the card, by accessible name, with its box. */
async function measureTargets(page: Page): Promise<{ name: string; w: number; h: number }[]> {
  const handles = await page
    .locator('main button, main a[href], main input, main [tabindex]:not([tabindex="-1"])')
    .all();
  const out: { name: string; w: number; h: number }[] = [];
  for (const h of handles) {
    if (!(await h.isVisible())) continue;
    const box = (await h.boundingBox())!;
    const name = (await h.getAttribute('aria-label')) ?? (await h.innerText());
    out.push({
      name: name.trim(),
      w: Math.round(box.width * 10) / 10,
      h: Math.round(box.height * 10) / 10,
    });
  }
  return out;
}

for (const width of [480, 768] as const) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`RESP-05 at ${width} px every target on every error page, the ref button included, is at least 44 × 44 px`, async ({
      page,
      snapshot,
    }) => {
      await page.route(HEALTH_URL, (route) => route.fulfill({ status: 503, body: '' }));
      const short: string[] = [];
      const urls = [
        ...Object.keys(PAGES).map((s) => [Number(s), harnessUrl(Number(s))] as const),
        [404, '/no/such/workscape'] as const,
      ];
      for (const [status, url] of urls) {
        await page.goto(url);
        await expect(errorPage(page).rowRuler).toHaveText(String(status));
        if (url.startsWith('/no/')) await snapshot(`error 404 ${width}`);
        for (const t of await measureTargets(page)) {
          if (t.w < 44 || t.h < 44) short.push(`${status} "${t.name}" ${t.w}×${t.h}`);
        }
      }
      expect(short, `targets under 44 × 44 px at ${width}px`).toEqual([]);
    });
  });
}

test('DS §3 at 1440 px the reference button is a 32 px target, not a 22 px chip', async ({
  page,
}) => {
  await page.goto('/no/such/workscape');
  const box = (await errorPage(page).ref.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(32);
});

test('ARCHITECTURE §3 503 polls /api/health every 15 s and continues on its own once the API answers 2xx', async ({
  page,
}) => {
  // Two answers at the network boundary: still deploying, then back.
  const answers = [503, 200];
  const seen: number[] = [];
  await page.route(HEALTH_URL, (route) => {
    const status = answers.shift() ?? 200;
    seen.push(status);
    return route.fulfill({ status, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.clock.install();
  await page.goto(harnessUrl(503));
  const e = errorPage(page);
  await expect(e.meta).toHaveText('polling · 15s');
  expect(seen).toEqual([]);

  await page.clock.runFor(15_000);
  await expect.poll(() => seen).toEqual([503]);
  await expect(e.title).toHaveText(PAGES[503]!.title);

  // A 2xx answer reloads the page: the document continues on its own.
  const reloaded = page.waitForEvent('load');
  await page.clock.runFor(15_000);
  await expect.poll(() => seen).toEqual([503, 200]);
  await reloaded;
});

test('ARCHITECTURE §3 503 Check now shortcuts the next poll', async ({ page }) => {
  const seen: number[] = [];
  await page.route(HEALTH_URL, (route) => {
    seen.push(503);
    return route.fulfill({ status: 503, body: '' });
  });
  await page.goto(harnessUrl(503));
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect.poll(() => seen).toEqual([503]);
  // Still updating: the page stays, nothing reloads.
  await expect(errorPage(page).title).toHaveText(PAGES[503]!.title);
  // No status page is configured, so its button is disabled with a reason rather than hidden.
  const statusPage = page.getByRole('button', { name: 'Go to status page' });
  await expect(statusPage).toBeDisabled();
  await expect(statusPage).toHaveAttribute('title', 'No status page is configured');
});

test('ARCHITECTURE §3 400 Paste the link again validates before it navigates', async ({ page }) => {
  await page.goto(harnessUrl(400));
  await page.getByRole('button', { name: 'Paste the link again' }).click();
  const link = page.getByLabel('Workscape link');
  await expect(link).toBeFocused();
  const open = page.getByRole('button', { name: 'Open' });
  await expect(open).toBeDisabled();
  await link.fill('https://elsewhere.example/d/01J8Z2Q5X0Y3K7N4M6P9R2S5T8');
  await open.click();
  await expect(page.getByText('That is not a GeDe workscape link')).toBeVisible();
  await expect(page).toHaveURL(/\/e2e\/harness\//);
});
