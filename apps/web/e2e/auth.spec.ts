import { type Locator, type Page } from '@playwright/test';
import { installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { computedTokenColor, expect, test } from './fixtures/test.js';

/**
 * Sign-in journeys that need no session and no network: everything up to the
 * point where Cognito would be called. OTP and passkey ceremonies are not
 * automated (passkeys only work on the production RP id, codes need a mailbox).
 * The one journey that does reach Cognito ("unknown email") runs against the
 * labelled FAKE in `fakes/cognito.ts`, intercepted at the network edge.
 */

const VALID_EMAIL = 'someone@example.com';
const DOCUMENT_PATH = '/d/01J8Z2Q5X0Y3K7N4M6P9R2S5T8?sheet=2#B7';

/** The one account the fake pool knows; every other address is "no account". */
const KNOWN: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-1',
  email: 'meena@1cloudhub.com',
  name: 'Meena',
};

const signInScreen = (page: Page) => ({
  heading: page.getByRole('heading', { level: 1 }),
  modes: page.getByRole('radiogroup', { name: 'Sign in or create account' }),
  signInMode: page.getByRole('radio', { name: 'Sign in' }),
  signUpMode: page.getByRole('radio', { name: 'Create account' }),
  email: page.getByLabel('Email'),
  name: page.getByLabel('Display name'),
  continueButton: page.getByRole('button', { name: 'Continue' }),
  passkey: page.getByRole('button', { name: 'Passkey' }),
  emailCode: page.getByRole('button', { name: 'Email me a one-time code' }),
  apple: page.getByRole('button', { name: /Apple/ }),
  change: page.getByRole('button', { name: 'Change' }),
  password: page.locator('input[type="password"], input[autocomplete*="password"]'),
});

test.describe('entry', () => {
  test('AUTH-01 an unauthenticated visit to / renders the sign-in screen', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(signInScreen(page).heading).toHaveText('Sign in');
    await checkA11y('sign-in email step 1440');
  });

  test('AUTH-01 an unauthenticated visit to a document retains the requested path', async ({
    page,
  }) => {
    await page.goto(DOCUMENT_PATH);
    await expect(page).toHaveURL(/\/sign-in$/);
    // The only observable without a session: the path the app will return to after sign-in.
    const returnTo = await page.evaluate(() => sessionStorage.getItem('gede.returnTo'));
    expect(returnTo).toBe(DOCUMENT_PATH);
  });
});

test.describe('email step', () => {
  test('AUTH-03 Continue is disabled until the address is valid, and Enter submits', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const s = signInScreen(page);
    await expect(s.continueButton).toBeDisabled();
    await s.email.fill('not-an-address');
    await expect(s.continueButton).toBeDisabled();
    await s.email.fill('almost@nodot');
    await expect(s.continueButton).toBeDisabled();
    await s.email.fill(VALID_EMAIL);
    await expect(s.continueButton).toBeEnabled();
    await s.email.press('Enter');
    // AUTH-04: the method step shows the address with a Change action.
    await expect(page.getByText(VALID_EMAIL)).toBeVisible();
    await expect(s.change).toBeVisible();
    await s.change.click();
    await expect(s.email).toHaveValue(VALID_EMAIL);
  });

  test('AUTH-02 the segmented Sign in / Create account control preserves the typed email', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/sign-in');
    const s = signInScreen(page);
    await expect(s.modes).toBeVisible();
    await expect(s.signInMode).toHaveAttribute('aria-checked', 'true');
    await s.email.fill(VALID_EMAIL);

    await s.signUpMode.click();
    await expect(s.heading).toHaveText('Create account');
    await expect(s.signUpMode).toHaveAttribute('aria-checked', 'true');
    await expect(s.email).toHaveValue(VALID_EMAIL);
    // Sign-up additionally collects a display name (AUTH-03) and stays disabled without it.
    await expect(s.name).toBeVisible();
    await expect(s.continueButton).toBeDisabled();
    await s.name.fill('Someone');
    await expect(s.continueButton).toBeEnabled();
    await checkA11y('sign-in create-account step 1440');

    await s.signInMode.click();
    await expect(s.heading).toHaveText('Sign in');
    await expect(s.email).toHaveValue(VALID_EMAIL);
    await expect(s.name).toHaveCount(0);
  });

  test('AUTH-02 switching mode from the method step resets to the email step', async ({ page }) => {
    await page.goto('/sign-in');
    const s = signInScreen(page);
    await s.email.fill(VALID_EMAIL);
    await s.email.press('Enter');
    await expect(s.emailCode).toBeVisible();
    await s.signUpMode.click();
    await expect(s.email).toHaveValue(VALID_EMAIL);
    await expect(s.emailCode).toHaveCount(0);
  });
});

