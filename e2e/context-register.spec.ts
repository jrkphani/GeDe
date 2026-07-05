import { expect, test } from '@playwright/test'

test('context register: create α and bind Comfort/Users/Engagement via type-ahead, keyboard only', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await page.getByRole('link', { name: 'Design' }).click()

  async function addWithDefaultName() {
    await page.getByRole('button', { name: 'Add dimension' }).click()
    await page.locator('.dim-row input').first().waitFor()
    await page.keyboard.press('Escape')
  }

  // Cross the n = 2 floor, then add the example's third dimension.
  await addWithDefaultName()
  await addWithDefaultName()
  await expect(page.getByText('Add at least two dimensions to begin designing.')).toBeHidden()
  await page.getByRole('button', { name: 'Dimensions' }).click()
  await addWithDefaultName()

  async function renameDimension(oldName: string, newName: string) {
    await page.locator('.dim-row__name', { hasText: oldName }).click()
    await page.locator('.dim-row input').first().fill(newName)
    await page.keyboard.press('Enter')
  }
  await renameDimension('Dimension 1', 'Value')
  await renameDimension('Dimension 2', 'Stake')
  await renameDimension('Dimension 3', 'Process')

  async function addParameterTo(dimensionName: string, paramName: string) {
    const section = page.locator('.dim-section', {
      has: page.locator('.dim-row__name', { hasText: dimensionName }),
    })
    const paramPhantom = section.getByPlaceholder('Type to add a parameter')
    await paramPhantom.fill(paramName)
    await paramPhantom.press('Enter')
    // Wait for the write to land before moving on — the phantom clears and
    // refocuses optimistically, but the store's add() is still in flight.
    await expect(section.getByText(paramName, { exact: true })).toBeVisible()
  }
  await addParameterTo('Value', 'Comfort')
  await addParameterTo('Stake', 'Users')
  await addParameterTo('Process', 'Engagement')

  // Close the dimension manager popover — the register underneath is unaffected.
  await page.getByRole('button', { name: 'Dimensions' }).click()

  // Create the context — table-side creation is "new empty row, start typing".
  const registerPhantom = page.getByPlaceholder('Type to create your first context — it becomes α')
  await registerPhantom.click()
  await page.keyboard.type('Stake reflects the primary beneficiaries')
  await page.keyboard.press('Enter')

  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await expect(row).toHaveClass(/grid-row--draft/)

  // Column order is Symbol(0) · Value(1) · Stake(2) · Process(3) · Justification(4) · Children(5).
  const valueCell = row.locator('td').nth(1)
  const stakeCell = row.locator('td').nth(2)
  const processCell = row.locator('td').nth(3)

  // From here on: keyboard only. Arrow up from the (refocused) phantom row
  // reaches α's Justification cell; arrow left walks Process → Stake → Value.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(valueCell.getByRole('button')).toBeFocused()

  async function bindViaTypeAhead(paramName: string, cell: typeof valueCell) {
    await page.keyboard.press('Enter')
    await expect(page.getByPlaceholder('Type to filter…')).toBeFocused()
    await page.keyboard.type(paramName)
    await page.keyboard.press('Enter')
    await expect(page.getByPlaceholder('Type to filter…')).toBeHidden()
    // Wait for the bound value to render AND focus to return to the trigger
    // (Radix's focus-return runs after the popover unmounts) before the next
    // keyboard move — otherwise ArrowRight can race ahead of both.
    await expect(cell).toContainText(paramName)
    await expect(cell.getByRole('button')).toBeFocused()
  }

  await bindViaTypeAhead('Comfort', valueCell)
  await page.keyboard.press('ArrowRight')
  await bindViaTypeAhead('Users', stakeCell)
  await page.keyboard.press('ArrowRight')
  await bindViaTypeAhead('Engagement', processCell)

  await expect(row).not.toHaveClass(/grid-row--draft/)
  await expect(row.getByText('Comfort')).toBeVisible()
  await expect(row.getByText('Users')).toBeVisible()
  await expect(row.getByText('Engagement')).toBeVisible()

  // Reload: the complete, bound context persists.
  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const rowAfter = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await expect(rowAfter).not.toHaveClass(/grid-row--draft/)
  await expect(rowAfter.getByText('Comfort')).toBeVisible()
  await expect(rowAfter.getByText('Users')).toBeVisible()
  await expect(rowAfter.getByText('Engagement')).toBeVisible()
})
