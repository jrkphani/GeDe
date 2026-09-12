/**
 * Formula journeys against the built bundle (FX-02, FX-06, FX-07, FX-08,
 * A11Y-04). Same labelled FAKES at the network edge as `document.spec.ts`
 * (Cognito, the documents REST API, the y-websocket room); the SPA, the Yjs
 * replica and the formula Worker run for real.
 *
 * Entry goes through the grid editor with the formula adornments mounted:
 * the `=` forms menu, `@` autocomplete and click-to-insert are the product.
 */
import type { Page } from '@playwright/test';
import { insertRowBefore, openDocument, setRowWrapped, tableRecord } from '@gede/core';
import { expect, test } from './fixtures/test.js';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000e2e1';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-2',
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
  title: 'Trek budget',
  ownerId: SESSION.sub,
  permission: 'owner',
  linkAccess: 'none',
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
};

async function installFakes(page: Page): Promise<FakeRoom> {
  await page.route('**/config.json', (route) => route.fulfill({ json: CONFIG }));
  await installFakeCognito(page, SESSION);
  await page.route(`**/api/documents/${DOC_ID}`, (route) =>
    route.fulfill({ json: { document: record } }),
  );
  await page.route('**/api/documents', (route) => route.fulfill({ json: { documents: [record] } }));
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
  return room;
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

test.describe('formulas', () => {
  test('FX-02 FX-04 FX-05 FX-06 FX-07 FX-08 A11Y-04 a Sum entered by clicking cells shows value, badge and expression; dependents update; operands outline at two zoom levels; the Worker evaluates', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    // The table sits at (1, 1): title bar + header put its first data cell at B5 (rows 5–9).
    await expect(page.locator('[data-address="B5"]')).toBeVisible();
    // Evaluation runs in the Worker, not on the main thread.
    await expect(page.getByTestId('formula-engine')).toHaveAttribute('data-mode', 'worker');
    await enter(page, 'B5', '1200');
    await enter(page, 'B6', '34');

    // FX-02: `=` opens the forms menu without taking focus; Sum is offered on a number column.
    const b7 = page.locator('[data-address="B7"]');
    await b7.dblclick();
    const editor = page.getByLabel('Edit B7');
    await editor.fill('=');
    const forms = page.getByRole('listbox', { name: 'Formula forms' });
    await expect(forms).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(forms.getByRole('option', { name: /Sum/ })).not.toHaveAttribute('aria-disabled');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(editor).toHaveText('=Sum(');
    await expect(editor).toBeFocused();

    // FX-05: clicking cells inserts their addresses with separators; the outline follows the draft.
    await page.locator('[data-address="B5"]').click();
    await expect(editor).toHaveText('=Sum(B5');
    await expect(editor).toBeFocused();
    await page.locator('[data-address="B6"]').click();
    await expect(editor).toHaveText('=Sum(B5, B6');
    const outlines = page.getByTestId('reference-outlines');
    await expect(outlines.locator('.gd-outline')).toHaveCount(2);
    await editor.press('End');
    await editor.pressSequentially(')');
    await editor.press('Enter');
    await expect(editor).toHaveCount(0);

    // PRD §20: the stored formula is id-bound; what the person sees is projected.
    await expect
      .poll(() => JSON.stringify(room.doc.getMap('tables').toJSON()))
      .toMatch(/=Sum\(\{c:[0-9A-Z:]+\}, \{c:[0-9A-Z:]+\}\)/);

    // FX-07: value and reference badge in the cell; in a compact row the expression is the tooltip.
    const formula = b7.getByTestId('formula-cell');
    await expect(formula.locator('.gd-formula__value')).toHaveText('1,234');
    await expect(formula.getByLabel('Formula, 2 references')).toHaveText('ƒ2');
    await expect(b7).toHaveAttribute('title', '=Sum(B5, B6)');
    await expect(formula.locator('.gd-formula__expr')).toHaveCount(0);

    // A collaborator wraps row 7 (GRID-09: two lattice rows): the expression takes the second line.
    await expect.poll(() => room.doc.getMap('tables').size).toBe(1);
    const gd = openDocument(room.doc);
    const tableId = Array.from(gd.tables.keys())[0] ?? '';
    const record = tableRecord(gd.tables.get(tableId)!);
    setRowWrapped(gd, record.id, record.rows[2] ?? '', true);
    await expect(b7).toHaveCSS('height', '44px');
    await expect(formula.locator('.gd-formula__expr')).toHaveText('=Sum(B5, B6)');

    // FX-08: selecting the formula cell outlines each operand with its index badge.
    await b7.click();
    const first = outlines.locator('.gd-outline').first();
    await expect(outlines.locator('.gd-outline')).toHaveCount(2);
    await expect(first).toHaveAttribute('data-operand', '1');
    await expect(first).toHaveAttribute('data-label', 'B5');
    await expect(first).toHaveCSS('left', '160px');
    await expect(first).toHaveCSS('top', '88px');
    await expect(first).toHaveCSS('height', '22px');
    await expect(first.locator('.gd-outline__index')).toHaveText('1');
    await expect(outlines.locator('.gd-outline').nth(1).locator('.gd-outline__index')).toHaveText(
      '2',
    );
    const strokeAt1 = await first.evaluate((el) => getComputedStyle(el).borderTopColor);
    await snapshot('formula sum outlined at 100%');

    // Outlines follow zoom: the block keeps its lattice geometry inside the scaled layer,
    // the stroke is drawn in the operand's colour at both levels.
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByTestId('layer')).toHaveAttribute('style', /scale\(1\.22\)/);
    await expect(first).toHaveCSS('left', '160px');
    await expect(first).toHaveCSS('height', '22px');
    await expect(outlines).toHaveAttribute('style', /--gd-zoom:\s*1\.22/);
    expect(await first.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(strokeAt1);
    await snapshot('formula sum outlined at 122%');
    await checkA11y('document with a formula');
    await page.getByRole('button', { name: 'Zoom out' }).click();

    // FX-06 / PRD §20: a collaborator inserts a row above the operands; the value holds and
    // the expression re-spells to where the cells sit now.
    insertRowBefore(gd, tableId, record.rows[0] ?? '');
    const b8 = page.locator('[data-address="B8"]');
    await expect(b8.getByTestId('formula-cell').locator('.gd-formula__value')).toHaveText('1,234');
    await expect(b8).toHaveAttribute('title', '=Sum(B6, B7)');

    // FX-06: editing a referenced cell updates the dependent.
    await enter(page, 'B7', '66');
    await expect(b8.getByTestId('formula-cell').locator('.gd-formula__value')).toHaveText('1,266');

    // FX-02 / A11Y-04: text in range is an error with icon and text, naming the offender.
    await enter(page, 'B7', 'camp');
    await expect(b8.locator('.gd-formula__error-text')).toHaveText('text in range');
    await expect(
      b8.getByRole('img', { name: 'B7 holds text, so it cannot be summed' }),
    ).toBeVisible();

    // FX-07: re-opening the cell restores the expression, not the value.
    await b8.dblclick();
    await expect(page.getByLabel('Edit B8')).toHaveText('=Sum(B6, B7)');
    await page.keyboard.press('Escape');

    // FX-08: outlines clear on deselect.
    await page.keyboard.press('Escape');
    await expect(outlines).toHaveCount(0);
    await expect(page.getByTestId('formula-engine')).toHaveAttribute('data-mode', 'worker');
    await expect(page.getByTestId('formula-engine')).toHaveAttribute('data-restarts', '0');
  });

  test('FX-04 @ opens the workbook entity index and inserts the dotted path; the reference follows the row when its label changes', async ({
    page,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    await enter(page, 'B5', 'Lukla');
    await enter(page, 'C5', '2860');
    const d5 = page.locator('[data-address="D5"]');
    await d5.dblclick();
    const editor = page.getByLabel('Edit D5');
    await editor.fill('=Sum(@Luk');
    const list = page.getByRole('listbox', { name: 'Entities' });
    await expect(list).toBeVisible();
    await expect(list).toContainText('@"Table 1".Lukla');
    await expect(editor).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor).toHaveText('=Sum(@"Table 1".Lukla');
    await expect(editor).toBeFocused();
    await editor.press('End');
    await editor.pressSequentially('."Column 2")');
    await editor.press('Enter');
    await expect(d5.getByTestId('formula-cell').locator('.gd-formula__value')).toHaveText('2,860');
    await expect(d5).toHaveAttribute('title', '=Sum(@"Table 1".Lukla."Column 2")');
    // The row is bound by id: renaming its label re-spells the path and keeps the value.
    await enter(page, 'B5', 'Lukla airstrip');
    await expect(d5).toHaveAttribute('title', '=Sum(@"Table 1"."Lukla airstrip"."Column 2")');
    await expect(d5.getByTestId('formula-cell').locator('.gd-formula__value')).toHaveText('2,860');
    await expect.poll(() => JSON.stringify(room.doc.getMap('tables').toJSON())).toMatch(/\{e:/);
  });

  test('FX-06 a reference loop reports circular on every member, and a formula may read a formula', async ({
    page,
  }) => {
    await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    await enter(page, 'B5', '2');
    await enter(page, 'B6', '=Sum(B5)');
    await enter(page, 'B7', '=Sum(B6, B5)');
    await expect(
      page.locator('[data-address="B7"]').getByTestId('formula-cell').locator('.gd-formula__value'),
    ).toHaveText('4');
    await enter(page, 'B5', '=Sum(B7)');
    await expect(page.locator('.gd-formula__error-text')).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      await expect(page.locator('.gd-formula__error-text').nth(i)).toHaveText('circular');
    }
  });
});
