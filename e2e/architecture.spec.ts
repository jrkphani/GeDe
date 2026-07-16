import { expect, test, type Page } from '@playwright/test'

// Issue 014, test-first plan item 5: build the example's Architecture tables,
// promote them into 3rd-Tier dimensions, and confirm the link is live in both
// directions — the register combobox offers the promoted parameters, and
// renaming a 2nd-Tier entry propagates to its parameter (invariant 7).

function tablePanel(page: Page, tableName: string) {
  return page.locator('.t2-table', {
    has: page.locator('.t2-table__name', { hasText: tableName }),
  })
}

async function addTable(page: Page, name: string) {
  // Issue 084 (D1): the create control is the stable top add-row's typed
  // input ("Name a table"), no longer the trailing "Add table" ghost.
  const ghost = page.getByPlaceholder('Name a table')
  await ghost.fill(name)
  await ghost.press('Enter')
  await expect(page.locator('.t2-table__name', { hasText: name })).toBeVisible()
}

async function addEntry(page: Page, tableName: string, entryName: string) {
  const panel = tablePanel(page, tableName)
  const phantom = panel.getByPlaceholder('Name an entry')
  await phantom.fill(entryName)
  await phantom.press('Enter')
  await expect(panel.getByRole('cell', { name: entryName, exact: true })).toBeVisible()
}

async function promoteTable(page: Page, tableName: string, entryNames: string[], dimensionName: string) {
  const panel = tablePanel(page, tableName)
  for (const name of entryNames) {
    await panel.getByRole('button', { name: `Select ${name}` }).click()
  }
  await expect(panel.getByText(`${entryNames.length} selected`)).toBeVisible()
  await panel.getByRole('button', { name: 'Use as dimension…' }).click()
  const nameField = page.getByLabel('New dimension name')
  await nameField.fill(dimensionName)
  await expect(
    page.getByText(new RegExp(`Creates ${entryNames.length} parameters? on ${dimensionName}`)),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Promote' }).click()
  await expect(page.getByText(`${entryNames.length} selected`)).toBeHidden()
}

test('architecture: build tables, promote to dimensions, register offers params, rename propagates', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()

  await page.getByRole('link', { name: 'Architecture' }).click()
  await expect(page.getByText('2nd Tier · Architecture')).toBeVisible()

  // A canvas needs ≥ 2 dimensions, so promote two tables (Value + Stakeholders).
  await addTable(page, 'Value')
  await addEntry(page, 'Value', 'Comfort')
  await promoteTable(page, 'Value', ['Comfort'], 'Value')

  await addTable(page, 'Stakeholders')
  await addEntry(page, 'Stakeholders', 'Buyers')
  await addEntry(page, 'Stakeholders', 'Maintainer')
  await addEntry(page, 'Stakeholders', 'Users')
  await promoteTable(page, 'Stakeholders', ['Buyers', 'Maintainer', 'Users'], 'Stake')

  // The promoted entries carry the mirrored source badge (both sides visible).
  await expect(tablePanel(page, 'Stakeholders').getByText('→ Stake').first()).toBeVisible()

  // Design tab: two dimensions exist, so the register renders. Its Stake column
  // combobox now offers the promoted parameters.
  await page.getByRole('link', { name: 'Design' }).click()
  const registerPhantom = page.getByPlaceholder(/Type to create your first context — it becomes α|New context/)
  await registerPhantom.click()
  await page.keyboard.type('Stake reflects the primary beneficiaries')
  await page.keyboard.press('Enter')

  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  // Column order: Symbol(0) · Documented(1) · Value(2) · Stake(3) · …
  const stakeCell = row.locator('td').nth(3)
  await stakeCell.getByRole('button').click()
  await expect(page.getByPlaceholder('Type to filter…')).toBeVisible()
  await expect(page.getByRole('option', { name: 'Buyers' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Maintainer' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Users' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Rename "Users" in the Architecture tab → propagates to its parameter.
  await page.getByRole('link', { name: 'Architecture' }).click()
  const usersCell = tablePanel(page, 'Stakeholders').getByRole('cell', { name: 'Users', exact: true })
  await usersCell.click()
  await page.locator('input:focus').fill('People')
  await page.keyboard.press('Enter')
  await expect(tablePanel(page, 'Stakeholders').getByRole('cell', { name: 'People', exact: true })).toBeVisible()
  await expect(page.locator('.status-bar')).toContainText(/parameter updated/)

  // Back on Design: the register's Stake combobox now offers "People".
  await page.getByRole('link', { name: 'Design' }).click()
  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const rowAfter = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await rowAfter.locator('td').nth(3).getByRole('button').click()
  await expect(page.getByPlaceholder('Type to filter…')).toBeVisible()
  await expect(page.getByRole('option', { name: 'People' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Users' })).toBeHidden()
})

// Issue 025, test-first plan item 3: the selection bar/promote trigger must
// stay reachable near the top of a tall table without scrolling to its end.
test('architecture: selection bar stays in view (sticky) on a tall table without scrolling to the bottom', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()

  await page.getByRole('link', { name: 'Architecture' }).click()
  await expect(page.getByText('2nd Tier · Architecture')).toBeVisible()

  await addTable(page, 'Stakeholders')
  // A tall table — enough rows that end-of-list flow would push the
  // selection bar far below the fold (design brief, done/025).
  const entryNames = Array.from({ length: 30 }, (_, i) => `Entry ${i + 1}`)
  for (const name of entryNames) await addEntry(page, 'Stakeholders', name)

  const panel = tablePanel(page, 'Stakeholders')
  // Select the first entry — at the very top of a table dozens of rows tall
  // — without scrolling the page at all.
  await panel.getByRole('button', { name: 'Select Entry 1', exact: true }).click()

  const promoteTrigger = page.getByRole('button', { name: 'Use as dimension…' })
  await expect(promoteTrigger).toBeVisible()
  // The sticky positioning (base.css `.t2-selection-bar { position: sticky }`)
  // means this is reachable without any scroll — assert it's actually within
  // the viewport, not merely present in the DOM off-screen.
  await expect(promoteTrigger).toBeInViewport()
})
