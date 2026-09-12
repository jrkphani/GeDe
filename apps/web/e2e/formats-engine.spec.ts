/**
 * Column formats reach the formula engine (issue #122; FMT-02, FMT-03,
 * FMT-05, FX-02). The journey is the final audit's repro, step for step, at
 * 1440 in light and dark with axe on both: an SGD column with one cell
 * overridden to INR, an SGD column summed with a USD column, a Number column
 * with a date and an amount in it, and the `=` forms menu on a Number column
 * and on a Text column. Same labelled FAKES at the network edge as
 * `formulas.spec.ts`; the SPA, the Yjs replica and the formula Worker run
 * for real. The column formats arrive from a collaborator's replica (the
 * fake room's document); the cell override is applied through the inspector
 * so the live re-evaluation path is the one exercised.
 */
import type { Page } from '@playwright/test';
import {
  createSheet,
  createTable,
  openDocument,
  setColumnFormat,
  tableById,
  type Id,
} from '@gede/core';
import { expect, test } from './fixtures/test.js';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000f122';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-122',
  email: 'shankar@1cloudhub.com',
  name: 'Shankar',
};

const CONFIG = {
  region: SESSION.region,
  userPoolId: SESSION.userPoolId,
  userPoolClientId: SESSION.clientId,
  apiUrl: '/api',
  wsUrl: '/ws',
  appleSignIn: false,
  statusUrl: null,
};

/** The exact shape `services/sync` returns for GET /api/documents/:id. */
const record = {
  id: DOC_ID,
  title: 'Audit fx',
  ownerId: SESSION.sub,
  permission: 'owner',
  linkAccess: 'none',
  updatedAt: '2026-09-13T00:00:00.000Z',
  deletedAt: null,
};

/** Intl separates a code from its amount with a no-break space; `\s` matches it. */
const sp = '\\s';

async function installFakes(page: Page): Promise<{ room: FakeRoom; tableId: Id }> {
  await page.route('**/config.json', (route) => route.fulfill({ json: CONFIG }));
  await installFakeCognito(page, SESSION);
  await page.route(`**/api/documents/${DOC_ID}`, (route) =>
    route.fulfill({ json: { document: record } }),
  );
  await page.route(/\/api\/documents(\?.*)?$/, (route) =>
    route.fulfill({ json: { documents: [record] } }),
  );
  await page.route('**/api/me', (route) =>
    route.fulfill({
      json: {
        id: SESSION.sub,
        sub: SESSION.sub,
        email: SESSION.email,
        displayName: SESSION.name,
        locale: 'en-US',
      },
    }),
  );
  const room = new FakeRoom({ viewOnly: false });
  await room.install(page);
  // A collaborator has already laid out the audit's table: seven columns B–H at (1, 1), data rows
  // 5–13, with B Number (6 places), C Currency SGD, E Currency USD and G Text (FMT-06).
  const gd = openDocument(room.doc);
  const sheet = createSheet(gd, { label: 'Audit' });
  const tableId = createTable(gd, { sheetId: sheet, at: { col: 1, row: 1 }, columns: 7, rows: 9 });
  const t = tableById(gd, tableId);
  if (t === null) throw new Error('no table');
  const col = (i: number): Id => {
    const id = t.columns[i]?.id;
    if (id === undefined) throw new Error(`no column ${String(i)}`);
    return id;
  };
  setColumnFormat(gd, tableId, col(0), 'number', { decimals: 6 });
  setColumnFormat(gd, tableId, col(1), 'currency', { currency: 'SGD', decimals: 2 });
  setColumnFormat(gd, tableId, col(3), 'currency', { currency: 'USD', decimals: 2 });
  setColumnFormat(gd, tableId, col(5), 'text');
  return { room, tableId };
}

async function signInTo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill(SESSION.email);
  await page.getByLabel('Email').press('Enter');
  await page.getByRole('button', { name: 'Email me a one-time code' }).click();
  await page.getByLabel('Six-digit code').fill(FAKE_CODE);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  const notNow = page.getByRole('button', { name: 'Not now' });
  const target = new RegExp(`${path.replace('?', '\\?')}$`);
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(target, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page).toHaveURL(target);
}

/** Type into a cell through the rich editor: double-click, fill, Enter. */
async function enter(page: Page, address: string, text: string): Promise<void> {
  const cell = page.locator(`[data-address="${address}"]`);
  await cell.dblclick();
  const editor = page.getByLabel(`Edit ${address}`);
  await editor.fill(text);
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
}

const cell = (page: Page, address: string) => page.locator(`[data-address="${address}"]`);
const value = (page: Page, address: string) =>
  cell(page, address).getByTestId('formula-cell').locator('.gd-formula__value');
const errorText = (page: Page, address: string) =>
  cell(page, address).getByTestId('formula-cell').locator('.gd-formula__error-text');

/** Open the `=` forms menu on a cell and return the Sum option; the caller closes it. */
async function sumOption(page: Page, address: string) {
  await cell(page, address).dblclick();
  const editor = page.getByLabel(`Edit ${address}`);
  await editor.fill('=');
  const forms = page.getByRole('listbox', { name: 'Formula forms' });
  await expect(forms).toBeVisible();
  return forms.getByRole('option', { name: /Sum/ });
}

/**
 * Close the forms menu and cancel the edit as a person does: Escape closes
 * the list, a second Escape cancels the editor (KEYS-06 ordering). The
 * closed Popover unmounts at once, so the second Escape reaches the editor.
 */
