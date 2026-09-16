/**
 * Row and column resize, wrap and overflow the way Numbers does them, on the
 * lattice (GRID-08, GRID-09, INSP-04, INSP-06, DOC-06, A11Y-01, KEYS-03; #167,
 * ADR-049). Real Chrome measures real text here: a wrapped row's height is
 * whatever the replica measured and stored, so the journey asserts the
 * invariants — whole units, the address below moving by exactly the row's
 * units, the ruler agreeing — and lower bounds on the count, never a font
 * metric.
 */
import type { Page } from '@playwright/test';
import {
  createTable,
  ensureFirstSheet,
  openDocument,
  setColumnWrap,
  setRowHeight,
  tableRecord,
} from '@gede/core';
import { asPhone, expect, test, zoomed200 } from './fixtures/test.js';
import { FAKE_SIGN_IN_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000e2e7';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-7',
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
const record = {
  id: DOC_ID,
  title: 'Field notes',
  ownerId: SESSION.sub,
  permission: 'owner',
  linkAccess: 'none',
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
};

const LONG =
  'The lattice is a uniform grid of one hundred and sixty by twenty-two pixel cells that underlies the whole canvas, so every table origin, column width and row height is a whole number of units.';
const TAMIL = 'தமிழ் மொழி';

async function installFakes(page: Page, viewOnly = false): Promise<FakeRoom> {
  await page.route('**/config.json', (route) => route.fulfill({ json: CONFIG }));
  await installFakeCognito(page, SESSION);
  await page.route(`**/api/documents/${DOC_ID}`, (route) =>
    route.fulfill({
      json: { document: viewOnly ? { ...record, permission: 'viewer' } : record },
    }),
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
  const target = new RegExp(`${path.replace('?', '\\?')}$`);
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(target, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page).toHaveURL(target);
}

async function enter(page: Page, address: string, text: string): Promise<void> {
  const cell = page.locator(`[data-address="${address}"]`);
  await cell.dblclick();
  const editor = page.getByLabel(`Edit ${address}`);
  await editor.fill(text);
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
}

async function openRail(page: Page) {
  const rail = page.getByTestId('inspector');
  if ((await rail.getAttribute('data-state')) === 'collapsed') {
    await rail.getByRole('button', { name: 'Expand inspector' }).click();
  }
  return rail;
}

/** Drag from the centre of a handle by (dx, dy) screen px. */
async function drag(page: Page, handle: ReturnType<Page['getByRole']>, dx: number, dy: number) {
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  return { box };
}

const rowOf = (page: Page, rowId: string) => page.locator(`[role="row"][data-row-id="${rowId}"]`);

/** Wait for every running animation and transition under `selector` (a theme swap's, a tab's). */
async function settled(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
}

test.describe('resize and wrap (Numbers on the lattice, #167)', () => {
  for (const width of [1024, 1440] as const) {
    test(`GRID-08 GRID-09 INSP-04 DOC-06 KEYS-03 A11Y-01 at ${String(width)} px: row edges drag with a live preview, a band drags proportionally, double-click fits both axes, wrap grows the row and clips when off, the Table tab's Height and Width act on the selection, every step is one undo, light and dark pass axe`, async ({
      page,
      checkA11y,
      snapshot,
    }) => {
      const room = await installFakes(page);
      await page.setViewportSize({ width, height: 900 });
      await signInTo(page, `/d/${DOC_ID}`);
      await page.getByRole('button', { name: 'Add table' }).click();
      const grid = page.getByRole('grid').first();
      const b5 = page.locator('[data-address="B5"]');
      await expect(b5).toBeVisible();
      await expect.poll(() => room.doc.getMap('tables').size).toBe(1);
      const gd = openDocument(room.doc);
      const tableId = Array.from(gd.tables.keys())[0] ?? '';
      const rec = () => tableRecord(gd.tables.get(tableId)!);
      const [r1, r2, r3] = rec().rows as [string, string, string];

      // ── Criterion 1 / N1: every row has a drag edge in the gutter while the table is selected.
      await b5.click();
      const edges = page.getByRole('separator', { name: /^Resize row/ });
      await expect(edges).toHaveCount(5);
      const edge5 = page.getByRole('separator', { name: 'Resize row 5' });
      await expect(edge5).toHaveAttribute('aria-orientation', 'horizontal');
      await expect(edge5).toHaveAttribute('aria-valuemin', '1');
      await expect(edge5).not.toHaveAttribute('aria-valuemax');
      // A drag of 50 px (2.27 more units) snaps to 3 units with a live preview and one write on release.
      await drag(page, edge5, 0, 50);
      await expect(rowOf(page, r1)).toHaveCSS('height', '66px');
      await expect(page.locator('[data-address="B6"]')).toHaveCount(1); // preview: no address moved
      await page.mouse.up();
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '3');
      await expect(page.locator('[data-address="B8"]')).toHaveAttribute('data-row-id', r2);
      // DOC-06 / GRID-01: the ruler still numbers the lattice; the row below sits under 8.
      await expect(page.getByTestId('ruler-rows').locator('[data-row="7"]')).toHaveText('8');
      await expect(page.getByTestId('live-region')).toHaveText(/Row 5 is 3 units tall/);
      // Criterion 19: one undo step per drag.
      await page.keyboard.press('Control+Z');
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '1');
      await page.keyboard.press('Control+Shift+Z');
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '3');

      // ── Criterion 3 / N2: select rows 5–6 by handle and Shift-handle; dragging row 6's edge
      // scales both proportionally (3 and 1 → 6 and 2), in one step.
      await page.getByRole('button', { name: 'Select row 5' }).click();
      await page.getByRole('button', { name: 'Select row 8' }).click({ modifiers: ['Shift'] });
      await expect(rowOf(page, r1)).toHaveAttribute('aria-selected', 'true');
      await expect(rowOf(page, r2)).toHaveAttribute('aria-selected', 'true');
      const edge6 = page.getByRole('separator', { name: 'Resize row 8' });
      await drag(page, edge6, 0, 22);
      await expect(rowOf(page, r1)).toHaveCSS('height', '132px');
      await expect(rowOf(page, r2)).toHaveCSS('height', '44px');
      await page.mouse.up();
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '6');
      await expect(rowOf(page, r2)).toHaveAttribute('data-units', '2');
      await expect(rowOf(page, r3)).toHaveAttribute('data-units', '1');
      await page.keyboard.press('Control+Z');
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '3');
      await expect(rowOf(page, r2)).toHaveAttribute('data-units', '1');

      // ── Criterion 8–9 / N4: the Table tab's Height and Width act on the selected row and
      // column — typed values snap to whole units; Shift-arrow steps four.
      await b5.click();
      const rail = await openRail(page);
      await rail.getByRole('tab', { name: 'Table' }).click();
      const height = rail.getByRole('spinbutton', { name: 'Height' });
      await expect(height).toHaveAttribute('aria-valuetext', '3 units, 66 px, row 5');
      await height.fill('2.4');
      await height.press('Enter');
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '2');
      await height.press('Shift+ArrowUp');
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '6');
      await height.fill('1');
      await height.press('Enter');
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '1');
      const widthField = rail.getByRole('spinbutton', { name: 'Width' });
      await widthField.press('ArrowUp');
      await expect(grid.getByRole('columnheader').first()).toHaveCSS('width', '320px');
      await expect(page.locator('[data-address="D5"]')).toHaveCount(1);
      await widthField.press('ArrowDown');
      await expect(grid.getByRole('columnheader').first()).toHaveCSS('width', '160px');

      // ── Criteria 10–12 / N8–N10: wrap on grows the row to every line; wrap off clips at
      // the cell with the full text on the tooltip; the address below moves by the units.
      await enter(page, 'B5', LONG);
      await b5.click(); // Enter moved the selection to B6; the row's controls want B5
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '1');
      await expect(b5).toHaveAttribute('title', LONG);
      await expect(b5.locator('.gd-rich')).toHaveCSS('white-space', 'nowrap');
      await expect(b5.locator('.gd-rich')).toHaveCSS('text-overflow', 'clip');
      await expect(b5.locator('.gd-rich')).toHaveCSS('overflow', 'hidden');
      // The neighbour is untouched: the text never spills into it.
      const c5 = page.locator('[data-address="C5"]');
      await expect(c5).toHaveText('');
      await rail.getByRole('tab', { name: 'Text' }).click();
      await rail.getByRole('switch', { name: 'Wrap text in column Column 1' }).click();
      await expect(b5).toHaveClass(/gd-cell--wrap/);
      // Criterion 11: the row was set by hand (the Height field), so it keeps one unit and the
      // wrapped text clips at the last whole line; Fit height to content lets it follow again.
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '1');
      await rail.getByRole('tab', { name: 'Table' }).click();
      await rail.getByRole('button', { name: 'Fit height to content' }).click();
      // Real text at 160 px: a 190-character sentence takes at least five lines → 4+ units.
      await expect
        .poll(async () => Number(await rowOf(page, r1).getAttribute('data-units')))
        .toBeGreaterThanOrEqual(4);
      const units = Number(await rowOf(page, r1).getAttribute('data-units'));
      await expect(rowOf(page, r1)).toHaveCSS('height', `${String(units * 22)}px`);
      await expect(b5).toHaveClass(/gd-cell--wrap/);
      await expect(b5.locator('.gd-rich')).toHaveCSS('white-space', 'normal');
      await expect(page.locator(`[data-address="B${String(5 + units)}"]`)).toHaveAttribute(
        'data-row-id',
        r2,
      );
      await expect(
        page.getByTestId('ruler-rows').locator(`[data-row="${String(4 + units)}"]`),
      ).toHaveText(String(5 + units));
      // Criterion 13: the row's other cells stay on one line, at their alignment.
      await expect(c5).not.toHaveClass(/gd-cell--wrap/);
      await expect(c5).toHaveClass(/gd-cell--tall/);
      // Widening the column re-measures: fewer lines, a shorter row, in the same step.
      await widthField.fill('4');
      await widthField.press('Enter');
      await expect
        .poll(async () => Number(await rowOf(page, r1).getAttribute('data-units')))
        .toBeLessThan(units);
      // One step: the width and the height it changed undo together (the field is a text
      // input, so the undo chord is pressed from the cell).
      await b5.click();
      await page.keyboard.press('Control+Z');
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', String(units));
      await expect(grid.getByRole('columnheader').first()).toHaveCSS('width', '160px');
      // Wrap off again: back to one unit, clipped, the tooltip carrying the text.
      await rail.getByRole('tab', { name: 'Text' }).click();
      await rail.getByRole('switch', { name: 'Wrap text in column Column 1' }).click();
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '1');
      await expect(b5).toHaveAttribute('title', LONG);

      // ── Criterion 5 / N5: double-click on the column divider fits the width; on the row edge
      // it fits the height; a hand-set row stays put until then (criterion 11).
      await b5.click();
      await page.getByRole('separator', { name: 'Resize row 5' }).focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '3');
      await enter(page, 'C5', 'short');
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '3'); // fit is off: no shrink
      await page.getByRole('separator', { name: 'Resize row 5' }).dblclick();
      await expect(rowOf(page, r1)).toHaveAttribute('data-units', '1');
      await expect(page.getByTestId('live-region')).toHaveText(/Row 5 fits its content/);
      await page.getByRole('separator', { name: 'Resize column Column 2' }).dblclick();
      await expect(grid.getByRole('columnheader').nth(1)).toHaveCSS('width', '160px'); // "short" fits one unit
      const divider = page.getByRole('separator', { name: 'Resize column Column 1' });
      await divider.dblclick();
      await expect
        .poll(async () => Number(await divider.getAttribute('aria-valuenow')))
        .toBeGreaterThanOrEqual(6); // the sentence, on one line, with no cap
      await page.keyboard.press('Control+Z');
      await expect(divider).toHaveAttribute('aria-valuenow', '1');

      // ── Criterion 17 / ADR-034: h1 on Tamil text takes three units, never refused.
      await enter(page, 'B6', TAMIL);
      await page.locator('[data-address="B6"]').click();
      await rail.getByRole('tab', { name: 'Text' }).click();
      await rail.getByRole('radio', { name: 'Cell B6' }).click();
      await rail.getByRole('combobox', { name: 'Size' }).click();
      await page.getByRole('option', { name: '28 px · h1' }).click();
      await expect(rowOf(page, r2)).toHaveAttribute('data-units', '3');
      await expect(page.locator('[data-address="B9"]')).toHaveAttribute('data-row-id', r3);

      // ── Criterion 15 / N12: a merged anchor is measured over the span; the extra height lands
      // on the span's last row.
      await rail.getByRole('combobox', { name: 'Size' }).click();
      await page.getByRole('option', { name: '11.5 px · cell' }).click();
      await expect(rowOf(page, r2)).toHaveAttribute('data-units', '1');
      await enter(page, 'B7', LONG);
      await page.locator('[data-address="B7"]').click();
      await rail.getByRole('radio', { name: 'Cell B7' }).click();
      await rail.getByRole('switch', { name: 'Wrap text in B7' }).click();
      const alone = Number(await rowOf(page, r3).getAttribute('data-units'));
      expect(alone).toBeGreaterThanOrEqual(4);
      const last = rec().rows[3] ?? '';
      // Merge B7 across two columns and two rows from the Cell tab (a local write, so this
      // replica measures it): two columns wide means fewer lines; row 7 keeps its own unit and
      // the rest goes to the span's last row.
      await rail.getByRole('tab', { name: 'Cell' }).click();
      await rail.getByRole('button', { name: 'More columns' }).click();
      await rail.getByRole('button', { name: 'More rows' }).click();
      expect(rec().rows).toHaveLength(5);
      await expect
        .poll(async () => Number(await rowOf(page, last).getAttribute('data-units')))
        .toBeGreaterThanOrEqual(2);
      await expect(rowOf(page, r3)).toHaveAttribute('data-units', '1');

      // ── Criterion 24: light and dark, axe on both (once the theme's transitions have run).
      await b5.click();
      await settled(page, '.gd-doc');
      await checkA11y(`resize-wrap ${String(width)} light`);
      await snapshot(`resize-wrap ${String(width)} light`);
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
      });
      await settled(page, '.gd-doc');
      await checkA11y(`resize-wrap ${String(width)} dark`);
      await snapshot(`resize-wrap ${String(width)} dark`);
    });
  }

  test('A11Y-01 KEYS-03 GRID-08 GRID-09 the keyboard alone: Shift+Tab to a column divider, ⌥↓ to a row edge, arrows and Shift-arrows resize by units, Enter fits, ⇧-arrows select a band the arrows then resize together', async ({
    page,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    const grid = page.getByRole('grid').first();
    await expect.poll(() => room.doc.getMap('tables').size).toBe(1);
    const gd = openDocument(room.doc);
    const tableId = Array.from(gd.tables.keys())[0] ?? '';
    const rec = tableRecord(gd.tables.get(tableId)!);
    const [r1, r2] = rec.rows as [string, string];
    await page.locator('[data-address="B5"]').click();
    // Column divider: Shift+Tab from the first cell, → one unit, Shift+→ four, Enter fits.
    await page.keyboard.press('Shift+Tab');
    const divider = page.getByRole('separator', { name: 'Resize column Column 1' });
    await expect(divider).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '2');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '6');
    await page.keyboard.press('Enter');
    await expect(divider).toHaveAttribute('aria-valuenow', '1'); // an empty column fits one unit
    await expect(page.getByTestId('live-region')).toHaveText(/Fitted 1 column to content/);
    // Row edge: ⌥↓ from the cell; ↓ one unit, Shift+↓ four, ↑ one; Enter fits.
    await page.locator('[data-address="B5"]').focus();
    await page.keyboard.press('Alt+ArrowDown');
    const edge = page.getByRole('separator', { name: 'Resize row 5' });
    await expect(edge).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rowOf(page, r1)).toHaveAttribute('data-units', '2');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(rowOf(page, r1)).toHaveAttribute('data-units', '6');
    await page.keyboard.press('ArrowUp');
    await expect(rowOf(page, r1)).toHaveAttribute('data-units', '5');
    await expect(page.locator('[data-address="B10"]')).toHaveAttribute('data-row-id', r2);
    await page.keyboard.press('Enter');
    await expect(rowOf(page, r1)).toHaveAttribute('data-units', '1');
    // ⌥← / ⌥→ on the edge do nothing to it (they are the row chevron's, ADR-030).
    await page.keyboard.press('Alt+ArrowRight');
    await expect(rowOf(page, r1)).toHaveAttribute('data-units', '1');
    // A band by the keyboard: ⇧↓ from B5 selects rows 5–6; the edge then resizes both.
    await page.locator('[data-address="B5"]').focus();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(rowOf(page, r1)).toHaveAttribute('aria-selected', 'true');
    await expect(rowOf(page, r2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Alt+ArrowDown');
    await expect(edge).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rowOf(page, r1)).toHaveAttribute('data-units', '2');
    await expect(rowOf(page, r2)).toHaveAttribute('data-units', '2');
    await expect(page.getByTestId('live-region')).toHaveText(/2 rows are 2 units tall/);
    await page.keyboard.press('Control+Z');
    await expect(rowOf(page, r1)).toHaveAttribute('data-units', '1');
    await expect(rowOf(page, r2)).toHaveAttribute('data-units', '1');
    // ⇧→ selects columns; the column divider resizes them together.
    await page.locator('[data-address="B5"]').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(grid.getByRole('columnheader').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Shift+Tab');
    await expect(divider).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(grid.getByRole('columnheader').nth(0)).toHaveCSS('width', '320px');
    await expect(grid.getByRole('columnheader').nth(1)).toHaveCSS('width', '320px');
    await expect(grid.getByRole('columnheader').nth(2)).toHaveCSS('width', '160px');
  });

  test('RESP-02 SHARE-03 GRID-08 a phone and a view-only share render no divider, edge, corner or size field, and honour stored heights exactly', async ({
    page,
  }) => {
    const room = await installFakes(page, true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    // A collaborator's table: a hand-set three-unit first row and a wrapped column, honoured
    // exactly from the stored numbers — this replica measures nothing.
    // A viewer cannot seed the first sheet; the owner's replica (this test) does.
    const gd = openDocument(room.doc);
    const sheetId = ensureFirstSheet(gd);
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 3 });
    const rec = tableRecord(gd.tables.get(tableId)!);
    setRowHeight(gd, tableId, rec.rows[0] ?? '', 3);
    setColumnWrap(gd, tableId, rec.columns[0]?.id ?? '', true);
    const first = page.locator('[data-address="B5"]');
    await expect(first).toBeVisible();
    await expect(rowOf(page, rec.rows[0] ?? '')).toHaveCSS('height', '66px');
    await expect(page.locator('[data-address="B8"]')).toHaveAttribute(
      'data-row-id',
      rec.rows[1] ?? '',
    );
    await expect(first).toHaveClass(/gd-cell--wrap/);
    await first.click();
    await expect(page.getByRole('separator', { name: /Resize/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Select row/ })).toHaveCount(0);
    // The Table tab's fields stay, disabled with the reason (INSP-11, MENU-02: never hidden).
    const rail = await openRail(page);
    await rail.getByRole('tab', { name: 'Table' }).click();
    await expect(rail.getByRole('spinbutton', { name: 'Height' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(rail.getByRole('spinbutton', { name: 'Height' })).toHaveAttribute(
      'title',
      /view-only/,
    );
    await asPhone(page);
    await expect(page.getByRole('separator', { name: /Resize/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Select row/ })).toHaveCount(0);
    await expect(rowOf(page, rec.rows[0] ?? '')).toHaveCSS('height', '66px');
  });

  test('RESP-05 A11Y-02 at 200 % zoom a row edge is a 44 px target below 1024 and a unit drag converts through the element scale', async ({
    browser,
  }) => {
    const context = await browser.newContext(zoomed200(1440));
    const page = await context.newPage();
    const room = await installFakes(page);
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    await expect.poll(() => room.doc.getMap('tables').size).toBe(1);
    const gd = openDocument(room.doc);
    const tableId = Array.from(gd.tables.keys())[0] ?? '';
    const r1 = tableRecord(gd.tables.get(tableId)!).rows[0] ?? '';
    const r2 = tableRecord(gd.tables.get(tableId)!).rows[1] ?? '';
    await page.locator('[data-address="B5"]').click();
    const edge = page.getByRole('separator', { name: 'Resize row 5' });
    const box = await edge.boundingBox();
    if (!box) throw new Error('edge has no box');
    // 720 CSS px wide: the lg breakpoint is not met, so the target is 44 × 44, left of the
    // gutter — the row handle keeps its own target.
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('button', { name: 'Select row 5' })).toBeVisible();
    // On a 22 px pitch the targets overlap and the later row's wins: the half above the edge
    // is row 5's own. 22 CSS px of drag is one lattice unit — the layer is at zoom 1 in CSS px.
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 8 + 22, { steps: 4 });
    await page.mouse.up();
    await expect(rowOf(page, r1)).toHaveAttribute('data-units', '2');
    await expect(rowOf(page, r2)).toHaveAttribute('data-units', '1');
    await context.close();
  });
});