test.describe('method step', () => {
  test('AUTH-04 offers the passkey first, then the code; AUTH-05 no password field on any step', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/sign-in');
    const s = signInScreen(page);
    await expect(s.password).toHaveCount(0);
    await s.email.fill(VALID_EMAIL);
    await s.email.press('Enter');

    // Chromium exposes PublicKeyCredential, so the passkey option is on.
    expect(await page.evaluate(() => typeof window.PublicKeyCredential)).toBe('function');
    await expect(s.passkey).toBeVisible();
    await expect(s.emailCode).toBeVisible();
    const passkeyBox = (await s.passkey.boundingBox())!;
    const codeBox = (await s.emailCode.boundingBox())!;
    expect(passkeyBox.y + passkeyBox.height).toBeLessThanOrEqual(codeBox.y);
    // Apple is off in the production config (`appleSignIn: false`): no Apple slot renders.
    await expect(s.apple).toHaveCount(0);
    await expect(s.password).toHaveCount(0);
    await checkA11y('sign-in method step 1440');
  });

  test('AUTH-05 hides the passkey option entirely when WebAuthn is unsupported', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // Simulate a device without WebAuthn: the app checks for this global (AUTH-05).
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    });
    await page.goto('/sign-in');
    const s = signInScreen(page);
    await s.email.fill(VALID_EMAIL);
    await s.email.press('Enter');
    await expect(s.emailCode).toBeVisible();
    await expect(s.passkey).toHaveCount(0);
    await expect(s.password).toHaveCount(0);
  });

  test('AUTH-04 an email with no account: the pool answers SELECT_CHALLENGE, the screen says no account uses it and points at Create account', async ({
    page,
    checkA11y,
  }) => {
    await page.route('**/config.json', (route) =>
      route.fulfill({
        json: {
          region: KNOWN.region,
          userPoolId: KNOWN.userPoolId,
          userPoolClientId: KNOWN.clientId,
          apiUrl: '/api',
          wsUrl: '/ws',
          appleSignIn: false,
          statusUrl: null,
        },
      }),
    );
    await installFakeCognito(page, KNOWN);
    await page.goto('/sign-in');
    const s = signInScreen(page);
    await s.email.fill('audit-nobody@example.invalid');
    await s.email.press('Enter');
    await s.emailCode.click();
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(
      'No account uses this email. Switch to Create account to start one.',
    );
    // Not the self-contradicting "has no passkey" copy the audit found (#46).
    await expect(alert).not.toContainText('passkey');
    await expect(s.emailCode).toBeEnabled();
    // The passkey button reaches the same answer: the cause is the account, not the method.
    await s.passkey.click();
    await expect(alert).toHaveText(
      'No account uses this email. Switch to Create account to start one.',
    );
    await checkA11y('sign-in method step unknown email 1440');
    // The remedy is one click away and keeps the address (AUTH-02).
    await s.signUpMode.click();
    await expect(s.heading).toHaveText('Create account');
    await expect(s.email).toHaveValue('audit-nobody@example.invalid');

    // A known address still gets its code.
    await s.signInMode.click();
    await s.email.fill(KNOWN.email);
    await s.email.press('Enter');
    await s.emailCode.click();
    await expect(page.getByLabel('Six-digit code')).toBeVisible();
    await expect(page.getByText('m***@1cloudhub.com')).toBeVisible();
  });

  /** Same public config with the Apple slot switched on. The button is asserted, never clicked. */
  const withApple = (page: Page) =>
    page.route('**/config.json', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        response: res,
        json: {
          ...body,
          appleSignIn: { domain: 'gede-prod.auth.ap-southeast-1.amazoncognito.com' },
        },
      });
    });

  test('AUTH-08 (partial: button under a fixture config; Apple is not deployed, see #45) with Apple configured, the method step reads Passkey, Apple, Email me a one-time code (option 1c) and Apple keeps its own wording', async ({
    page,
    checkA11y,
  }) => {
    await withApple(page);
    await page.goto('/sign-in');
    const s = signInScreen(page);
    // Apple is also offered at the email step, below Continue, with Apple's wording.
    const apple = page.getByRole('button', { name: 'Sign in with Apple' });
    await expect(apple).toBeVisible();
    await expect(s.passkey).toHaveCount(0);
    await s.email.fill(VALID_EMAIL);
    await s.email.press('Enter');
    await expect(s.passkey).toBeVisible();
    await expect(apple).toBeVisible();
    await expect(s.emailCode).toBeVisible();
    // Option 1c, verbatim: passkey above Apple above the email code. Apple is never
    // subordinate to another provider; the code is a fallback, not a provider.
    const passkeyBox = (await s.passkey.boundingBox())!;
    const appleBox = (await apple.boundingBox())!;
    const codeBox = (await s.emailCode.boundingBox())!;
    expect(passkeyBox.y + passkeyBox.height).toBeLessThanOrEqual(appleBox.y);
    expect(appleBox.y + appleBox.height).toBeLessThanOrEqual(codeBox.y);
    // Same order in the tab sequence: Change → Passkey → Apple → Email me a one-time code.
    await s.change.focus();
    await page.keyboard.press('Tab');
    await expect(s.passkey).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(apple).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(s.emailCode).toBeFocused();
    await expect(s.password).toHaveCount(0);
    await checkA11y('sign-in method step with apple 1440');
  });

  test('AUTH-08 (partial: button under a fixture config; Apple is not deployed, see #45) the Apple button meets the 44 pt minimum height at both steps', async ({
    page,
  }) => {
    // Apple's 44 pt floor (root rule 6): the button takes max(2.75rem, --hit-target) and the
    // root font stays at 100 %, so 2.75rem is 44 px and never 41.25.
    await withApple(page);
    await page.goto('/sign-in');
    const s = signInScreen(page);
    const apple = page.getByRole('button', { name: 'Sign in with Apple' });
    await expect(apple).toBeVisible();
    expect((await apple.boundingBox())!.height, 'email step').toBeGreaterThanOrEqual(44);
    await s.email.fill(VALID_EMAIL);
    await s.email.press('Enter');
    await expect(s.passkey).toBeVisible();
    await expect(apple).toBeVisible();
    expect((await apple.boundingBox())!.height, 'method step').toBeGreaterThanOrEqual(44);

    // Sign-up uses Apple's alternative wording, at the same height.
    await s.signUpMode.click();
    const appleSignUp = page.getByRole('button', { name: 'Continue with Apple' });
    await expect(appleSignUp).toBeVisible();
    expect((await appleSignUp.boundingBox())!.height, 'sign-up step').toBeGreaterThanOrEqual(44);
  });
});

