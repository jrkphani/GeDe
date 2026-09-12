import { type Page } from '@playwright/test';
import { computedTokenColor, expect, test } from './fixtures/test.js';

/**
 * DS §1/§2: the dark theme is a token swap that the OS preference switches on
 * (`prefers-color-scheme: dark`) unless the root pins `data-theme="light"`;
 * `theme-color` advertises the surface that is actually painted.
 */

const LIGHT_SURFACE = 'rgb(255, 255, 255)'; // --slate-0
const DARK_SURFACE = 'rgb(15, 26, 21)'; // #0f1a15, the dark --surface

const paintedBackground = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);

/** The theme-color the browser would pick for the current scheme. */
const activeThemeColor = (page: Page) =>
  page.evaluate(() => {
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name=theme-color]'));
    return metas.find((m) => matchMedia(m.media).matches)?.content ?? null;
  });

test.describe('dark', () => {
  test.use({ colorScheme: 'dark' });

  test('DS dark theme A11Y-03 (partial: axe contrast on this screen, dark) under prefers-color-scheme: dark the surface token swaps and the page paints it', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
      true,
    );
    expect(await computedTokenColor(page, '--surface')).toBe(DARK_SURFACE);
    expect(await paintedBackground(page, 'html')).toBe(DARK_SURFACE);
    expect(await paintedBackground(page, '.gd-signin__card')).toBe(DARK_SURFACE);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      'dark',
    );
    // The browser chrome colour matches the painted surface (#0f1a15).
    expect(await activeThemeColor(page)).toBe('#0f1a15');
    await snapshot('sign-in method 1440 dark');
    await checkA11y('sign-in email step 1440 dark');
  });

  test('DS dark theme A11Y-03 (partial: axe contrast on the 404 cell, dark) the 404 cell paints the dark surface too', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/definitely/not/a/route');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing at this address');
    expect(await paintedBackground(page, 'main.gd-error')).toBe(DARK_SURFACE);
    expect(await paintedBackground(page, '.gd-error__cell')).toBe(DARK_SURFACE);
    await checkA11y('error 404 dark');
  });

  test('DS dark theme: data-theme="light" on the root pins the light palette over the OS preference', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    expect(await computedTokenColor(page, '--surface')).toBe(LIGHT_SURFACE);
    expect(await paintedBackground(page, 'html')).toBe(LIGHT_SURFACE);
  });
});

test.describe('light', () => {
  test.use({ colorScheme: 'light' });

  test('DS light theme: the light palette paints white and theme-color says so; data-theme="dark" swaps it', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
    expect(await computedTokenColor(page, '--surface')).toBe(LIGHT_SURFACE);
    expect(await paintedBackground(page, 'html')).toBe(LIGHT_SURFACE);
    expect(await activeThemeColor(page)).toBe('#ffffff');
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    expect(await computedTokenColor(page, '--surface')).toBe(DARK_SURFACE);
    expect(await paintedBackground(page, 'html')).toBe(DARK_SURFACE);
  });
});
