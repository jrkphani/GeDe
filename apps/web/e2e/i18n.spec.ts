import { type Page } from '@playwright/test';
import { expect, test } from './fixtures/test.js';

/**
 * I18N-03: with an Indic `lang` on the root, every text run is laid out at a
 * line-height of 1.7 or more — including the components that set their own
 * tighter value in the Latin default (buttons 1.2, headings 1.15, body 1.6).
 * Measured from computed style in the real cascade, on screens reachable
 * without a session; grid cells are exempt by the DS and have no route here.
 */

const INDIC = ['ta-IN', 'hi-IN', 'te-IN'] as const;

/** Every element in `main` that has text of its own, with its line-height ratio. */
async function lineHeightRatios(page: Page): Promise<{ el: string; ratio: number }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('main *'))
      .filter((el) =>
        Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent?.trim() ?? '') !== '',
        ),
      )
      .map((el) => {
        const cs = getComputedStyle(el);
        const ratio = parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
        return {
          el: `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 24)}"`,
          ratio: Math.round(ratio * 100) / 100,
        };
      }),
  );
}

const setLang = (page: Page, lang: string) =>
  page.evaluate((l) => {
    document.documentElement.lang = l;
  }, lang);

for (const lang of INDIC) {
  test(`I18N-03 under ${lang} every text run on the sign-in screen is at line-height 1.7 or more, buttons and headings included`, async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('someone@example.com');
    await page.getByLabel('Email').press('Enter');
    await expect(page.getByRole('button', { name: 'Passkey' })).toBeVisible();

    // Latin default first: the button label is deliberately tighter than 1.7.
    const latin = await lineHeightRatios(page);
    expect(latin.find((r) => r.el.startsWith('span.gd-btn__label'))?.ratio).toBeLessThan(1.7);

    await setLang(page, lang);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang);
    const ratios = await lineHeightRatios(page);
    expect(ratios.length).toBeGreaterThan(8);
    const tight = ratios.filter((r) => r.ratio < 1.7);
    expect(tight, `elements under 1.7 with lang=${lang}`).toEqual([]);
    // The specific runs the audit measured at 1.2 and 1.6 (#50).
    for (const prefix of ['span.gd-btn__label', 'h1.gd-signin__title', 'span.gd-signin__email'])
      expect(ratios.find((r) => r.el.startsWith(prefix))?.ratio).toBeGreaterThanOrEqual(1.7);
  });
}

test('I18N-03 under ta-IN the error cell heading and body reach 1.7 as well', async ({ page }) => {
  await page.goto('/no/such/workscape');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing at this address');
  await setLang(page, 'ta-IN');
  const ratios = await lineHeightRatios(page);
  const tight = ratios.filter((r) => r.ratio < 1.7);
  expect(tight).toEqual([]);
  expect(ratios.find((r) => r.el.startsWith('h1.gd-error__title'))?.ratio).toBeGreaterThanOrEqual(
    1.7,
  );
});

test('I18N-03 the Latin default is untouched: lang=en-US keeps the design-system scale', async ({
  page,
}) => {
  await page.goto('/no/such/workscape');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing at this address');
  const ratios = await lineHeightRatios(page);
  expect(ratios.find((r) => r.el.startsWith('h1.gd-error__title'))?.ratio).toBe(1.15);
  expect(ratios.find((r) => r.el.startsWith('p.gd-error__body'))?.ratio).toBe(1.6);
});