async function closeMenuAndEditor(page: Page, address: string): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Formula forms' })).toHaveCount(0);
  const editor = page.getByLabel(`Edit ${address}`);
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(cell(page, address)).toHaveText('');
}

test.describe('formats and the formula engine (#122)', () => {
  test('FMT-03 FMT-02 FMT-05 FX-02 A11Y-04 mixed currencies are an error never a conversion; results take the column format right-aligned; invalid cells are excluded not coerced; Sum is offered by format — 1440 light and dark', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(cell(page, 'B5')).toBeVisible();
    await expect(page.getByTestId('formula-engine')).toHaveAttribute('data-mode', 'worker');

    // Step 1 — SGD column: typed amounts render in the column's code with accounting negatives.
    await enter(page, 'C5', '100');
    await enter(page, 'C6', '-45.5');
    await enter(page, 'C7', '2500');
    await expect(cell(page, 'C5').locator('.gd-rich')).toHaveText(new RegExp(`^SGD${sp}100\\.00$`));
    await expect(cell(page, 'C6').locator('.gd-rich')).toHaveText(
      new RegExp(`^\\(SGD${sp}45\\.50\\)$`),
    );
    await expect(cell(page, 'C7').locator('.gd-rich')).toHaveText(
      new RegExp(`^SGD${sp}2,500\\.00$`),
    );

    // Step 3 — the Sum takes the column's format (PRD §22): code, decimals, right-aligned.
    await enter(page, 'C8', '=Sum(C5:C7)');
    await expect(value(page, 'C8')).toHaveText(new RegExp(`^SGD${sp}2,554\\.50$`));
    await expect(value(page, 'C8')).toHaveAttribute('data-align', 'right');
    await expect(value(page, 'C8')).toHaveCSS('text-align', 'right');

    // Step 2 — C7 alone becomes INR through the inspector (cell scope, FMT-06 sentence first).
    await cell(page, 'C7').click();
    const rail = page.getByTestId('inspector');
    await rail.getByRole('tab', { name: 'Cell' }).click();
    const format = rail.getByRole('region', { name: 'data format' });
    await format.getByRole('radio', { name: 'Cell C7' }).click();
    await expect(format).toContainText('Formats cell C7 as Currency (SGD)');
    await format.getByRole('combobox', { name: 'Currency' }).click();
    await page.getByRole('option', { name: 'INR' }).click();
    await expect(cell(page, 'C7').locator('.gd-rich')).toHaveText(/^₹2,500\.00$/);
    // FMT-03 "Summing mixed currencies is an error, never a conversion": the Sum re-evaluates
    // on the format change alone and names the offender (A11Y-04: icon and text).
    await expect(errorText(page, 'C8')).toHaveText('mixed currencies');
    await expect(
      cell(page, 'C8').getByRole('img', { name: 'C7 is in INR; the sum so far is in SGD' }),
    ).toBeVisible();

    // Step 4 — an SGD column summed with a USD column is the same error.
    await enter(page, 'E5', '10');
    await enter(page, 'E6', '=Sum(C5, E5)');
    await expect(errorText(page, 'E6')).toHaveText('mixed currencies');
    await expect(
      cell(page, 'E6').getByRole('img', { name: 'E5 is in USD; the sum so far is in SGD' }),
    ).toBeVisible();

    // Step 5 — Number column, 6 places: a date and an amount are invalid (tinted, glyph, text),
    // excluded from the Sum and never coerced; `S$12` is not 12.
    await enter(page, 'B5', '1,234.50');
    await enter(page, 'B6', '12/9/2026');
    await enter(page, 'B7', 'S$12');
    await enter(page, 'B8', '-45');
    await expect(cell(page, 'B5').locator('.gd-rich')).toHaveText('1,234.500000');
    for (const invalid of ['B6', 'B7']) {
      const rich = cell(page, invalid).locator('.gd-rich');
      await expect(rich).toHaveClass(/gd-rich--invalid/);
      await expect(rich.locator('svg[data-name="warning"]')).toBeVisible();
      await expect(rich.getByText('Not a number')).toBeAttached();
    }
    await expect(cell(page, 'B7').locator('.gd-rich')).toContainText('S$12');
    await enter(page, 'B9', '=Sum(B5:B8)');
    await expect(value(page, 'B9')).toHaveText('1,189.500000');
    await expect(value(page, 'B9')).toHaveAttribute('data-align', 'right');
    await enter(page, 'B12', '=Sum(B5, B8, B13)');
    await expect(value(page, 'B12')).toHaveText('1,189.500000');

    // Step 6 — FX-02 "Offered only when the column is Number or Currency": by format, not contents.
    await enter(page, 'G5', '1');
    await enter(page, 'G6', '2');
    const onText = await sumOption(page, 'G7');
    await expect(onText).toHaveAttribute('aria-disabled', 'true');
    await expect(onText).toContainText('Sum is offered on Number or Currency columns');
    await closeMenuAndEditor(page, 'G7');
    const onNumber = await sumOption(page, 'B10');
    await expect(onNumber).not.toHaveAttribute('aria-disabled');
    await closeMenuAndEditor(page, 'B10');

    await cell(page, 'C8').click();
    await snapshot('formats engine 1440 light');
    await checkA11y('formats engine 1440 light');

    // Dark by OS preference: the same results, the same errors, axe again.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe('dark');
    await expect(errorText(page, 'C8')).toHaveText('mixed currencies');
    await expect(value(page, 'B9')).toHaveText('1,189.500000');
    await snapshot('formats engine 1440 dark');
    await checkA11y('formats engine 1440 dark');
  });
});
