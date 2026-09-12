import { type Locator, type Page } from '@playwright/test';
import {
  BREAKPOINTS,
  expect,
  expectNoHorizontalOverflow,
  test,
  zoomed200,
} from './fixtures/test.js';

/**
 * The sign-in screen at every design-system breakpoint (480, 768, 1024, 1440)
 * and at 200 % zoom at each of them (A11Y-06). Zoom is emulated the way
 * Chromium implements it — half the CSS viewport, double the device scale
 * factor — see `zoomed200` in fixtures/test.ts.
 */

const VALID_EMAIL = 'someone@example.com';

async function assertSignInLayout(page: Page, label: string) {
  await page.goto('/sign-in');
  const heading = page.getByRole('heading', { level: 1 });
  const modes = page.getByRole('radiogroup', { name: 'Sign in or create account' });
  const email = page.getByLabel('Email');
  const continueButton = page.getByRole('button', { name: 'Continue' });

  await expect(heading).toBeVisible();
  await expect(modes).toBeVisible();
  await expect(email).toBeVisible();
  await expect(continueButton).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The card never exceeds the viewport width, so nothing is clipped at any size.
  const viewport = page.viewportSize()!;
  for (const [name, locator] of [
    ['heading', heading],
    ['modes', modes],
    ['email', email],
    ['continue', continueButton],
  ] as const) {
    const box = (await locator.boundingBox())!;
    expect(box.x, `${name} starts inside the viewport (${label})`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${name} ends inside the viewport (${label})`).toBeLessThanOrEqual(
      viewport.width + 0.5,
    );
  }

  // Method step: passkey above the code option, both visible, still no overflow.
  await email.fill(VALID_EMAIL);
  await email.press('Enter');
  const passkey = page.getByRole('button', { name: 'Passkey' });
  const code = page.getByRole('button', { name: 'Email me a one-time code' });
  await expect(passkey).toBeVisible();
  await expect(code).toBeVisible();
  const passkeyBox = (await passkey.boundingBox())!;
  const codeBox = (await code.boundingBox())!;
  expect(passkeyBox.y + passkeyBox.height).toBeLessThanOrEqual(codeBox.y);
  await expectNoHorizontalOverflow(page);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
}

for (const width of BREAKPOINTS) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`A11Y-06 sign-in renders at ${width} px with no clipping or horizontal scroll`, async ({
      page,
      checkA11y,
      snapshot,
    }) => {
      await assertSignInLayout(page, `${width}px`);
      await snapshot(`sign-in method ${width}`);
      await checkA11y(`sign-in method step ${width}`);
    });

    if (width < 1024) {
      test(`RESP-05 below 1024 px every sign-in target is at least 44 px tall at ${width} px`, async ({
        page,
      }) => {
        // Below 1024 px every control in @gede/ui grows to `--hit-target` (44 px), including
        // the segmented control, the field, the ghost Change button and the method buttons.
        await page.goto('/sign-in');
        const email = page.getByLabel('Email');
        await email.fill(VALID_EMAIL);
        const short: string[] = [];
        const measure = async (name: string, locator: Locator) => {
          const box = (await locator.boundingBox())!;
          if (box.height < 44 || box.width < 44) short.push(`${name} ${box.width}×${box.height}`);
        };
        await measure('Sign in segment', page.getByRole('radio', { name: 'Sign in' }));
        await measure(
          'Create account segment',
          page.getByRole('radio', { name: 'Create account' }),
        );
        await measure('Email', email);
        await measure('Continue', page.getByRole('button', { name: 'Continue' }));
        await email.press('Enter');
        for (const name of ['Change', 'Passkey', 'Email me a one-time code']) {
          await measure(name, page.getByRole('button', { name }));
        }
        expect(short, `targets under 44 × 44 px at ${width}px`).toEqual([]);
      });
    }
  });

  test.describe(`${width} px at 200 % zoom`, () => {
    test.use(zoomed200(width));

    test(`A11Y-06 sign-in holds at 200 % zoom on a ${width} px window with no loss of content`, async ({
      page,
      checkA11y,
      snapshot,
    }) => {
      // Sanity: the emulation really is 200 % — CSS px halve, physical px double.
      expect(page.viewportSize()).toEqual({ width: width / 2, height: 450 });
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
      await assertSignInLayout(page, `${width}px @200%`);
      await snapshot(`sign-in method ${width} zoom200`);
      await checkA11y(`sign-in method step ${width} zoom200`);
    });

    test(`A11Y-06 no label is truncated at 200 % zoom on a ${width} px window`, async ({
      page,
    }) => {
      // 480 px at 200 % is 240 CSS px, below WCAG 1.4.10's 320 px reflow floor, but the
      // design system's definition of done asks for 200 % at 480: `.gd-signin__who` wraps
      // so the Change button keeps its whole label.
      await page.goto('/sign-in');
      const email = page.getByLabel('Email');
      await email.fill(VALID_EMAIL);
      await email.press('Enter');
      await expect(page.getByRole('button', { name: 'Passkey' })).toBeVisible();
      // Any box that hides overflowing text (ellipsis or clip) with more text than room.
      const clipped = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('main *'))
          .filter((el) => {
            const cs = getComputedStyle(el);
            return (
              (cs.overflowX === 'hidden' || cs.overflowX === 'clip') &&
              el.scrollWidth > el.clientWidth + 1 &&
              (el.textContent?.trim() ?? '') !== ''
            );
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.className} "${el.textContent?.trim()}"`),
      );
      expect(clipped, 'elements whose text overflows their box').toEqual([]);
    });
  });
}
