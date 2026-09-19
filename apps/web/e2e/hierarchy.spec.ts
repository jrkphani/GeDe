/**
 * Row hierarchy journeys (HIER-01..10, KEYS-06, A11Y-01, RESP-02) against the
 * built bundle, at 1024 and 1440 px, and read-only at 480 px. Everything
 * outside the browser is a labelled FAKE at the network edge: Cognito
 * (`fakes/cognito`), the documents REST API (routes below) and the
 * y-websocket room (`fakes/room`). The SPA — the grid, the chords, the Yjs
 * replica — runs for real; a collaborator's outline is authored from the room
 * side with `@gede/core`, exactly as the sync service would relay it.
 */
import type { Page } from '@playwright/test';
import type * as Y from 'yjs';
import { FAKE_SIGN_IN_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import { asPhone, expect, test } from './fixtures/test.js';
import {
  createSheet,
  createTable,
  nestRow,
  openDocument,
  setCellText,
  setRowCollapsed,
  tableById,
  type Id,
} from '@gede/core';

const DOC_ID = '6f1b2c3d-0000-4000-8000-000000h1er00';
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

const ROWS = ['Base camp', 'Lobuche', 'Gorak Shep', 'Kala Patthar', 'Pheriche'] as const;

interface Seeded {
  room: FakeRoom;
  tableId: Id;
  rows: readonly Id[];
  colId: Id;
}

async function installFakes(page: Page, viewOnly = false): Promise<Seeded> {
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
  const room = new FakeRoom({ viewOnly });
  await room.install(page);
  // A collaborator authored a 2 × 5 table at B2: title rows 2–3, header row 4, data B5:C9.
  const gd = openDocument(room.doc);
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 5 });
  const rec = tableById(gd, tableId)!;
  const colId = rec.columns[0]!.id;
  rec.rows.forEach((rowId, i) => {
    setCellText(gd, tableId, rowId, colId, ROWS[i]!);
  });
  return { room, tableId, rows: rec.rows, colId };
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

/** The stored outline column of a row, read from the room's replica (ADR-052, HIER-10). */
function roomOutlineColumn(room: FakeRoom, tableId: Id, rowId: Id): string | null {
  const table = room.doc.getMap('tables').get(tableId) as Y.Map<unknown>;
  const meta = (table.get('rowMeta') as Y.Map<Y.Map<unknown>>).get(rowId);
  const column = meta?.get('outlineColumn');
  return typeof column === 'string' ? column : null;
}

/** The stored depth of a row, read from the room's replica (HIER-10). */
function roomDepth(room: FakeRoom, tableId: Id, rowId: Id): number {
  const table = room.doc.getMap('tables').get(tableId) as Y.Map<unknown>;
  const meta = (table.get('rowMeta') as Y.Map<Y.Map<unknown>>).get(rowId);
  const depth = meta?.get('depth');
  return typeof depth === 'number' ? depth : 0;
}

function roomCollapsed(room: FakeRoom, tableId: Id, rowId: Id): boolean {
  const table = room.doc.getMap('tables').get(tableId) as Y.Map<unknown>;
  const meta = (table.get('rowMeta') as Y.Map<Y.Map<unknown>>).get(rowId);
  return meta?.get('collapsed') === true;
}

/** The table's grid: a `grid` while flat, a `treegrid` once any row is nested (HIER-04). */
const anyGrid = (page: Page) => page.locator('[role="grid"], [role="treegrid"]').first();

/** Data rows of the grid, header excluded. */
const dataRows = (page: Page) =>
  anyGrid(page)
    .getByRole('row')
    .filter({ hasNot: page.getByRole('columnheader') });

