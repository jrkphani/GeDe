/**
 * Sort, filter and grouping journeys (SORT-01..06, HIER-08, RESP-02, A11Y-01)
 * against the built bundle, at 1024 and 1440 px, plus the read-only phone
 * contract at 480. Everything outside the browser is a labelled FAKE at the
 * network edge: Cognito (`fakes/cognito`), the documents REST API (routes
 * below) and the y-websocket room (`fakes/room`). The SPA — the shell, the
 * Radix menu and popover, the sort Worker — runs for real.
 */
import { asPhone, expect, test } from './fixtures/test.js';
import type { Page } from '@playwright/test';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import {
  createSheet,
  createTable,
  openDocument,
  setCellText,
  tableById,
  type Id,
} from '@gede/core';

const DOC_ID = '6f1b2c3d-0000-4000-8000-000000005017';
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
  title: 'Country offices',
  ownerId: SESSION.sub,
  permission: 'owner',
  linkAccess: 'none',
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
};

/** Column 1 is Country, column 2 is Contact; the fifth row is empty. */
const COUNTRY = ['Singapore', 'Malaysia', 'Singapore', 'India', ''];
const CONTACT = ['meena@1cloudhub.com', 'Kuala Lumpur desk', 'Tampines desk', 'Chennai desk', ''];

interface Seeded {
  room: FakeRoom;
  tableId: Id;
  rows: readonly Id[];
  cols: readonly Id[];
}

async function installFakes(page: Page): Promise<Seeded> {
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
  // A collaborator has already authored the table.
  const gd = openDocument(room.doc);
  const sheetId = createSheet(gd, { label: 'Offices' });
  const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 5 });
  const r = tableById(gd, tableId)!;
  const cols = r.columns.map((c) => c.id);
  COUNTRY.forEach((v, i) => {
    if (v !== '') setCellText(gd, tableId, r.rows[i]!, cols[0]!, v);
  });
  CONTACT.forEach((v, i) => {
    if (v !== '') setCellText(gd, tableId, r.rows[i]!, cols[1]!, v);
  });
  gd.doc.transact(() => {
    gd.tables.get(tableId)!.set('footerRows', 1);
  });
  return { room, tableId, rows: r.rows, cols };
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

/** Column-1 text of every data row in the grid, top to bottom (bands excluded). */
async function columnTexts(page: Page): Promise<string[]> {
  return page
    .getByRole('grid')
    .locator('[role="row"][aria-rowindex]:not(.gd-band)')
    .evaluateAll((rows) =>
      rows.map((r) => r.querySelector('[role="gridcell"]')?.textContent?.trim() ?? ''),
    );
}

const header = (page: Page, label: string) =>
  page.getByRole('grid').getByRole('columnheader', { name: new RegExp(label) });
const menuButton = (page: Page, label: string) =>
  page.getByRole('button', { name: `Sort, filter or group ${label}` });

