/**
 * The live journey against the deployed product (see fixtures/live.ts for how it signs in).
 * One account, one document named after this run, deleted for good before sign-out; the
 * worker teardown sweeps anything a red run left behind.
 */
import { type Page } from '@playwright/test';
import { expect, test } from './fixtures/live.js';

const RUN_TITLE = `Live ${new Date().toISOString().replace(/[:.]/g, '-')}`;
const CELL_TEXT = 'Base camp';

const firstCell = (page: Page) => page.getByRole('grid').first().getByRole('gridcell').first();

test('AUTH-01 LIB-01 DOC-01 GRID-04 LOAD-05 FIND-01 SHARE-01 LIB-D1 LIB-D8 AUTH-09 live: sign in, create a workscape, type in a cell, see it after a reload and from a fresh browser, find it, open Share, delete it for good, sign out', async ({
  page,
  browser,
  signIn,
}) => {
  await test.step('the library loads for the signed-in account', async () => {
    await signIn(page, '/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recents');
    await expect(page.getByRole('button', { name: 'New workscape' })).toBeVisible();
  });

  let docPath = '';
  await test.step('create a workscape and name it after this run', async () => {
    await page.getByRole('button', { name: 'New workscape' }).click();
    await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}\?new=1$/);
    docPath = new URL(page.url()).pathname;
    const title = page.getByLabel('Workscape title');
    await title.fill(RUN_TITLE);
    await title.press('Enter');
    await expect(page.getByTestId('sync-status')).toHaveText(/Synced/);
  });

  await test.step('type in a cell; the edit renders at once and syncs behind it', async () => {
    await page.getByRole('button', { name: 'Add table' }).click();
    await firstCell(page).click();
    await page.keyboard.type(CELL_TEXT);
    await expect(page.getByLabel('Edit B5')).toHaveText(CELL_TEXT);
    await page.keyboard.press('Enter');
    await expect(firstCell(page)).toHaveText(CELL_TEXT);
    await expect(page.getByTestId('sync-status')).toHaveText(/Synced/);
    // Let the update leave the socket before the page is torn down (the service appends
    // it to doc_updates before fanning it out, so once sent it is durable).
    await page.waitForTimeout(1_000);
  });

  await test.step('a reload signs in again (tokens are memory-only) and returns to the document with the text', async () => {
    await page.reload();
    await expect(page).toHaveURL(/\/sign-in$/);
    await signIn(page, docPath);
    await expect(page.getByLabel('Workscape title')).toHaveValue(RUN_TITLE);
    await expect(firstCell(page)).toHaveText(CELL_TEXT);
  });

  await test.step('a fresh browser (no local replica) also shows it: the service persisted the edit', async () => {
    const context = await browser.newContext();
    try {
      const fresh = await context.newPage();
      await signIn(fresh, docPath);
      await expect(fresh.getByLabel('Workscape title')).toHaveValue(RUN_TITLE);
      await expect(firstCell(fresh)).toHaveText(CELL_TEXT);
    } finally {
      await context.close();
    }
  });

  await test.step('find reaches the cell', async () => {
    await page.keyboard.press('Control+KeyF');
    const bar = page.getByRole('search', { name: 'Find' });
    await expect(bar).toBeVisible();
    await page.getByRole('textbox', { name: 'Find' }).fill(CELL_TEXT);
    await expect(page.getByTestId('find-count')).toHaveText('1 of 1');
    await page.keyboard.press('Escape');
    await expect(bar).toBeHidden();
  });

  await test.step('the share sheet opens and closes', async () => {
    await page.getByRole('button', { name: 'Share' }).click();
    const sheet = page.getByRole('dialog', { name: `Share ${RUN_TITLE}` });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Only you, so far.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  await test.step('delete it, then Delete All from Recently Deleted (permanent, says so)', async () => {
    await page.getByRole('link', { name: 'Back to my workscapes' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recents');
    const row = page.getByRole('row').filter({ hasText: RUN_TITLE });
    await row.click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.gd-toast')).toContainText(
      `“${RUN_TITLE}” moved to Recently Deleted`,
    );
    await page.getByRole('button', { name: 'Recently Deleted' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recently Deleted');
    await expect(page.getByRole('row').filter({ hasText: RUN_TITLE })).toBeVisible();
    await page.getByRole('button', { name: 'Delete All' }).click();
    const confirm = page.getByRole('alertdialog', { name: /^Permanently delete / });
    await expect(confirm).toContainText('This cannot be undone.');
    await confirm.getByRole('button', { name: 'Delete All' }).click();
    await expect(page.getByRole('row').filter({ hasText: RUN_TITLE })).toHaveCount(0);
  });

  await test.step('sign out leaves nothing on this device', async () => {
    await page.getByRole('button', { name: /^Account: / }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Signed out of GeDe');
    await expect(
      page.getByText(/Nothing is left on this device\./),
    ).toBeVisible();
    // The session really is gone: the library is a sign-in again.
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
