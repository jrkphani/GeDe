import { type Locator, type Page } from '@playwright/test';
import {
  FAKE_SIGN_IN_CODE,
  FAKE_SIGN_UP_CODE,
  UNKNOWN,
  installFakeCognito,
} from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import {
  asDesktop,
  asPhone,
  computedTokenColor,
  expect,
  expectNoHorizontalOverflow,
  test,
} from './fixtures/test.js';

/**
 * Sign-in journeys that need no session and no network: everything up to the
 * point where Cognito would be called. Passkey ceremonies are not automated
 * (passkeys only work on the production RP id). The journeys that do reach
 * Cognito — "unknown email", the sign-in code step, the sign-up code step —
 * run against the labelled FAKE in `fakes/cognito.ts`, intercepted at the
 * network edge, which answers codes at the lengths the real pool sends.
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

    // The pool's second shape for an unknown address, PasswordResetRequiredException, reads
    // the same — never the "set to use a password" copy the final audit found (#46).
    await s.signInMode.click();
    await s.email.fill(UNKNOWN.passwordReset);
    await s.email.press('Enter');
    await s.emailCode.click();
    await expect(alert).toHaveText(
      'No account uses this email. Switch to Create account to start one.',
    );
    await expect(alert).not.toContainText('password');

    // The third shape, a simulated code challenge, cannot be told from a real one (ADR-040):
    // the code step opens, and says what to do when no code arrives.
    await page.getByRole('button', { name: 'Change' }).click();
    await s.email.fill(UNKNOWN.simulatedCode);
    await s.email.press('Enter');
    await s.emailCode.click();
    await expect(page.getByLabel('Eight-digit code')).toBeVisible();
    await expect(
      page.getByText(/If no code arrives, this email may not have an account yet/),
    ).toBeVisible();
    await checkA11y('sign-in code step simulated challenge 1440');
    await s.signUpMode.click();
    await expect(s.email).toHaveValue(UNKNOWN.simulatedCode);

    // A known address still gets its code.
    await s.signInMode.click();
    await s.email.fill(KNOWN.email);
    await s.email.press('Enter');
    await s.emailCode.click();
    await expect(page.getByLabel('Eight-digit code')).toBeVisible();
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

/**
 * The code step against the FAKE pool, which answers the codes at the lengths the real
 * one sends (AUTH-06): eight digits for the passwordless EMAIL_OTP sign-in code, six for
 * the sign-up verification code. The suite answered six for the sign-in step until the
 * production defect this covers (an eight-digit code the screen truncated to six).
 */
async function installFakePool(page: Page): Promise<void> {
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
  // The library the sign-in lands on: an empty list and a profile (labelled fakes).
  await page.route('**/api/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.route('**/api/me', (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: {} });
    return route.fulfill({
      json: {
        id: KNOWN.sub,
        sub: KNOWN.sub,
        email: KNOWN.email,
        displayName: KNOWN.name,
        locale: 'en-US',
      },
    });
  });
}

const codeStep = (page: Page) => ({
  code: page.getByLabel('Eight-digit code'),
  verify: page.getByRole('button', { name: 'Verify and sign in' }),
  resend: page.getByRole('button', { name: 'Resend code' }),
  alert: page.getByRole('alert'),
});

/** Email → method → the sign-in code step for the known account. */
async function toSignInCodeStep(page: Page): Promise<void> {
  await page.goto('/sign-in');
  const s = signInScreen(page);
  await s.email.fill(KNOWN.email);
  await s.email.press('Enter');
  await s.emailCode.click();
  await expect(codeStep(page).code).toBeVisible();
}

