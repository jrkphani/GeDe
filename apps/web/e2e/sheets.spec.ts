/**
 * Sheet-tab journeys (ADR-048, #165): the tab's menu, inline rename, delete
 * with its toast and undo, the strip owning ⌫ — against the built bundle at
 * 1024 and 1440 px, light and dark, with axe on every new surface; the
 * pointer routes at 1440; the phone at 480. Everything outside the browser
 * is a labelled FAKE at the network edge: Cognito (`fakes/cognito`), the
 * documents REST API (routes below) and the y-websocket room (`fakes/room`).
 */
import { asDesktop, asPhone, expect, test, type Breakpoint } from './fixtures/test.js';
import type { Locator, Page } from '@playwright/test';
import { FAKE_SIGN_IN_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import {
  commitCellText,
  createSheet,
  createTable,
  listSheets,
  openDocument,
  setCellText,
  tableById,
} from '@gede/core';

const DOC_ID = '6f1b2c3d-0000-4000-8000-000000005hee';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-1',
  email: 'meena@1cloudhub.com',
  name: 'Meena',
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
  title: 'Everest trek',
  ownerId: SESSION.sub,
  permission: 'owner',
  linkAccess: 'none',
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
};

/** The suite's device profile (Desktop Chrome) reports a Windows UA, so `mod` resolves to Ctrl (I18N-02). */
const mod = 'Control';

async function installFakes(page: Page): Promise<FakeRoom> {
  await page.route('**/config.json', (route) => route.fulfill({ json: CONFIG }));
  await installFakeCognito(page, SESSION);
  await page.route(`**/api/documents/${DOC_ID}`, (route) =>
    route.fulfill({ json: { document: record } }),
  );
  await page.route(/\/api\/documents\?view=/, (route) =>
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
  const room = new FakeRoom();
  await room.install(page);
  // Two sheets: Trek holds a formula that reads Places, a table on Budget (REF-01).
  const gd = openDocument(room.doc);
  const trek = createSheet(gd, { label: 'Trek' });
  const budget = createSheet(gd, { label: 'Budget' });
  const places = createTable(gd, {
    sheetId: budget,
    at: { col: 1, row: 1 },
    columns: 2,
    rows: 2,
    title: 'Places',
  });
  const p = tableById(gd, places)!;
  setCellText(gd, places, p.rows[0]!, p.columns[0]!.id, 'Singapore');
  setCellText(gd, places, p.rows[0]!, p.columns[1]!.id, 'Hub');
  const plan = createTable(gd, {
    sheetId: trek,
    at: { col: 1, row: 1 },
    columns: 2,
    rows: 2,
    title: 'Plan',
  });
  const r = tableById(gd, plan)!;
  setCellText(gd, plan, r.rows[0]!, r.columns[0]!.id, 'Base');
  commitCellText(gd, plan, r.rows[0]!, r.columns[1]!.id, '=@Places.Singapore');
  return room;
}

/** AUTH-01: a cold visit to the document lands on sign-in and returns after the code. */
async function signInTo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill(SESSION.email);
  await page.getByLabel('Email').press('Enter');
  await page.getByRole('button', { name: 'Email me a one-time code' }).click();
  await page.getByLabel('Eight-digit code').fill(FAKE_SIGN_IN_CODE);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  const notNow = page.getByRole('button', { name: 'Not now' });
  const target = new RegExp(`${path.replace('?', '\\?')}$`);
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(target, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page).toHaveURL(target);
}

async function openDoc(page: Page, width: Breakpoint, theme: 'light' | 'dark' = 'light') {
  const room = await installFakes(page);
  await (width < 768 ? asPhone(page, width, 900) : asDesktop(page, width, 900));
  await signInTo(page, `/d/${DOC_ID}`);
  await expect(page.getByRole('tab', { name: /1°.*Trek/ })).toBeVisible();
  await expect(page.getByRole('grid').first()).toBeVisible();
  if (theme === 'dark') {
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
  }
  return room;
}

const strip = (page: Page) => page.getByRole('tablist', { name: 'Sheets' });
/** A surface that fades in (the menu, the toast) is measured by axe only once it has landed. */
const settled = (surface: Locator) =>
  surface.evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined),
  );
