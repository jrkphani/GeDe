import { expect, test } from '@playwright/test';

test('AUTH-01 an unauthenticated visit to / lands on the sign-in screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // Either the passkey button (AUTH-04) or the email field (AUTH-03) is the first control.
  const passkey = page.getByRole('button', { name: 'Passkey' });
  const email = page.getByLabel('Email');
  await expect(passkey.or(email).first()).toBeVisible();
});