/** The passkey offer follows a code sign-in (AUTH-07); decline it, then the library shows. */
async function expectSignedIn(page: Page): Promise<void> {
  const notNow = page.getByRole('button', { name: 'Not now' });
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(/\/$/, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

const CODE_STEP_JOURNEY = (theme: 'light' | 'dark') => {
  for (const width of [1440, 480] as const) {
    test(`AUTH-06 RESP-05 A11Y-03 at ${width} px ${theme}: the sign-in code step asks for eight digits, verifies only at eight, resends, and an eight-digit code signs in`, async ({
      page,
      checkA11y,
      snapshot,
    }) => {
      await installFakePool(page);
      if (width === 480) await asPhone(page, 480);
      else await asDesktop(page, width);
      await toSignInCodeStep(page);
      const c = codeStep(page);
      // The label, the hint that describes the field, and the numeric keypad.
      await expect(page.getByLabel('Six-digit code')).toHaveCount(0);
      await expect(c.code).toHaveAttribute('inputmode', 'numeric');
      await expect(c.code).toHaveAttribute('autocomplete', 'one-time-code');
      await expect(c.code).toHaveAttribute('data-length', '8');
      const hint = page.getByText('Codes expire in 10 minutes');
      await expect(hint).toBeVisible();
      const describedBy = (await c.code.getAttribute('aria-describedby')) ?? '';
      expect(describedBy.split(' ')).toContain(await hint.getAttribute('id'));
      await expect(page.getByText('m***@1cloudhub.com')).toBeVisible();
      await expect(c.code).toBeFocused();
      await expect(c.verify).toBeDisabled();

      // Six digits — where the screen used to stop — is not a sign-in code.
      await c.code.fill('123456');
      await expect(c.verify).toBeDisabled();
      // The regression: an eight-digit code, pasted the way a mail client copies it,
      // keeps every digit; nothing is truncated to six.
      await c.code.fill('8765 4321');
      await expect(c.code).toHaveValue('87654321');
      await expect(c.verify).toBeEnabled();
      await snapshot(`sign-in code step ${width} ${theme}`);
      await checkA11y(`sign-in code step ${width} ${theme}`);
      await expectNoHorizontalOverflow(page);
      // The eight digits sit inside the field at this width.
      const box = (await c.code.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(width);
      expect(
        await c.code.evaluate((el: HTMLInputElement) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);

      // A wrong eight-digit code names the problem; the field keeps its value.
      await c.verify.click();
      await expect(c.alert).toHaveText(
        'That code does not match. Check the latest email or resend.',
      );
      await expect(c.code).toHaveValue('87654321');
      await checkA11y(`sign-in code step wrong code ${width} ${theme}`);

      // Resend asks the pool for a fresh code; the notice replaces the error (#144).
      await c.resend.click();
      await expect(page.getByText('A new code is on its way.')).toBeVisible();
      await expect(c.alert).toHaveCount(0);

      // The code the fake pool "sent": eight digits, and the account is signed in.
      await c.code.fill(FAKE_SIGN_IN_CODE);
      await expect(c.verify).toBeEnabled();
      await c.verify.click();
      await expectSignedIn(page);
    });
  }
};

test.describe('code step, light', () => {
  CODE_STEP_JOURNEY('light');
});

test.describe('code step, dark', () => {
  test.use({ colorScheme: 'dark' });
  CODE_STEP_JOURNEY('dark');
});

test.describe('sign-up code step', () => {
  test('AUTH-03 AUTH-06 creating an account asks for the six-digit verification code, valid 24 hours, and signs in on the code without a second one', async ({
    page,
    checkA11y,
  }) => {
    await installFakePool(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/sign-in');
    const s = signInScreen(page);
    await s.signUpMode.click();
    await s.email.fill('newcomer@example.com');
    await s.name.fill('Newcomer');
    await s.email.press('Enter');
    const code = page.getByLabel('Six-digit code');
    await expect(code).toBeVisible();
    await expect(page.getByLabel('Eight-digit code')).toHaveCount(0);
    await expect(code).toHaveAttribute('data-length', '6');
    await expect(page.getByText('Codes expire in 24 hours')).toBeVisible();
    await expect(page.getByText('n***@example.com')).toBeVisible();
    const verify = page.getByRole('button', { name: 'Verify and create account' });
    await expect(verify).toBeDisabled();
    await code.fill('12345');
    await expect(verify).toBeDisabled();
    await code.fill(FAKE_SIGN_UP_CODE);
    await expect(verify).toBeEnabled();
    await checkA11y('sign-up code step 1440');
    // Resend goes through ResendConfirmationCode, not a new sign-in.
    await page.getByRole('button', { name: 'Resend code' }).click();
    await expect(page.getByText('A new code is on its way.')).toBeVisible();
    await verify.click();
    await expectSignedIn(page);
  });

  test('AUTH-03 creating an account with an address that already has one says so', async ({
    page,
  }) => {
    await installFakePool(page);
    await page.goto('/sign-in');
    const s = signInScreen(page);
    await s.signUpMode.click();
    await s.email.fill(KNOWN.email);
    await s.name.fill('Meena');
    await s.email.press('Enter');
    await expect(page.getByRole('alert')).toHaveText(
      'An account already uses this email. Switch to Sign in.',
    );
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

    // ARIA radio pattern (Radix RadioGroup, #144): an arrow moves the selection and keeps
    // focus on the group; the mode switches at once (AUTH-02 by keyboard) and focus does
    // not jump to the field, so the next arrow works too.
    // Radix checks the segment that receives focus while the arrow is still down (the focus
    // move is deferred a tick); a press-and-release in one call can beat it, a finger cannot.
    const arrow = async (key: 'ArrowLeft' | 'ArrowRight', target: Locator) => {
      await page.keyboard.down(key);
      await expect(target).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.up(key);
    };
    await page.keyboard.press('Shift+Tab');
    await expect(s.signInMode).toBeFocused();
    await arrow('ArrowRight', s.signUpMode);
    await expect(s.signUpMode).toBeFocused();
    await expect(s.heading).toHaveText('Create account');
    await expect(s.email).toHaveValue(VALID_EMAIL);
    await expect(s.email).not.toBeFocused();
    await arrow('ArrowLeft', s.signInMode);
    await expect(s.signInMode).toBeFocused();
    await expect(s.heading).toHaveText('Sign in');
    await expect(s.email).toHaveValue(VALID_EMAIL);
    // Space on the focused, checked segment is a no-op; Tab leaves the group in one stop.
    await page.keyboard.press('Space');
    await expect(s.heading).toHaveText('Sign in');
    await page.keyboard.press('Tab');
    await expect(s.email).toBeFocused();
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
