import { expect, test } from '@playwright/test'

async function createAndOpenProject(page: import('@playwright/test').Page, name: string) {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const phantom = page.getByPlaceholder(/Name your first project|New project/)
  await phantom.fill(name)
  await phantom.press('Enter')
  await page.getByRole('button', { name: `Open ${name}` }).click()
  await expect(page).toHaveURL(/\/p\/[^/]+\/foundation$/)
  return page.url().match(/\/p\/([^/]+)\//)?.[1] as string
}

test('tier tabs navigate, history walks back, reload restores', async ({ page }) => {
  await createAndOpenProject(page, 'Tavalo')

  await page.getByRole('link', { name: 'Design' }).click()
  await expect(page).toHaveURL(/\/design$/)
  await expect(page.getByRole('link', { name: 'Design' })).toHaveClass(/tab--active/)

  await page.goBack()
  await expect(page).toHaveURL(/\/foundation$/)
  await expect(page.getByRole('link', { name: 'Foundation' })).toHaveClass(/tab--active/)

  await page.goForward()
  await expect(page).toHaveURL(/\/design$/)

  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: 'Design' })).toHaveClass(/tab--active/)
})

test('deep link with view param restores tier, depth and view', async ({ page }) => {
  const id = await createAndOpenProject(page, 'Deep')
  await page.goto(`/p/${id}/design?view=coverage`)
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: 'Design' })).toHaveClass(/tab--active/)
  await expect(page.locator('[data-view="coverage"]')).toBeVisible()
})

test('/p/:id redirects to the last-visited tier', async ({ page }) => {
  const id = await createAndOpenProject(page, 'LastTier')
  await page.getByRole('link', { name: 'Architecture' }).click()
  await expect(page).toHaveURL(/\/architecture$/)

  await page.goto(`/p/${id}`)
  await expect(page).toHaveURL(/\/architecture$/)
})

test('theme toggle applies instantly and survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('unknown routes render the quiet not-found panel', async ({ page }) => {
  await page.goto('/nowhere/at/all')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Nothing at this address.')).toBeVisible()
  await page.getByRole('button', { name: 'Back to projects' }).click()
  await expect(page).toHaveURL(/\/$/)
})
