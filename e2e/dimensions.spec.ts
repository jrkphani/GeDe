import { expect, test } from '@playwright/test'

test('guided start, add three dimensions, reorder, recolor — all persist across reload', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const phantom = page.getByPlaceholder(/Name your first project|New project/)
  await phantom.fill('Tavalo')
  await phantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await page.getByRole('link', { name: 'Design' }).click()

  // Guided start: below the floor, the surface IS the manager.
  await expect(page.getByText('Add at least two dimensions to begin designing.')).toBeVisible()

  async function addWithDefaultName() {
    await page.getByRole('button', { name: 'Add dimension' }).click()
    await page.locator('.dim-row input').first().waitFor() // editor opens ready-to-edit
    await page.keyboard.press('Escape') // keep the default name
  }

  await addWithDefaultName()
  await addWithDefaultName()

  // Floor reached: guided prompt is replaced by the design placeholder + context bar.
  await expect(page.getByText('Add at least two dimensions to begin designing.')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Dimensions' })).toBeVisible()

  // Third dimension via the context-bar popover.
  await page.getByRole('button', { name: 'Dimensions' }).click()
  await addWithDefaultName()
  const rows = page.locator('.dim-row')
  await expect(rows).toHaveCount(3)

  // Palette colors assigned in sort order (STYLE_GUIDE §2.3 seeds).
  await expect(rows.nth(0)).toHaveAttribute('data-color', '#6F5BD6')
  await expect(rows.nth(1)).toHaveAttribute('data-color', '#0E8A93')
  await expect(rows.nth(2)).toHaveAttribute('data-color', '#D9542B')

  // Keyboard reorder: move "Dimension 3" up one slot.
  await rows.nth(2).focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(rows.nth(1).getByText('Dimension 3')).toBeVisible()

  // Recolor "Dimension 1" to the blue slot.
  await page.getByRole('button', { name: 'Color of Dimension 1' }).click()
  await page.getByRole('button', { name: 'Use #3D6BD6' }).click()
  await expect(rows.nth(0)).toHaveAttribute('data-color', '#3D6BD6')

  // Reload: order and colors persist.
  await page.reload()
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Dimensions' }).click()
  const after = page.locator('.dim-row')
  await expect(after.nth(0).getByText('Dimension 1')).toBeVisible()
  await expect(after.nth(1).getByText('Dimension 3')).toBeVisible()
  await expect(after.nth(2).getByText('Dimension 2')).toBeVisible()
  await expect(after.nth(0)).toHaveAttribute('data-color', '#3D6BD6')
})