test.describe('row hierarchy', () => {
  for (const width of [1024, 1440] as const) {
    test(`KEYS-06 HIER-01 (partial: the keyboard half; the inspector mounts the panel in the integration PR) HIER-02 HIER-04 HIER-05 HIER-06 HIER-09 HIER-10 A11Y-01 at ${String(width)} px: ⌘] nests by physical key and indents the outline column 15 px per level without moving an address, the chevron and ⌥← collapse the subtree so the rows below take its addresses, ⌘[ promotes, and the room receives it all — mouse unplugged except for the chevron`, async ({
      page,
      checkA11y,
      snapshot,
    }) => {
      const { room, tableId, rows } = await installFakes(page);
      await page.setViewportSize({ width, height: 800 });
      await signInTo(page, `/d/${DOC_ID}`);
      const grid = anyGrid(page);
      await expect(grid).toBeVisible();
      const cell = (address: string) =>
        grid.locator(`[role="gridcell"][data-address="${address}"]`);
      await expect(cell('B5')).toHaveText('Base camp');
      const basePadding = await cell('B5').evaluate((el) => getComputedStyle(el).paddingLeft);

      // KEYS-06 / I18N-02: ⌘] by physical key. The suite's Desktop Chrome descriptor reports a
      // Windows UA, so the app's modifier is Control here, on every host.
      await cell('B6').click();
      await page.keyboard.press('Control+BracketRight');
      const row2 = dataRows(page).nth(1);
      await expect(row2).toHaveAttribute('aria-level', '2');
      // HIER-04: 15 px per level in the outline column, the ↳ prefix, and only there.
      await expect(cell('B6')).toHaveCSS(
        'padding-left',
        `${String(parseFloat(basePadding) + 15)}px`,
      );
      await expect(cell('B6').locator('.gd-cell__branch')).toHaveText('↳');
      await expect(cell('C6')).toHaveCSS('padding-left', basePadding);
      await expect(cell('C6').locator('.gd-cell__branch')).toHaveCount(0);
      // HIER-09: the address did not move; the cell is still B6 and still selected.
      await expect(cell('B6')).toHaveAttribute('aria-selected', 'true');
      await expect(cell('B6')).toHaveText(/Lobuche/);
      // HIER-10: the room holds the depth.
      await expect.poll(() => roomDepth(room, tableId, rows[1]!)).toBe(1);
      // HIER-02: once more is refused — B5 is at the top, so B6 stops at level 2.
      await page.keyboard.press('Control+BracketRight');
      await expect(row2).toHaveAttribute('aria-level', '2');
      await expect(page.getByTestId('live-region')).toHaveText(/Cannot nest deeper/);
      // Nest B7 under B6 twice: level 3 is allowed there.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Control+BracketRight');
      await page.keyboard.press('Control+BracketRight');
      await expect(dataRows(page).nth(2)).toHaveAttribute('aria-level', '3');
      await expect(cell('B7')).toHaveCSS(
        'padding-left',
        `${String(parseFloat(basePadding) + 30)}px`,
      );

      // HIER-05: B5 has descendants, so its outline cell carries a labelled chevron.
      const chevron = cell('B5').getByRole('button', { name: 'Collapse B5' });
      await expect(chevron).toHaveAttribute('aria-expanded', 'true');
      await expect(dataRows(page).nth(0)).toHaveAttribute('aria-expanded', 'true');
      // A leaf has no chevron (the row handle in the gutter is a button too, ADR-049).
      await expect(
        dataRows(page)
          .nth(3)
          .getByRole('button', { name: /Collapse|Expand/ }),
      ).toHaveCount(0);
      await snapshot(`document hierarchy ${String(width)}`);
      await checkA11y(`document hierarchy ${String(width)}`);

      // HIER-06: the chevron hides the whole subtree (B6 and B7); Kala Patthar moves from B8 to B6.
      await chevron.click();
      await expect(dataRows(page)).toHaveCount(3);
      await expect(cell('B6')).toHaveText('Kala Patthar');
      await expect(cell('B5').getByRole('button', { name: 'Expand B5' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await expect.poll(() => roomCollapsed(room, tableId, rows[0]!)).toBe(true);
      await checkA11y(`document hierarchy collapsed ${String(width)}`);
      // ⌥→ on the parent expands it again; ⌥← collapses; both by physical key (A11Y-01).
      await cell('B5').click();
      await page.keyboard.press('Alt+ArrowRight');
      await expect(dataRows(page)).toHaveCount(5);
      await expect(cell('B8')).toHaveText('Kala Patthar');
      await page.keyboard.press('Alt+ArrowLeft');
      await expect(dataRows(page)).toHaveCount(3);
      await page.keyboard.press('Alt+ArrowRight');
      await expect(dataRows(page)).toHaveCount(5);

      // ⌘[ promotes B6 with its subtree (B7 comes along, one level up).
      await cell('B6').click();
      await page.keyboard.press('Control+BracketLeft');
      await expect(dataRows(page).nth(1)).toHaveAttribute('aria-level', '1');
      await expect(dataRows(page).nth(2)).toHaveAttribute('aria-level', '2');
      await expect(cell('B6')).toHaveCSS('padding-left', basePadding);
      await expect.poll(() => roomDepth(room, tableId, rows[1]!)).toBe(0);
      await expect.poll(() => roomDepth(room, tableId, rows[2]!)).toBe(1);
      // KEYS-03: one ⌘Z takes the promote back — the row and its subtree together.
      await page.keyboard.press('Control+z');
      await expect(dataRows(page).nth(1)).toHaveAttribute('aria-level', '2');
      await expect(dataRows(page).nth(2)).toHaveAttribute('aria-level', '3');
    });
  }

  for (const width of [1024, 1440] as const) {
    test(`HIER-04 HIER-05 HIER-09 HIER-10 KEYS-06 at ${String(width)} px: ⌘] on a cell in column C nests the row with its outline in C — the indent and ↳ are drawn there and B is untouched — the address C6 stays, the room stores the column per row, a row nested from B keeps B, and a fresh load draws it the same (ADR-052)`, async ({
      page,
      checkA11y,
      snapshot,
    }) => {
      const { room, tableId, rows } = await installFakes(page);
      const gd = openDocument(room.doc);
      const rec = tableById(gd, tableId)!;
      const colB = rec.columns[0]!.id;
      const colC = rec.columns[1]!.id;
      rec.rows.forEach((rowId, i) => {
        setCellText(gd, tableId, rowId, colC, `Note ${String(i + 1)}`);
      });
      await page.setViewportSize({ width, height: 800 });
      await signInTo(page, `/d/${DOC_ID}`);
      const grid = anyGrid(page);
      await expect(grid).toBeVisible();
      const cell = (address: string) =>
        grid.locator(`[role="gridcell"][data-address="${address}"]`);
      const basePadding = await cell('C5').evaluate((el) => getComputedStyle(el).paddingLeft);
      // The inspector head names the selected address; the rail starts collapsed at 1024.
      const rail = page.getByTestId('inspector');
      if ((await rail.getAttribute('data-state')) === 'collapsed') {
        await rail.getByRole('button', { name: 'Expand inspector' }).click();
      }
      const address = rail.getByTestId('inspector-selected').locator('.gd-inspector__address');

      // KEYS-06 by physical key, from a cell in column C.
      await cell('C6').click();
      await expect(address).toHaveText('C6');
      await page.keyboard.press('Control+BracketRight');
      await expect(dataRows(page).nth(1)).toHaveAttribute('aria-level', '2');
      // HIER-04: the indent and ↳ are in C, and only there; B reads as before.
      await expect(cell('C6')).toHaveCSS(
        'padding-left',
        `${String(parseFloat(basePadding) + 15)}px`,
      );
      await expect(cell('C6').locator('.gd-cell__branch')).toHaveText('↳');
      await expect(cell('B6')).toHaveCSS('padding-left', basePadding);
      await expect(cell('B6').locator('.gd-cell__branch')).toHaveCount(0);
      await expect(cell('B6')).toHaveText('Lobuche');
      // HIER-09: the selected cell is still C6, in the grid and in the inspector head.
      await expect(cell('C6')).toHaveAttribute('aria-selected', 'true');
      await expect(address).toHaveText('C6');
      // HIER-10: the room holds the depth and the column, per row.
      await expect.poll(() => roomDepth(room, tableId, rows[1]!)).toBe(1);
      await expect.poll(() => roomOutlineColumn(room, tableId, rows[1]!)).toBe(colC);
      // A row nested from B draws in B, under the same parent (HIER-03 is by depth).
      await cell('B7').click();
      await page.keyboard.press('Control+BracketRight');
      await expect(dataRows(page).nth(2)).toHaveAttribute('aria-level', '2');
      await expect(cell('B7').locator('.gd-cell__branch')).toHaveText('↳');
      await expect(cell('C7').locator('.gd-cell__branch')).toHaveCount(0);
      await expect.poll(() => roomOutlineColumn(room, tableId, rows[2]!)).toBe(colB);
      // HIER-05: the parent's chevron sits in the table's outline column (B5 was never nested).
      await expect(cell('B5').getByRole('button', { name: 'Collapse B5' })).toBeVisible();
      await snapshot(`document hierarchy column ${String(width)}`);
      await checkA11y(`document hierarchy column ${String(width)}`);

      // A fresh load of the document draws the outline where it was stored.
      await signInTo(page, `/d/${DOC_ID}`);
      await expect(anyGrid(page)).toBeVisible();
      await expect(dataRows(page).nth(1)).toHaveAttribute('aria-level', '2');
      await expect(cell('C6').locator('.gd-cell__branch')).toHaveText('↳');
      await expect(cell('C6')).toHaveCSS(
        'padding-left',
        `${String(parseFloat(basePadding) + 15)}px`,
      );
      await expect(cell('B6').locator('.gd-cell__branch')).toHaveCount(0);
      await expect(cell('B7').locator('.gd-cell__branch')).toHaveText('↳');
      // ⌘[ from B takes C6's row to the top level and clears its column.
      await cell('B6').click();
      await page.keyboard.press('Control+BracketLeft');
      await expect(dataRows(page).nth(1)).toHaveAttribute('aria-level', '1');
      await expect(cell('C6').locator('.gd-cell__branch')).toHaveCount(0);
      await expect.poll(() => roomOutlineColumn(room, tableId, rows[1]!)).toBeNull();
    });
  }

  test('HIER-04 INSP-04 MENU-03 KEYS-03 at 1440 px: the Table tab’s "Outline column" select and the column menu’s "Use as outline column" designate the table’s default column — rows nested without a column follow it, a row nested from its own column keeps that — one undo step each, announced; hiding the designated column falls back and says so (ADR-052)', async ({
    page,
    checkA11y,
  }) => {
    const { room, tableId, rows } = await installFakes(page);
    const gd = openDocument(room.doc);
    const rec = tableById(gd, tableId)!;
    const colC = rec.columns[1]!.id;
    nestRow(gd, tableId, rows[1]!); // Lobuche, no column: follows the table's default
    nestRow(gd, tableId, rows[2]!, colC); // Gorak Shep, from C: keeps C
    await page.setViewportSize({ width: 1440, height: 800 });
    await signInTo(page, `/d/${DOC_ID}`);
    const grid = anyGrid(page);
    await expect(grid).toBeVisible();
    const cell = (address: string) => grid.locator(`[role="gridcell"][data-address="${address}"]`);
    await expect(cell('B6').locator('.gd-cell__branch')).toHaveText('↳');
    await expect(cell('C7').locator('.gd-cell__branch')).toHaveText('↳');
    await cell('B5').click();
    const rail = page.getByTestId('inspector');
    if ((await rail.getAttribute('data-state')) === 'collapsed') {
      await rail.getByRole('button', { name: 'Expand inspector' }).click();
    }
    await rail.getByRole('tab', { name: 'Table' }).click();
    const select = rail.getByRole('combobox', { name: 'Outline column' });
    await expect(select).toHaveText('First visible column');
    await select.click();
    await page.getByRole('option', { name: 'Column 2' }).click();
    await expect(select).toHaveText('Column 2');
    await expect(page.getByTestId('live-region')).toHaveText(/Outline column: Column 2/);
    // Lobuche moved to C with the default; Gorak Shep was already there; B carries nothing.
    await expect(cell('C6').locator('.gd-cell__branch')).toHaveText('↳');
    await expect(cell('B6').locator('.gd-cell__branch')).toHaveCount(0);
    await expect(cell('C7').locator('.gd-cell__branch')).toHaveText('↳');
    await expect
      .poll(() => (room.doc.getMap('tables').get(tableId) as Y.Map<unknown>).get('outlineColumn'))
      .toBe(colC);
    await checkA11y('document hierarchy outline column select 1440');
    // KEYS-03: one ⌘Z takes the designation back.
    await cell('B5').click();
    await page.keyboard.press('Control+z');
    await expect(select).toHaveText('First visible column');
    await expect(cell('B6').locator('.gd-cell__branch')).toHaveText('↳');
    // The column context menu carries the same choice, checked on the column that carries the
    // outline; on the implicit first visible column the uncheck is disabled with the reason.
    const columnMenuItem = () =>
      page.getByRole('menuitemcheckbox', { name: 'Use as outline column' });
    await page.getByRole('columnheader', { name: /Column 1/ }).click({ button: 'right' });
    await expect(columnMenuItem()).toHaveAttribute('aria-checked', 'true');
    await expect(columnMenuItem()).toHaveAttribute('aria-disabled', 'true');
    await expect(columnMenuItem()).toHaveAttribute('title', 'Already the first visible column');
    await page.keyboard.press('Escape');
    await page.getByRole('columnheader', { name: /Column 2/ }).click({ button: 'right' });
    await expect(columnMenuItem()).toHaveAttribute('aria-checked', 'false');
    await columnMenuItem().click();
    await expect(cell('C6').locator('.gd-cell__branch')).toHaveText('↳');
    await page.getByRole('columnheader', { name: /Column 2/ }).click({ button: 'right' });
    await expect(columnMenuItem()).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menu')).toHaveCSS('opacity', '1');
    await checkA11y('document hierarchy outline column menu 1440');
    await page.keyboard.press('Escape');
    // Hiding the designated column: the outline falls back to B and the live region says so.
    await page.getByRole('columnheader', { name: /Column 2/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide column' }).click();
    await expect(page.getByTestId('live-region')).toHaveText(
      /Outline column Column 2 is hidden; showing the outline in Column 1/,
    );
    await expect(cell('B6').locator('.gd-cell__branch')).toHaveText('↳');
    await expect(cell('B7').locator('.gd-cell__branch')).toHaveText('↳');
    expect(roomOutlineColumn(room, tableId, rows[2]!)).toBe(colC); // the row remembers
  });

  test('RESP-05 HIER-05 at 768 px the chevron’s hit area is the 44 px target: a press 18 px below the 22 px row still toggles the row, and the box measures 44 × 44', async ({
    page,
    checkA11y,
  }) => {
    const { room, tableId, rows } = await installFakes(page);
    const gd = openDocument(room.doc);
    nestRow(gd, tableId, rows[1]!);
    nestRow(gd, tableId, rows[2]!);
    await page.setViewportSize({ width: 768, height: 800 });
    await signInTo(page, `/d/${DOC_ID}`);
    const grid = anyGrid(page);
    await expect(grid).toBeVisible();
    const cell = (address: string) => grid.locator(`[role="gridcell"][data-address="${address}"]`);
    const chevron = cell('B5').getByRole('button', { name: 'Collapse B5' });
    await expect(chevron).toBeVisible();
    const box = await chevron.evaluate((el) => {
      const before = getComputedStyle(el, '::before');
      const own = el.getBoundingClientRect();
      return {
        width: before.width,
        height: before.height,
        top: parseFloat(before.top),
        ownHeight: own.height,
        centerX: own.x + own.width / 2,
        centerY: own.y + own.height / 2,
      };
    });
    expect(box.width).toBe('44px');
    expect(box.height).toBe('44px');
    expect(box.ownHeight).toBeLessThanOrEqual(22); // the glyph stays inside the lattice row
    expect(box.top).toBe(-11); // the area is centred on it
    // A press below the row, inside the area, toggles the row; the same press on a plain
    // cell would have armed the row beneath.
    await page.mouse.click(box.centerX, box.centerY + 18);
    await expect(dataRows(page)).toHaveCount(3);
    await expect(cell('B5').getByRole('button', { name: 'Expand B5' })).toBeVisible();
    await page.mouse.click(box.centerX, box.centerY - 18);
    await expect(dataRows(page)).toHaveCount(5);
    await checkA11y('document hierarchy 768');
  });

  test('RESP-02 HIER-04 HIER-05 HIER-06 at 480 px the outline renders read-only: indent, ↳ and the chevron state show, a collapsed subtree stays hidden, and neither the chevron nor ⌘] nor ⌥→ writes anything', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const { room, tableId, rows } = await installFakes(page);
    const gd = openDocument(room.doc);
    const colC = tableById(gd, tableId)!.columns[1]!.id;
    nestRow(gd, tableId, rows[1]!);
    nestRow(gd, tableId, rows[2]!);
    nestRow(gd, tableId, rows[2]!);
    nestRow(gd, tableId, rows[4]!, colC); // ADR-052: Pheriche's outline is in C
    setRowCollapsed(gd, tableId, rows[3]!, true);
    await asPhone(page, 480, 800);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByText('View only on phone')).toBeVisible();
    const grid = anyGrid(page);
    await expect(grid).toBeVisible();
    const cell = (address: string) => grid.locator(`[role="gridcell"][data-address="${address}"]`);
    // Pheriche (B9 when expanded) is hidden under the collapsed Kala Patthar: four rows draw.
    await expect(dataRows(page)).toHaveCount(4);
    await expect(cell('B9')).toHaveCount(0);
    const basePadding = await cell('B5').evaluate((el) => getComputedStyle(el).paddingLeft);
    await expect(cell('B7')).toHaveCSS('padding-left', `${String(parseFloat(basePadding) + 30)}px`);
    await expect(cell('B7').locator('.gd-cell__branch')).toHaveText('↳');
    await expect(dataRows(page).nth(0)).toHaveAttribute('aria-expanded', 'true');
    await expect(dataRows(page).nth(3)).toHaveAttribute('aria-expanded', 'false');
    // No control anywhere: the chevron is a glyph, not a button.
    await expect(page.getByRole('button', { name: /Collapse|Expand/ })).toHaveCount(0);
    await expect(cell('B8').getByTestId('outline-chevron')).toHaveAttribute('aria-hidden', 'true');
    await cell('B8').getByTestId('outline-chevron').click();
    await expect(dataRows(page)).toHaveCount(4);
    // The chords write nothing for a viewer.
    await cell('B8').click();
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('Control+BracketRight');
    await page.keyboard.press('Control+BracketLeft');
    await expect(dataRows(page)).toHaveCount(4);
    await expect(dataRows(page).nth(3)).toHaveAttribute('aria-level', '1');
    expect(roomDepth(room, tableId, rows[3]!)).toBe(0);
    expect(roomCollapsed(room, tableId, rows[3]!)).toBe(true);
    // ADR-052: a row nested from C draws its outline in C, read-only like the rest, and a
    // chord from C writes nothing either. The collaborator expands Kala Patthar to show it.
    setRowCollapsed(gd, tableId, rows[3]!, false);
    await expect(dataRows(page)).toHaveCount(5);
    await expect(cell('C9').locator('.gd-cell__branch')).toHaveText('↳');
    await expect(cell('B9').locator('.gd-cell__branch')).toHaveCount(0);
    await expect(cell('C9')).toHaveCSS('padding-left', `${String(parseFloat(basePadding) + 15)}px`);
    await cell('C9').click();
    await page.keyboard.press('Control+BracketLeft');
    await expect(dataRows(page).nth(4)).toHaveAttribute('aria-level', '2');
    expect(roomOutlineColumn(room, tableId, rows[4]!)).toBe(colC);
    await snapshot('document hierarchy 480 read-only');
    await checkA11y('document hierarchy read-only 480');
  });
});