test.describe('keyboard', () => {
  test('A11Y-01 the sign-in form is keyboard-complete: Tab order, Enter submits, arrows and Space switch mode', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const s = signInScreen(page);
    // The email field takes focus on arrival.
    await expect(s.email).toBeFocused();

    // Backwards to the first control (the segmented control is one tab stop), then forwards.
    await page.keyboard.press('Shift+Tab');
    await expect(s.signInMode).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(s.email).toBeFocused();
    // A disabled Continue is not a tab stop.
    await page.keyboard.press('Tab');
    await expect(s.continueButton).not.toBeFocused();

    await s.email.focus();
    await page.keyboard.type(VALID_EMAIL);
    await page.keyboard.press('Tab');
    await expect(s.continueButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(s.passkey).toBeVisible();

    // Method step, in reading order: Change → Passkey → Email me a one-time code.
    await s.change.focus();
    await page.keyboard.press('Tab');
    await expect(s.passkey).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(s.emailCode).toBeFocused();

    // Back to the email step with the keyboard alone; the address is kept.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(s.change).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(s.email).toBeFocused();
    await expect(s.email).toHaveValue(VALID_EMAIL);

    // Radix ToggleGroup: arrows move between segments, Space selects (AUTH-02 by keyboard).
    await page.keyboard.press('Shift+Tab');
    await expect(s.signInMode).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(s.signUpMode).toBeFocused();
    await page.keyboard.press('Space');
    await expect(s.heading).toHaveText('Create account');
    await expect(s.email).toHaveValue(VALID_EMAIL);
    // A mode switch returns focus to the email field; the group is one Shift+Tab away.
    await expect(s.email).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(s.signUpMode).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(s.signInMode).toBeFocused();
    await page.keyboard.press('Space');
    await expect(s.heading).toHaveText('Sign in');
    await expect(s.email).toHaveValue(VALID_EMAIL);
  });

  test('A11Y-02 every focusable control shows the 2 px amber focus ring at 2 px offset', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const s = signInScreen(page);
    const ring = await computedTokenColor(page, '--focus-ring');
    const amber = await computedTokenColor(page, '--amber-700');
    expect(ring, 'the focus ring token is live amber').toBe(amber);

    const outlineOf = (locator: Locator) =>
      locator.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          width: cs.outlineWidth,
          style: cs.outlineStyle,
          color: cs.outlineColor,
          offset: cs.outlineOffset,
        };
      });
    const expected = { width: '2px', style: 'solid', color: ring, offset: '2px' };

    // Reach each control by keyboard so :focus-visible applies, then read the painted outline.
    await expect(s.email).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(s.signInMode).toBeFocused();
    expect(await outlineOf(s.signInMode), 'Sign in segment').toEqual(expected);
    await page.keyboard.press('Tab');
    await expect(s.email).toBeFocused();
    expect(await outlineOf(s.email), 'Email field').toEqual(expected);
    await page.keyboard.type(VALID_EMAIL);
    await page.keyboard.press('Tab');
    await expect(s.continueButton).toBeFocused();
    expect(await outlineOf(s.continueButton), 'Continue').toEqual(expected);
    await page.keyboard.press('Enter');

    await expect(s.passkey).toBeVisible();
    await s.change.focus();
    await page.keyboard.press('Tab');
    await expect(s.passkey).toBeFocused();
    expect(await outlineOf(s.passkey), 'Passkey').toEqual(expected);
    await page.keyboard.press('Tab');
    await expect(s.emailCode).toBeFocused();
    expect(await outlineOf(s.emailCode), 'Email me a one-time code').toEqual(expected);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(s.change).toBeFocused();
    expect(await outlineOf(s.change), 'Change').toEqual(expected);
  });
});