/** The room's sheet labels, in strip order — what every client will show. */
const sheetLabels = (room: FakeRoom) => listSheets(openDocument(room.doc)).map((s) => s.label);
const live = (page: Page) => page.getByTestId('live-region');
/** The reference cell on Trek that reads Places (REF-01): `Plan` C5 (title rows 1–2, header 3, data from 4; at B). */
const readerCell = (page: Page) =>
  page.locator('[data-address="C5"]').getByTestId('reference-cell');
const readerValue = (page: Page) => readerCell(page).locator('.gd-ref__value');
const readerError = (page: Page) => readerCell(page).locator('.gd-ref__error-text');

/**
 * Reach the sheet strip with the keyboard alone (A11Y-01): the strip is the
 * last chrome in the document, so ⇧Tab from the document's end lands on it
 * (Tab forward never leaves a table — GRID-05 appends a row).
 */
async function tabToStrip(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Shift+Tab');
    const onTab = await page.evaluate(
      () => document.activeElement?.closest('.gd-doc__sheets [role="tab"]') !== null,
    );
    if (onTab) return;
  }
  throw new Error('the sheet strip is not reachable by ⇧Tab');
}

for (const width of [1024, 1440] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`DOC-03 MENU-01 MENU-02 MENU-05 KEYS-01 KEYS-03 KEYS-08 A11Y-01 A11Y-02 A11Y-05 REF-01 FX-06 LIB-D9 at ${String(width)} ${theme}, mouse unplugged: Tab to the strip, F2 renames, ${mod}+Z restores the name, Shift+F10 opens the tab menu, Delete sheet removes the sheet and its table with a toast and an announcement, the cross-sheet formula reads “reference removed”, ${mod}+Z brings everything back in one step`, async ({
      page,
      checkA11y,
      snapshot,
    }) => {
      const room = await openDoc(page, width, theme);
      await expect(readerValue(page)).toHaveText('Singapore');
      await tabToStrip(page);
      await page.keyboard.press('ArrowRight');
      const budget = page.getByRole('tab', { name: /2°.*Budget/ });
      await expect(budget).toBeFocused();
      await expect(budget).toHaveAttribute('aria-selected', 'true');
      // F2: the name field stands in for the tab, selected, not inside a tab button.
      await page.keyboard.press('F2');
      const field = page.getByRole('textbox', { name: 'Sheet name' });
      await expect(field).toBeFocused();
      await expect(field).toHaveValue('Budget');
      expect(await field.evaluate((el) => el.closest('[role="tab"]'))).toBeNull();
      await checkA11y(`sheet rename ${String(width)} ${theme}`);
      await snapshot(`sheet-rename-${String(width)}-${theme}`);
      await page.keyboard.type('Costs');
      await page.keyboard.press('Enter');
      const costs = page.getByRole('tab', { name: /2°.*Costs/ });
      await expect(costs).toBeVisible();
      await expect(costs).toBeFocused();
      await expect(live(page)).toHaveText('Renamed Budget to Costs');
      await expect.poll(() => sheetLabels(room)[1]).toBe('Costs');
      // One undo step: the old name is back.
      await page.keyboard.press(`${mod}+KeyZ`);
      await expect(page.getByRole('tab', { name: /2°.*Budget/ })).toBeVisible();
      await expect.poll(() => sheetLabels(room)[1]).toBe('Budget');
      // Shift+F10 on the focused tab: the sheet menu, in MENU-01 order, with the chords (KEYS-08).
      await page.getByRole('tab', { name: /2°.*Budget/ }).focus();
      await page.keyboard.press('Shift+F10');
      const menu = page.getByRole('menu', { name: 'Sheet menu' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem')).toHaveText([
        /Add sheet/,
        /Rename sheet\s*F2/,
        /Delete sheet\s*⌫/,
      ]);
      await settled(menu);
      await checkA11y(`sheet menu ${String(width)} ${theme}`);
      await snapshot(`sheet-menu-${String(width)}-${theme}`);
      await page.keyboard.press('End');
      await expect(menu.getByRole('menuitem', { name: /Delete sheet/ })).toBeFocused();
      await page.keyboard.press('Enter');
      // The sheet, its table and its binding went; the reader on Trek says so; the toast offers Undo.
      await expect(strip(page).getByRole('tab')).toHaveCount(1);
      const trek = page.getByRole('tab', { name: /1°.*Trek/ });
      await expect(trek).toHaveAttribute('aria-selected', 'true');
      await expect(trek).toBeFocused();
      await expect(live(page)).toHaveText(
        'Deleted Budget with 1 table — 1 cell elsewhere now reads “reference removed”; press ⌘Z to undo. Now on Sheet 1, Trek',
      );
      await expect(readerError(page)).toHaveText('reference removed');
      const undo = page.getByRole('button', { name: 'Undo' });
      await expect(undo).toBeVisible();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect.poll(() => room.doc.getArray('sheets').length).toBe(1);
      await expect.poll(() => room.doc.getMap('tables').size).toBe(1);
      await settled(undo.locator('..'));
      await checkA11y(`sheet deleted toast ${String(width)} ${theme}`);
      await snapshot(`sheet-deleted-toast-${String(width)}-${theme}`);
      // ⌘Z: the sheet, its table and the formula's value are back in one step, and it is shown.
      await page.keyboard.press(`${mod}+KeyZ`);
      const back = page.getByRole('tab', { name: /2°.*Budget.*1 object/ });
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute('aria-selected', 'true');
      await expect(live(page)).toHaveText('Restored Budget');
      await expect.poll(() => room.doc.getArray('sheets').length).toBe(2);
      await expect.poll(() => room.doc.getMap('tables').size).toBe(2);
      await page.getByRole('tab', { name: /1°.*Trek/ }).click();
      await expect(readerValue(page)).toHaveText('Singapore');
      await expect(readerError(page)).toHaveCount(0);
    });
  }
}

