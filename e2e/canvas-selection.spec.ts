import { expect, test, type Page } from '@playwright/test'
import { forceWorkspaceSurface } from './workspaceSurface'

// Issue 009 — canvas selection, spokes, register sync. Issue 085 Phase B
// retires the Composer strip: selecting on the canvas highlights + scrolls
// to the register row instead of surfacing a second element, and the
// register's own justification cell is the (only) editing surface now.
// Mirrors canvas.spec.ts's setup (3 dimensions, one parameter each).
async function setUpCanvas(page: Page) {
  // 089-P7: selection/spoke assertions on the DesignSurface ring + native-scroll
  // register (WorkspaceSurface fallback). Canvas selection is covered by
  // d3-canvas.spec.ts. Pin to the fallback surface.
  await forceWorkspaceSurface(page)
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
}

async function createAndBindAlpha(page: Page, justification: string) {
  const registerPhantom = page.getByPlaceholder(/Type to create your first context — it becomes α|New context/)
  await registerPhantom.click()
  await page.keyboard.type(justification)
  await page.keyboard.press('Enter')

  const row = page.locator('.editable-grid tbody tr', { has: page.getByText('α', { exact: true }) })
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

test('selecting a context on the canvas highlights + scrolls to its register row; the row is the one editing surface', async ({
  page,
}) => {
  await setUpCanvas(page)
  const row = await createAndBindAlpha(page, 'Original reason')

  await page.locator('.canvas-node[data-context-id]').first().click()

  // Issue 085 Phase B, Decision 3 — no separate Composer strip; selection
  // re-points at the register row itself (left rule + aria, non-color-only).
  await expect(page.locator('.composer-bar')).toHaveCount(0)
  await expect(row).toHaveClass(/grid-row--selected/)
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.canvas-spoke')).toHaveCount(3)
  await expect(row.locator('td').nth(5)).toContainText('Original reason')

  // Decision 4 — the justification cell itself is the roomier editor now
  // (expand-on-focus), reached by focusing/clicking the cell in place.
  const justificationCell = row.locator('td').nth(5)
  await justificationCell.click()
  // Issue 089 D1 P3 — justification is a rich Lexical editor; commit is
  // Cmd/Ctrl+Enter (plain Enter is a newline).
  const editor = row.locator('.rich-text-editor__content')
  await editor.fill('Revised in the register')
  await editor.press('ControlOrMeta+Enter')

  await expect(justificationCell).toContainText('Revised in the register')
})

test('clicking a register row selects it on the canvas — spokes and the accent ring appear, non-selected contexts dim', async ({
  page,
}) => {
  await setUpCanvas(page)
  const rowAlpha = await createAndBindAlpha(page, 'Alpha reason')

  // A second, unbound (draft) context so there's something to dim.
  const registerPhantom = page.getByPlaceholder('New context')
  await registerPhantom.click()
  await page.keyboard.type('Beta reason')
  await page.keyboard.press('Enter')

  const alphaId = await rowAlpha.getAttribute('data-row-id')

  // Click the Documented cell (a static, non-editable dot) — clicking the
  // Symbol cell itself would also enter that cell's own rename-edit mode
  // (mono cells edit-in-place on click), which isn't what this test is
  // exercising and would replace the "α" text with an input's value.
  await rowAlpha.locator('.grid-col--status').click()

  await expect(page.locator('.canvas-node[aria-pressed="true"][data-context-id]')).toHaveCount(1)
  const selectedNode = page.locator('.canvas-node[aria-pressed="true"]')
  await expect(selectedNode).toHaveAttribute('data-context-id', alphaId ?? '')
  await expect(page.locator('.canvas-node--dimmed')).toHaveCount(1) // β dims, α doesn't
  await expect(page.locator('.canvas-spoke')).toHaveCount(3)
})
