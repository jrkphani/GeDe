import { expect, test } from '@playwright/test'

// Issue 033 (ADR-0009): the hero/login on-ramp never blocks the account-free
// local app, and is itself keyboard-operable. This dev build has no
// VITE_COGNITO_* configured, so these specs exercise UI/keyboard behavior
// only — no live Cognito call is ever made (the calm "isn't configured"
// notice + disabled submit is itself part of the acceptance surface).

test('local mode is fully preserved: / boots the account-free app with no sign-in gate', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  // The app bar's account affordance is silent when auth isn't configured —
  // it must never appear as a broken/blocking control.
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
})

test('/welcome renders the hero and is keyboard-operable', async ({ page }) => {
  await page.goto('/welcome')
  // Scoped to the hero panel — the app bar's own <h1> ("GeDe") is present on
  // every route (SITEMAP §2 "App bar, stable everywhere").
  await expect(page.locator('.hero__title')).toContainText(/design generative systems/i)

  const signIn = page.getByRole('button', { name: 'Sign in' })
  const useLocally = page.getByRole('button', { name: 'Use locally' })
  await expect(signIn).toBeVisible()
  await expect(useLocally).toBeVisible()

  await signIn.focus()
  await expect(signIn).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(useLocally).toBeFocused()

  await useLocally.click()
  await expect(page).toHaveURL(/\/$/)
})

test('hero "Sign in" navigates to the custom /login screen', async ({ page }) => {
  await page.goto('/welcome')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('/login is keyboard-operable end to end and the sign-up/verify modes are reachable without a network call', async ({
  page,
}) => {
  await page.goto('/login')
  // Scoped to the login screen's own notice — the shell's status bar is a
  // separate, always-present `role="status"` region (SITEMAP §2).
  await expect(page.locator('.login__notice')).toContainText(/isn't configured/i)

  await page.getByLabel('Email').fill('me@example.com')
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Password')).toBeFocused()

  // The submit button is disabled for an unconfigured build (calm, not
  // broken) — verify the mode switch itself works without ever submitting.
  await page.getByRole('button', { name: 'Need an account? Sign up' }).click()
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible()

  await page.getByRole('button', { name: 'Already have an account? Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})
