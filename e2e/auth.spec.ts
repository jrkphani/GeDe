import { expect, test } from '@playwright/test'

// Issue 064 (evolving issue 033/ADR-0009): /welcome and /login both render
// the same hero/landing surface — product brief beside the 3-mode auth card
// — and it never blocks the account-free local app. This dev build has no
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

test('/welcome renders the product brief + auth card and is keyboard-operable', async ({ page }) => {
  await page.goto('/welcome')
  // Scoped to the brief panel — the app bar's own <h1> ("GeDe") is present
  // on every route (SITEMAP §2 "App bar, stable everywhere").
  await expect(page.locator('.hero-landing__title')).toContainText(/design generative systems/i)
  await expect(page.getByRole('heading', { level: 2, name: 'Sign in' })).toBeVisible()

  const useLocally = page.getByRole('button', { name: 'Use locally' })
  await expect(useLocally).toBeVisible()

  // DOM/reading order: the brief panel (ending in "Use locally") precedes
  // the auth card.
  await useLocally.focus()
  await expect(useLocally).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Email')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Password')).toBeFocused()

  await useLocally.click()
  await expect(page).toHaveURL(/\/$/)
})

test('/login renders the same hero/landing surface; sign-up/verify modes are reachable without a network call', async ({
  page,
}) => {
  await page.goto('/login')
  // Scoped to the auth card's own notice — the shell's status bar is a
  // separate, always-present `role="status"` region (SITEMAP §2).
  await expect(page.locator('.hero-landing__notice')).toContainText(/isn't configured/i)

  await page.getByLabel('Email').fill('me@example.com')
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Password')).toBeFocused()

  // The submit button is disabled for an unconfigured build (calm, not
  // broken) — verify the mode switch itself works without ever submitting.
  await page.getByRole('button', { name: 'Need an account? Sign up' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Create an account' })).toBeVisible()

  await page.getByRole('button', { name: 'Already have an account? Sign in' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Sign in' })).toBeVisible()
})
