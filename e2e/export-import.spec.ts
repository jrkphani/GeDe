import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

// Issue 015 — export a fully-composed project, wipe to a clean browser profile,
// import the file, and prove the register / canvas / coverage are identical.
// Both directions run OFFLINE (context.setOffline) to back the PWA claim: the
// file operations touch no network.

// Seed 3 dimensions (Value/Stake/Process, one param each) and compose a
// complete + justified context α — mirrors canvas-compose.spec.ts.
async function seedAndCompose(page: Page) {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })
  const projectPhantom = page.getByPlaceholder(/Name your first project|New project/)
  await projectPhantom.fill('Tavalo')
  await projectPhantom.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()
  await page.getByRole('link', { name: 'Design' }).click()

  async function addWithDefaultName() {
    // Issue 082 Phase 1 — the old "Add dimension" command button was
    // replaced by a persistent phantom-row rail (type a name, press Enter).
    // No blank-add affordance remains, so we type the same default name the
    // old flow used to leave behind.
    const phantom = page.getByPlaceholder('Type to add a dimension')
    const count = await page.locator('.dim-row').count()
    await phantom.fill(`Dimension ${count + 1}`)
    await phantom.press('Enter')
    await expect(page.locator('.dim-row').nth(count)).toBeVisible()
  }
  await addWithDefaultName()
  await addWithDefaultName()
  await expect(page.getByText('Add a second dimension to start binding contexts.')).toBeHidden()
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
    await expect(section.getByText(paramName, { exact: true })).toBeVisible()
  }
  await addParameterTo('Value', 'Comfort')
  await addParameterTo('Stake', 'Users')
  await addParameterTo('Process', 'Engagement')

  // Compose α: bind all three dots, justify in the register row (mirrors
  // canvas-compose.spec.ts — gate on the draft node + the canvas's own
  // compose-mode marker being live before touching the dots; issue 085 Phase
  // B retired the Composer strip, so the draft's row is where binding +
  // justification happen now).
  await page.getByRole('button', { name: 'New context' }).click()
  await expect(page.locator('.canvas-node--draft')).toHaveCount(1)
  await expect(page.locator('.canvas-dot-group--compose').first()).toBeVisible()
  const dots = page.locator('.canvas-dot-group')
  await expect(dots).toHaveCount(3)
  await dots.nth(0).click()
  await dots.nth(1).click()
  await dots.nth(2).click()

  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await expect(row.locator('td').nth(2)).toContainText('Comfort')
  await expect(row.locator('td').nth(3)).toContainText('Users')
  await expect(row.locator('td').nth(4)).toContainText('Engagement')
  const justificationCell = row.locator('td').nth(5)
  await justificationCell.click()
  const justify = row.locator('.grid-cell__input--multiline')
  await justify.fill('First real context')
  await justify.press('Enter')
}

// Assert the Design surface shows the composed α exactly (register projection +
// documented status = the coverage input).
async function expectComposedAlpha(page: Page) {
  await page.getByRole('link', { name: 'Design' }).click()
  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
  await expect(row.locator('td').nth(2)).toContainText('Comfort')
  await expect(row.locator('td').nth(3)).toContainText('Users')
  await expect(row.locator('td').nth(4)).toContainText('Engagement')
  await expect(row.locator('td').nth(5)).toContainText('First real context')
  await expect(row.locator('.status-dot')).toHaveAttribute('data-status', 'documented')
  // Canvas rendered the context node.
  await expect(page.locator('.canvas-node')).toHaveCount(1)
}

test('export → wipe → import reproduces the project identically, offline', async ({
  page,
  browser,
}) => {
  await seedAndCompose(page)
  await expectComposedAlpha(page)

  // A clean second profile (the "wipe"): loaded online, then taken offline.
  const cleanContext = await browser.newContext()
  const cleanPage = await cleanContext.newPage()
  await cleanPage.goto('/')
  await expect(cleanPage.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  // Both directions from here are OFFLINE.
  await page.context().setOffline(true)
  await cleanContext.setOffline(true)

  // Export (offline): the project menu downloads {name}.gede.json immediately.
  await page.getByRole('button', { name: 'Project menu' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export project…' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('Tavalo.gede.json')
  const filePath = await download.path()
  const buffer = readFileSync(filePath)

  // Import (offline) into the clean profile via drag-drop's underlying input.
  await cleanPage.locator('input[type="file"]').setInputFiles({
    name: 'Tavalo.gede.json',
    mimeType: 'application/json',
    buffer,
  })

  // The list selects the new project and narrates a specific count.
  await expect(cleanPage.getByRole('button', { name: 'Open Tavalo' })).toBeVisible()
  await expect(cleanPage.locator('.status-bar')).toContainText(
    'Imported Tavalo — 1 canvas, 1 context',
  )

  // Open it: register, canvas, and coverage input are identical to the source.
  await cleanPage.getByRole('button', { name: 'Open Tavalo' }).click()
  await expectComposedAlpha(cleanPage)

  await cleanContext.close()
})

test('a non-GeDe file is rejected calmly in the panel, importing nothing', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  await page.locator('input[type="file"]').setInputFiles({
    name: 'photo.json',
    mimeType: 'application/json',
    buffer: Buffer.from('this is not a gede export'),
  })
  await expect(page.getByRole('alert')).toHaveText('Not a GeDe export')
  // Nothing was added — still the first-run empty state.
  await expect(page.getByPlaceholder('Name your first project')).toBeVisible()
})