test('DOC-03 MENU-01 MENU-02 MENU-05 RESP-03 at 1440 by pointer: right-click → Rename sheet opens the field, a double-click opens it too, Escape keeps the old name; the last sheet’s Delete is disabled with the reason and ⌫ on it announces why', async ({
  page,
  checkA11y,
}) => {
  const room = await openDoc(page, 1440);
  const budget = page.getByRole('tab', { name: /2°.*Budget/ });
  await budget.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Sheet menu' });
  await expect(menu).toBeVisible();
  // A right-click on the inactive tab did not select it (MENU-01).
  await expect(page.getByRole('tab', { name: /1°.*Trek/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await menu.getByRole('menuitem', { name: /Rename sheet/ }).click();
  const field = page.getByRole('textbox', { name: 'Sheet name' });
  await expect(field).toBeFocused();
  await page.keyboard.type('Nope');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab', { name: /2°.*Budget/ })).toBeVisible();
  // Budget was not the shown sheet: focusing its tab would select it (Radix activates on
  // focus), so the keyboard lands on the active tab and Trek stays the shown sheet.
  await expect(page.getByRole('tab', { name: /1°.*Trek/ })).toBeFocused();
  await expect(page.getByRole('tab', { name: /1°.*Trek/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: /2°.*Budget/ }).dblclick();
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  // Delete Budget by pointer, then the only sheet left cannot go.
  await page.getByRole('tab', { name: /2°.*Budget/ }).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /Delete sheet/ }).click();
  await expect(strip(page).getByRole('tab')).toHaveCount(1);
  await expect.poll(() => room.doc.getArray('sheets').length).toBe(1);
  const trek = page.getByRole('tab', { name: /1°.*Trek/ });
  await trek.click({ button: 'right' });
  const del = menu.getByRole('menuitem', { name: /Delete sheet/ });
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  await expect(del).toHaveAttribute('title', 'a workscape keeps at least one sheet');
  await settled(menu);
  await checkA11y('sheet menu last sheet 1440');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trek).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(live(page)).toHaveText('A workscape keeps at least one sheet');
  await expect(strip(page).getByRole('tab')).toHaveCount(1);
});

test('RESP-02 at 480 the phone keeps its sheets: no menu on a tab, no rename on F2 or a double-tap, nothing on ⌫', async ({
  page,
  checkA11y,
}) => {
  const room = await openDoc(page, 480);
  const budget = page.getByRole('tab', { name: /2°.*Budget/ });
  await budget.click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await budget.dblclick();
  await expect(page.getByRole('textbox', { name: 'Sheet name' })).toHaveCount(0);
  await budget.focus();
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'Sheet name' })).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect(strip(page).getByRole('tab')).toHaveCount(2);
  expect(room.doc.getArray('sheets').length).toBe(2);
  await expect(page.getByRole('button', { name: 'Add sheet' })).toHaveCount(0);
  await checkA11y('sheet strip phone 480');
});
