/**
 * Set tables, phase 5 (SET-13..18; ADR-056, SPEC §3–4): a sheet with two sections shows its
 * lanes, the section summaries, the sheet summary, U and the super set array; `@U` reads the
 * sheet's universal set; Rename section… and Lock / Unlock work from the lane's menu and the
 * keyboard, and a locked section or sheet refuses edits with its reason. Against the built
 * bundle at 1440 and 1024 px, axe on every new surface. Everything outside the browser is a
 * labelled FAKE at the network edge: Cognito (`fakes/cognito`), the documents REST API and
 * the room (`fakes/room`).
 */
import type { Page } from '@playwright/test';
import {
  addRow,
  addSection,
  createSheet,
  createTable,
  isSheetLocked,
  listSections,
  listSheets,
  openDocument,
  renameColumn,
  setCellText,
  tableRecord,
  type GedeDoc,
  type Id,
} from '@gede/core';
import { asDesktop, expect, test } from './fixtures/test.js';
import { FAKE_SIGN_IN_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-0000000se561';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-561',
  email: 'priya@1cloudhub.com',
  name: 'Priya',
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
const record = {
  id: DOC_ID,
  title: 'Structure',
  ownerId: SESSION.sub,
  permission: 'owner',
  linkAccess: 'none',
  updatedAt: '2026-10-10T00:00:00.000Z',
  deletedAt: null,
};

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
  return room;
}

async function signInTo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill(SESSION.email);
  await page.getByLabel('Email').press('Enter');
  await page.getByRole('button', { name: 'Email me a one-time code' }).click();
  await page.getByLabel('Eight-digit code').fill(FAKE_SIGN_IN_CODE);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  const notNow = page.getByRole('button', { name: 'Not now' });
  const target = new RegExp(`${path}$`);
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(target, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page).toHaveURL(target);
}

function seedSet(gd: GedeDoc, sheetId: Id, title: string, col: number, elements: string[]): Id {
  const id = createTable(gd, {
    sheetId,
    at: { col, row: 1 },
    columns: 2,
    rows: 1,
    title,
    kind: 'simple',
  });
  const [range, description] = tableRecord(gd.tables.get(id)!).columns;
  renameColumn(gd, id, range!.id, 'range');
  renameColumn(gd, id, description!.id, 'description');
  for (let i = 1; i < elements.length; i += 1) addRow(gd, id);
  tableRecord(gd.tables.get(id)!).rows.forEach((rowId, i) => {
    setCellText(gd, id, rowId, range!.id, elements[i] ?? '');
  });
  return id;
}

for (const width of [1440, 1024] as const) {
  test(`SET-13 SET-14 SET-15 SET-16 SET-17 at ${String(width)} px: lanes, the section summary, the sheet summary, U and the super set array`, async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    const sheetId = createSheet(seeded);
    addSection(seeded, sheetId, { name: 'Foundation', firstColumn: 0, lastColumn: 4 });
    addSection(seeded, sheetId, { name: 'Pairs', firstColumn: 6, lastColumn: 8 });
    seedSet(seeded, sheetId, 'E', 1, ['a', 'b', 'c']);
    seedSet(seeded, sheetId, 'C', 3, ['b', 'c', 'x']);
    seedSet(seeded, sheetId, 'B', 6, ['x', 'y']);
    await asDesktop(page, width, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'B' })).toBeVisible();

    // SET-17: two named lanes with guide lines; the gutter column (5) is empty.
    const lanes = page.getByTestId('section-lane');
    await expect(lanes).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Foundation' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pairs' })).toBeVisible();
    const first = (await lanes.nth(0).boundingBox())!;
    const second = (await lanes.nth(1).boundingBox())!;
    expect(second.x - (first.x + first.width)).toBeGreaterThan(0);

    // SET-15: the section summary — twelve columns, one row per set.
    const summary = page.getByRole('region', { name: 'Section summary: Foundation' });
    await summary.scrollIntoViewIfNeeded();
    await expect(summary).toContainText('Sets: 2 · Elements: 4');
    await expect(summary.getByRole('columnheader')).toHaveCount(12);
    await expect(summary.getByRole('row')).toHaveCount(3);
    // SET-16: the sheet summary.
    const sheetSummary = page.getByRole('region', { name: 'sheet summary' });
    await expect(sheetSummary.getByRole('row')).toHaveCount(3);
    await expect(sheetSummary).toContainText('1° Foundation');
    // SET-13 / SET-14: U once, in first-seen order; the super set array labels in words.
    const universe = page.getByTestId('universal-set');
    await expect(universe.getByRole('listitem')).toHaveText(['a', 'b', 'c', 'x', 'y']);
    await expect(universe).toContainText('|U| = 5');
    const array = page.getByTestId('super-set-array');
    await expect(array.getByRole('listitem')).toHaveCount(8);
    await expect(array).toContainText('setE');
    await expect(array).toContainText('elementa');
    await checkA11y(`sheet structure ${String(width)}`);
    await snapshot(`sheet-structure-${String(width)}`);
  });
}

