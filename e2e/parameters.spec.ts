import { expect, test } from '@playwright/test'

test('parameters: build the Stake dimension (Buyers, Maintainer, Users) — persists ordered across reload', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const phantom = page.getByPlaceholder(/Name your first project|New project/)
  await phantom.fill('Tavalo')
  await phantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await page.getByRole('link', { name: 'Design' }).click()

  async function addWithDefaultName() {
    // Issue 082 Phase 1 — the old "Add dimension" command button was
    // replaced by a persistent phantom-row rail (type a name, press Enter).
    // No blank-add affordance remains, so we type the same default name the
    // old flow used to leave behind.
    const dimPhantom = page.getByPlaceholder('Type to add a dimension')
    const count = await page.locator('.dim-row').count()
    await dimPhantom.fill(`Dimension ${count + 1}`)
    await dimPhantom.press('Enter')
    await expect(page.locator('.dim-row').nth(count)).toBeVisible()
  }

  // Cross the n = 2 floor (issue 002 guided start). Issue 082 Phase 1 — the
  // dimension manager is an always-open rail now, so there's no popover to
  // reopen here.
  await addWithDefaultName()
  await addWithDefaultName()
  await expect(page.getByText('Add a second dimension to start binding contexts.')).toBeHidden()

  // Rename the first dimension to Stake.
  await page.locator('.dim-row__name', { hasText: 'Dimension 1' }).click()
  await page.locator('.dim-row input').first().fill('Stake')
  await page.keyboard.press('Enter')

  const stakeSection = page.locator('.dim-section', { has: page.getByText('Stake', { exact: true }) })
  async function addParameter(name: string) {
    const paramPhantom = stakeSection.getByPlaceholder('Type to add a parameter')
    await paramPhantom.fill(name)
    await paramPhantom.press('Enter')
    await expect(paramPhantom).toHaveValue('') // fresh phantom focused, ready for the next
  }
  await addParameter('Buyers')
  await addParameter('Maintainer')
  await addParameter('Users')

  const rows = stakeSection.locator('.param-row:not(.param-row--phantom)')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Buyers')
  await expect(rows.nth(1)).toContainText('Maintainer')
  await expect(rows.nth(2)).toContainText('Users')

  // Reload: parameters and their order persist. The rail is always open, so
  // nothing needs reopening after reload.
  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  const stakeAfter = page.locator('.dim-section', { has: page.getByText('Stake', { exact: true }) })
  const rowsAfter = stakeAfter.locator('.param-row:not(.param-row--phantom)')
  await expect(rowsAfter).toHaveCount(3)
  await expect(rowsAfter.nth(0)).toContainText('Buyers')
  await expect(rowsAfter.nth(1)).toContainText('Maintainer')
  await expect(rowsAfter.nth(2)).toContainText('Users')
})