for (const width of [1024, 1440] as const) {
  test.describe(`sort, filter and group at ${String(width)} px`, () => {
    // Light at 1440, dark at 1024: both palettes go through axe (A11Y-03, DoD "light and dark checked").
    test.use({ colorScheme: width === 1024 ? 'dark' : 'light' });
    test(`SORT-01 SORT-02 SORT-03 SORT-05 SORT-06 A11Y-01 the header ▼ sorts, filters, groups and clears; addresses never move; the menu, the panel and the bands pass axe at ${String(width)}`, async ({
      page,
      checkA11y,
      snapshot,
    }) => {
      const { room, rows } = await installFakes(page);
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 900 });
      await signInTo(page, `/d/${DOC_ID}`);
      const grid = page.getByRole('grid').first();
      await expect(grid).toBeVisible();
      expect(await columnTexts(page)).toEqual(COUNTRY);
      // India's cell: B8 (title 2 rows + header, from row 1) before and after every view change
      // (non-negotiable 3).
      const india = grid.locator('[data-address="B8"]');
      await expect(india).toHaveText('India');

      // SORT-01: the ▼ opens the exact items; A–Z sorts on screen, ↑ and aria-sort appear.
      await menuButton(page, 'Column 1').click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitemradio')).toHaveText([
        'None',
        'A–Z',
        'Z–A',
        'Chars',
        'Words',
        'Freq',
      ]);
      await expect(
        menu.getByRole('menuitemcheckbox', { name: 'Group rows by this column' }),
      ).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Filter this column…' })).toBeVisible();
      await expect(menu).toHaveCSS('opacity', '1');
      await checkA11y(`sort menu ${String(width)}`);
      await menu.getByRole('menuitemradio', { name: 'A–Z' }).click();
      await expect
        .poll(() => columnTexts(page))
        .toEqual(['India', 'Malaysia', 'Singapore', 'Singapore', '']);
      await expect(header(page, 'Column 1')).toHaveAttribute('aria-sort', 'ascending');
      await expect(header(page, 'Column 1').locator('[data-glyph="arrow-up"]')).toBeVisible();
      await expect(india).toHaveText('India');
      // ADR-026: the view is the viewer's — the room never sees it; the rows array is untouched.
      const roomTables = () => JSON.stringify(room.doc.getMap('tables').toJSON());
      expect(roomTables()).not.toContain('"sortBy"');
      const roomRows = (room.doc.getMap('tables').toJSON() as Record<string, { rows: string[] }>)[
        Object.keys(room.doc.getMap('tables').toJSON())[0]!
      ]!.rows;
      expect(roomRows).toEqual(rows);
      // …and it is persisted per (user, document) on this device.
      await expect
        .poll(() =>
          page.evaluate((k) => localStorage.getItem(k), `gede.view.${SESSION.sub}.${DOC_ID}`),
        )
        .toContain('"az"');

      // SORT-03: the filter panel, fuzzy on: "Sngapore" keeps both Singapore rows.
      await menuButton(page, 'Column 1').click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'Filter this column…' }).click();
      const panel = page.getByRole('dialog', { name: 'Filter Column 1' });
      await expect(panel).toBeVisible();
      const field = panel.getByLabel('Column 1 contains');
      await expect(field).toBeFocused();
      await field.fill('Sngapore');
      // INSP-12 (#138): the filter is live — the rows follow the field; no Apply step.
      await expect.poll(() => columnTexts(page)).toEqual(['Singapore', 'Singapore', '']);
      await expect(panel.getByRole('button', { name: 'Apply' })).toHaveCount(0);
      // The panel fades in; axe reads colours once the enter motion has settled.
      await expect(panel).toHaveCSS('opacity', '1');
      await checkA11y(`filter panel ${String(width)}`);
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(page.getByTestId('table-footer')).toContainText('3 of 5 rows');
      await expect(header(page, 'Column 1').locator('[data-glyph="arrow-up"]')).toBeVisible();
      // MENU-05: focus came back to the ▼.
      await expect(menuButton(page, 'Column 1')).toBeFocused();

      // SORT-05 / HIER-08: group by Column 2 — bands after the sort and filter, collapsible.
      await menuButton(page, 'Column 2').click();
      await page
        .getByRole('menu')
        .getByRole('menuitemcheckbox', { name: 'Group rows by this column' })
        .click();
      const bands = grid.getByTestId('group-band');
      await expect(bands).toHaveCount(2);
      await expect(bands.getByRole('button')).toHaveText([
        'meena@1cloudhub.com1 row',
        'Tampines desk1 row',
      ]);
      await expect(grid.getByRole('rowgroup')).toHaveCount(2);
      const first = bands.first().getByRole('button');
      await expect(first).toHaveAttribute('aria-expanded', 'true');
      // The band's label sits on the grouped column (Column 2 starts at 160 px).
      await expect(first).toHaveCSS('left', '160px');
      await checkA11y(`grouped table ${String(width)}`);
      await snapshot(`sort filter group ${String(width)}`);
      // Keyboard: Enter on a band collapses it; its row leaves the grid.
      await first.focus();
      await page.keyboard.press('Enter');
      await expect(first).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(() => columnTexts(page)).toEqual(['Singapore', '']);
      await expect(india).toHaveCount(0); // filtered out, not moved: still B8 in the document
      expect(roomRows.indexOf(rows[3]!)).toBe(3);

      // SORT-06: Clear resets all three in one action.
      await menuButton(page, 'Column 1').click();
      await page
        .getByRole('menu')
        .getByRole('menuitem', { name: 'Clear sort, filter and grouping' })
        .click();
      await expect.poll(() => columnTexts(page)).toEqual(COUNTRY);
      await expect(header(page, 'Column 1')).not.toHaveAttribute('aria-sort', /.+/);
      await expect(bands).toHaveCount(0);
      await expect(page.getByTestId('table-footer')).toContainText('5 rows');
      await expect(india).toHaveText('India');
      expect(roomTables()).not.toContain('"groupBy"');
      expect(roomTables()).not.toContain('"filter"');
      await expect
        .poll(() =>
          page.evaluate((k) => localStorage.getItem(k), `gede.view.${SESSION.sub}.${DOC_ID}`),
        )
        .toBeNull();
    });
  });
}

test('RESP-02 SORT-05 at 480 px the table is read-only: no ▼ renders, the viewer’s own stored sort and grouping still show, and bands still expand', async ({
  page,
  checkA11y,
}) => {
  const { tableId, cols } = await installFakes(page);
  // The viewer sorted and grouped this table on this device earlier (per user, per document).
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    {
      key: `gede.view.${SESSION.sub}.${DOC_ID}`,
      value: JSON.stringify({
        [tableId]: { sortBy: { colId: cols[0], mode: 'az' }, filter: null, groupBy: cols[0] },
      }),
    },
  );
  await asPhone(page, 480, 800);
  await signInTo(page, `/d/${DOC_ID}`);
  await expect(page.getByText('View only on phone')).toBeVisible();
  const grid = page.getByRole('grid').first();
  await expect(grid).toBeVisible();
  await expect(page.getByRole('button', { name: /Sort, filter or group/ })).toHaveCount(0);
  await expect(header(page, 'Column 1')).toHaveAttribute('aria-sort', 'ascending');
  const bands = grid.getByTestId('group-band');
  await expect(bands.getByRole('button')).toHaveText([
    'India1 row',
    'Malaysia1 row',
    'Singapore2 rows',
  ]);
  await bands.nth(2).getByRole('button').click();
  await expect(bands.nth(2).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => columnTexts(page)).toEqual(['India', 'Malaysia', '']);
  // No edit affordance anywhere (RESP-02), and the geometry holds (RESP-01).
  await expect(page.getByRole('button', { name: /Add row to/ })).toHaveCount(0);
  await expect(page.locator('.gd-table').first()).toHaveCSS('width', '320px');
  await checkA11y('sort phone 480');
});