test('SET-13 @U in a formula is the sheet’s universal set, and follows the sets', async ({
  page,
}) => {
  const room = await installFakes(page);
  const seeded = openDocument(room.doc);
  const sheetId = createSheet(seeded);
  seedSet(seeded, sheetId, 'E', 1, ['a', 'b']);
  seedSet(seeded, sheetId, 'C', 4, ['b', 'x']);
  const plain = createTable(seeded, {
    sheetId,
    at: { col: 8, row: 1 },
    columns: 1,
    rows: 1,
    title: 'P',
  });
  await asDesktop(page, 1440, 900);
  await signInTo(page, `/d/${DOC_ID}`);
  const grid = page.getByRole('grid', { name: 'P' });
  await expect(grid).toBeVisible();
  const cell = grid.getByRole('row').nth(1).getByRole('gridcell').first();
  const address = await cell.getAttribute('data-address');
  await cell.dblclick();
  await page.getByLabel(`Edit ${address ?? ''}`).fill('=Comp(@E, @U)');
  await page.keyboard.press('Enter');
  await expect(cell).toContainText('x');
  expect(plain).not.toBe('');
  // A new element in C joins U; Comp(E, U) grows with it.
  const cTable = [...seeded.tables.values()].find((t) => t.get('title') === 'C')!;
  const c = tableRecord(cTable);
  setCellText(seeded, c.id, c.rows[0]!, c.columns[0]!.id, 'z');
  await expect(cell).toContainText('z');
});

test('SET-17 SET-18 Rename section… and Lock section from the lane’s menu; a locked section refuses edits and says why; Unlock section gives them back', async ({
  page,
  checkA11y,
}) => {
  const room = await installFakes(page);
  const seeded = openDocument(room.doc);
  const sheetId = createSheet(seeded);
  addSection(seeded, sheetId, { name: 'Foundation', firstColumn: 0, lastColumn: 4 });
  seedSet(seeded, sheetId, 'E', 1, ['a', 'b']);
  seedSet(seeded, sheetId, 'C', 7, ['x']);
  await asDesktop(page, 1440, 900);
  await signInTo(page, `/d/${DOC_ID}`);
  await expect(page.getByRole('grid', { name: 'E' })).toBeVisible();

  // Rename section… opens the heading as a field; Enter renames it.
  await page.getByRole('button', { name: 'Section menu: Foundation' }).click();
  await page.getByRole('menuitem', { name: 'Rename section…' }).click();
  const field = page.getByRole('textbox', { name: 'Section name' });
  await expect(field).toBeFocused();
  await field.fill('Fundamentals');
  await field.press('Enter');
  await expect(page.getByRole('heading', { name: 'Fundamentals' })).toBeVisible();
  expect(listSections(openDocument(room.doc), sheetId)[0]?.name).toBe('Fundamentals');

  // Lock section: the lane says “Locked Fundamentals”; its table refuses edits, the other does not.
  await page.getByRole('button', { name: 'Section menu: Fundamentals' }).click();
  await page.getByRole('menuitem', { name: 'Lock section' }).click();
  const lane = page.getByTestId('section-lane');
  await expect(lane.getByText('Locked Fundamentals')).toBeVisible();
  // The menu has gone, and with it the page-wide aria-hidden Radix sets while it is open.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
  await checkA11y('locked section');
  const locked = page.getByRole('grid', { name: 'E' }).getByRole('gridcell').first();
  await expect(locked).toHaveAttribute('aria-label', /the section is locked/);
  await locked.dblclick();
  await expect(page.getByLabel(/^Edit /)).toHaveCount(0);
  const open = page.getByRole('grid', { name: 'C' }).getByRole('gridcell').first();
  await open.dblclick();
  await expect(page.getByLabel(/^Edit /)).toBeVisible();
  await page.keyboard.press('Escape');
  // The lane’s menu: Rename section… is disabled with the reason; Unlock section is not.
  await page.getByRole('button', { name: 'Section menu: Fundamentals' }).click();
  const rename = page.getByRole('menuitem', { name: 'Rename section…' });
  await expect(rename).toHaveAttribute('aria-disabled', 'true');
  await expect(rename).toHaveAttribute('title', 'the section is locked');
  await page.getByRole('menuitem', { name: 'Unlock section' }).click();
  await expect(lane.getByText('Locked Fundamentals')).toHaveCount(0);
  await locked.dblclick();
  await expect(page.getByLabel(/^Edit /)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('SET-18 Lock sheet from the sheet tab’s menu stops every table and the status line reads “Locked {name}”; Unlock sheet undoes it', async ({
  page,
}) => {
  const room = await installFakes(page);
  const seeded = openDocument(room.doc);
  const sheetId = createSheet(seeded);
  seedSet(seeded, sheetId, 'E', 1, ['a', 'b']);
  await asDesktop(page, 1440, 900);
  await signInTo(page, `/d/${DOC_ID}`);
  const grid = page.getByRole('grid', { name: 'E' });
  await expect(grid).toBeVisible();
  const sheetName = listSheets(openDocument(room.doc))[0]!.label;

  await page.getByRole('tab', { name: new RegExp(sheetName) }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Lock sheet' }).click();
  await expect(page.getByTestId('sheet-locked')).toHaveText(`Locked ${sheetName}`);
  expect(isSheetLocked(openDocument(room.doc), sheetId)).toBe(true);
  const cell = grid.getByRole('gridcell').first();
  await expect(cell).toHaveAttribute('aria-label', /the sheet is locked/);
  await cell.dblclick();
  await expect(page.getByLabel(/^Edit /)).toHaveCount(0);
  // The sheet’s menu: Delete sheet is disabled with the reason; Unlock sheet is on offer.
  await page.getByRole('tab', { name: new RegExp(sheetName) }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Delete sheet' })).toHaveAttribute(
    'title',
    'the sheet is locked',
  );
  await page.getByRole('menuitem', { name: 'Unlock sheet' }).click();
  await expect(page.getByTestId('sheet-locked')).toHaveCount(0);
  expect(isSheetLocked(openDocument(room.doc), sheetId)).toBe(false);
  await cell.dblclick();
  await expect(page.getByLabel(/^Edit /)).toBeVisible();
});
