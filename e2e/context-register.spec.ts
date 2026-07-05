import { expect, test, type Page } from '@playwright/test'

// Shared canvas setup: project → Design tab → 3 dimensions (Value/Stake/Process)
// each with one parameter (Comfort/Users/Engagement). Used by every test below.
async function setUpCanvas(page: Page) {
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
}

async function createContext(page: Page, justification: string) {
  const registerPhantom = page.getByPlaceholder(/Type to create your first context — it becomes α|New context/)
  await registerPhantom.click()
  await page.keyboard.type(justification)
  await page.keyboard.press('Enter')
}

test('context register: create α and bind Comfort/Users/Engagement via type-ahead, keyboard only', async ({
  page,
}) => {
  await setUpCanvas(page)
  await createContext(page, 'Stake reflects the primary beneficiaries')

  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await expect(row).toHaveClass(/grid-row--draft/)

  // Column order is Symbol(0) · Documented(1) · Value(2) · Stake(3) · Process(4) ·
  // Justification(5) · Children(6) · Duplicate(7).
  const valueCell = row.locator('td').nth(2)
  const stakeCell = row.locator('td').nth(3)
  const processCell = row.locator('td').nth(4)

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

test('context register: two contexts on the same tuple both save and both show a duplicate badge', async ({
  page,
}) => {
  await setUpCanvas(page)

  async function bindRow(symbol: string) {
    const row = page.locator('.editable-grid tbody tr', { has: page.getByText(symbol, { exact: true }) })
    const valueCell = row.locator('td').nth(2)
    const stakeCell = row.locator('td').nth(3)
    const processCell = row.locator('td').nth(4)

    async function bindViaClick(cell: typeof valueCell, paramName: string) {
      await cell.getByRole('button').click()
      await page.getByPlaceholder('Type to filter…').fill(paramName)
      await page.keyboard.press('Enter')
      await expect(cell).toContainText(paramName)
    }
    await bindViaClick(valueCell, 'Comfort')
    await bindViaClick(stakeCell, 'Users')
    await bindViaClick(processCell, 'Engagement')
    return row
  }

  await createContext(page, 'First take')
  const rowAlpha = await bindRow('α')
  await expect(rowAlpha).not.toHaveClass(/grid-row--draft/)

  await createContext(page, 'Second take, same tuple')
  const rowBeta = await bindRow('β')
  await expect(rowBeta).not.toHaveClass(/grid-row--draft/)

  // Both contexts saved (no save was ever rejected) and both show the
  // non-blocking duplicate badge naming the sibling (SPEC invariant 2).
  await expect(rowAlpha.getByTitle(/Same tuple as/)).toBeVisible()
  await expect(rowBeta.getByTitle(/Same tuple as/)).toBeVisible()
  await expect(rowAlpha.getByTitle('Same tuple as β')).toBeVisible()
  await expect(rowBeta.getByTitle('Same tuple as α')).toBeVisible()
})
