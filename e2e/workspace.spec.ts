import { expect, test } from '@playwright/test'
import { forceWorkspaceSurface } from './workspaceSurface'

// Issue 089 D2 Phase 1 — the unified workspace. All three tier surfaces
// (Foundation · Architecture · Design) now render as side-by-side vertical
// lanes on ONE project URL, inside the single shared `.surface` scroll region.
// Before D2 the shell mounted exactly one surface per route, so the three
// never co-existed in the DOM. This is the red-first proof they now co-mount.
test('workspace: foundation, architecture, and design lanes all mount on one page', async ({
  page,
}) => {
  // 089-P7: this asserts the WorkspaceSurface stacked-lane co-mount (the
  // `.workspace__lane--*` DOM), which is the < 1024px / data-saver fallback the
  // canvas flip retained. Pin it to that surface (see forceWorkspaceSurface).
  await forceWorkspaceSurface(page)
  await page.goto('/')
  await expect(page.locator('[data-db-ready="true"]')).toBeVisible({ timeout: 15_000 })

  const phantomProject = page.getByPlaceholder(/Name your first project|New project/)
  await phantomProject.fill('Tavalo')
  await phantomProject.press('Enter')
  await page.getByRole('button', { name: 'Open Tavalo' }).click()

  // Opening a project lands on the Foundation tier route (unchanged route
  // grammar), but the workspace mounts all three lanes regardless.
  const foundationLane = page.locator('.workspace__lane--foundation')
  const architectureLane = page.locator('.workspace__lane--architecture')
  const designLane = page.locator('.workspace__lane--design')

  // All three tier surfaces are visible SIMULTANEOUSLY: Foundation's heading,
  // Architecture's heading, and the Design editing-zone (rail + register).
  await expect(foundationLane.getByText('1st Tier · Foundation')).toBeVisible()
  await expect(architectureLane.getByText('2nd Tier · Architecture')).toBeVisible()
  await expect(designLane.locator('.editing-zone')).toBeVisible()
  await expect(designLane.locator('.dim-rail')).toBeVisible()
})
