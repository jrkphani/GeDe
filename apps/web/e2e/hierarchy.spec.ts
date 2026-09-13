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
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
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
    nestRow(gd, tableId, rows[1]!);
    nestRow(gd, tableId, rows[2]!);
    nestRow(gd, tableId, rows[2]!);
    nestRow(gd, tableId, rows[4]!);
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
    await snapshot('document hierarchy 480 read-only');
    await checkA11y('document hierarchy read-only 480');
  });
});
