/**
 * Editable table titles and column headers, and column width with the header
 * row hidden (INSP-04, MENU-03, KEYS-06, KEYS-08, GRID-08, A11Y-01, REF-01;
 * ADR-051) — against the built bundle at 1024 and 1440 px with axe on every
 * new surface; the phone at 480. A freshly added table (the customer's case,
 * not the seeded sample) is renamed inline by pointer, by F2, from the column
 * menu and from the Table tab; the names survive a reload through the room.
 * Everything outside the browser is a labelled FAKE at the network edge:
 * Cognito (`fakes/cognito`), the documents REST API and the room (`fakes/room`).
 */
import type { Page } from '@playwright/test';
import {
  addDerivedColumn,
  createSheet,
  createTable,
  openDocument,
  renameColumn,
  tableRecord,
} from '@gede/core';
import { asDesktop, asPhone, expect, test, type Breakpoint } from './fixtures/test.js';
import { FAKE_SIGN_IN_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000hd51';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-51',
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
  title: 'Project roster',
  ownerId: SESSION.sub,
  permission: 'owner',
  linkAccess: 'none',
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
};

/** The suite's device profile reports a Windows UA, so `mod` resolves to Ctrl (I18N-02). */
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
  return room;
}

/** AUTH-01: a cold visit lands on sign-in and returns after the code; tokens live in memory, so a reload signs in again. */
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

async function openDoc(page: Page, width: Breakpoint): Promise<FakeRoom> {
  const room = await installFakes(page);
  await (width < 768 ? asPhone(page, width, 900) : asDesktop(page, width, 900));
  await signInTo(page, `/d/${DOC_ID}`);
  await expect(page.getByRole('tab', { name: /1°.*Sheet 1/ })).toBeVisible();
  return room;
}

async function openRail(page: Page) {
  const rail = page.getByTestId('inspector');
  if ((await rail.getAttribute('data-state')) === 'collapsed') {
    await rail.getByRole('button', { name: 'Expand inspector' }).click();
  }
  return rail;
}

const live = (page: Page) => page.getByTestId('live-region');
/** Wait for every running animation and transition under `selector` (a theme swap's) before axe measures. */
async function settled(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
}
const header = (page: Page, label: string) =>
  page.getByRole('columnheader', { name: new RegExp(`^${label}`) });
const columnField = (page: Page) => page.getByRole('textbox', { name: 'Column name' });
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Table title' });
/** The room's one table, as every client will show it. */
const stored = (room: FakeRoom) => {
  const gd = openDocument(room.doc);
  const id = Array.from(gd.tables.keys())[0] ?? '';
  return tableRecord(gd.tables.get(id)!);
};

for (const width of [1024, 1440] as const) {
  test(`INSP-04 MENU-03 KEYS-06 KEYS-08 A11Y-01 A11Y-05 REF-01 GRID-08 at ${String(width)} px: a new table's Column 2 is renamed Owner inline by double-click, the title by F2 with the table selected, a column by F2 from the keyboard, another from its menu and another from the Table tab; ${mod}+Z undoes one rename at a time; a formula bound to the column survives; both names survive a reload; with the header row hidden the columns still resize`, async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await openDoc(page, width);
    // The customer's case: a table the person just added, not the seeded sample.
    await page.getByRole('button', { name: 'Add table' }).click();
    const b5 = page.locator('[data-address="B5"]');
    await expect(b5).toBeVisible();
    await expect.poll(() => room.doc.getMap('tables').size).toBe(1);
    await expect(header(page, 'Column 2')).toBeVisible();

    // A formula that names Column 2 by its label; it is bound to the column's id (REF-01).
    await b5.dblclick();
    await page.getByLabel('Edit B5').fill('Namche');
    await page.keyboard.press('Enter');
    const c5 = page.locator('[data-address="C5"]');
    await c5.dblclick();
    await page.getByLabel('Edit C5').fill('3440');
    await page.keyboard.press('Enter');
    const d6 = page.locator('[data-address="D6"]');
    await d6.dblclick();
    await page.getByLabel('Edit D6').fill('=Sum(@"Table 1".Namche."Column 2")');
    await page.keyboard.press('Enter');
    await expect(d6).toContainText('3,440');

    // ── Inline, by pointer: a double-click on the label opens a real input in the header,
    // the name selected; Enter writes it, announces it, and the header shows the new name.
    await header(page, 'Column 2').locator('.gd-table__header-label').dblclick();
    const field = columnField(page);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Column 2');
    expect(await field.evaluate((el) => el.closest('[role="columnheader"]') !== null)).toBe(true);
    await checkA11y(`column rename field ${String(width)}`);
    await snapshot(`column-rename-${String(width)}`);
    await page.keyboard.type('Owner');
    await page.keyboard.press('Enter');
    await expect(columnField(page)).toHaveCount(0);
    await expect(header(page, 'Owner')).toBeVisible();
    await expect(live(page)).toHaveText('Renamed column Column 2 to Owner');
    await expect.poll(() => stored(room).columns[1]?.label).toBe('Owner');
    // The formula kept its binding: the value holds, the shown path re-spells.
    await expect(d6).toContainText('3,440');
    await expect(d6).toContainText('@"Table 1".Namche.Owner');

    // ── The title, by F2 with the table selected (Ctrl+A from a cell): the field stands in
    // for the title text; Enter renames; focus lands on the title bar, the table stays selected.
    await b5.click();
    await page.keyboard.press(`${mod}+KeyA`);
    await expect(live(page)).toHaveText('Selected Table 1');
    await page.keyboard.press('F2');
    const title = titleField(page);
    await expect(title).toBeFocused();
    await expect(title).toHaveValue('Table 1');
    await checkA11y(`table title field ${String(width)}`);
    await page.keyboard.type('Roster');
    await page.keyboard.press('Enter');
    await expect(titleField(page)).toHaveCount(0);
    await expect(page.getByRole('grid', { name: 'Roster' })).toBeVisible();
    await expect(live(page)).toHaveText('Renamed table Table 1 to Roster');
    await expect.poll(() => stored(room).title).toBe('Roster');
    await expect(d6).toContainText('@Roster.Namche.Owner');

    // ── A column by keyboard alone: Shift+→ from B5 selects Column 1; F2 opens its field;
    // Escape keeps the name and puts focus back on the cell (MENU-05).
    await b5.click();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(header(page, 'Column 1')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('F2');
    await expect(columnField(page)).toBeFocused();
    await page.keyboard.type('Nope');
    await page.keyboard.press('Escape');
    await expect(columnField(page)).toHaveCount(0);
    await expect(header(page, 'Column 1')).toBeVisible();
    await expect(b5).toBeFocused();
    // An empty name is refused beside the field and said (A11Y-04, A11Y-05).
    await page.keyboard.press('F2');
    await expect(columnField(page)).toBeFocused();
    await columnField(page).fill('');
    await page.keyboard.press('Enter');
    await expect(columnField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(columnField(page)).toHaveAttribute('placeholder', 'A column needs a name');
    await expect(live(page)).toHaveText('A column needs a name');
    await page.keyboard.type('Place');
    await page.keyboard.press('Enter');
    await expect(header(page, 'Place')).toBeVisible();

    // ── A duplicate is refused where it was typed, with the reason beside the field and said
    // once; leaving the field with the refused name cancels (the label returns, focus stays put).
    await header(page, 'Column 3').locator('.gd-table__header-label').dblclick();
    await expect(columnField(page)).toBeFocused();
    await columnField(page).fill('owner');
    await page.keyboard.press('Enter');
    await expect(columnField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.gd-table__rename-reason')).toHaveText(
      'Another column is already named Owner',
    );
    await expect(live(page)).toHaveText('Another column is already named Owner');
    await checkA11y(`column rename refused ${String(width)}`);
    await snapshot(`column-rename-refused-${String(width)}`);
    await b5.click();
    await expect(columnField(page)).toHaveCount(0);
    await expect(header(page, 'Column 3')).toBeVisible();
    await expect(b5).toBeFocused();
    // ── A derived column's label is its signature: no field from any route, the reason said.
    const gd = openDocument(room.doc);
    const tableId = Array.from(gd.tables.keys())[0] ?? '';
    const record = tableRecord(gd.tables.get(tableId)!);
    // Appended after Column 3, so no existing address moves.
    addDerivedColumn(
      gd,
      tableId,
      { sourceColId: record.columns[0]!.id, method: 'Format', args: ['Trimmed'] },
      record.columns[2]!.id,
    );
    const derivedHeader = page.getByRole('columnheader', { name: /^@/ });
    await expect(derivedHeader).toBeVisible();
    await derivedHeader.locator('.gd-table__header-label').dblclick();
    await expect(columnField(page)).toHaveCount(0);
    await expect(live(page)).toHaveText(
      /keeps its name: a derived column is named by its signature/,
    );
    await derivedHeader.click({ button: 'right' });
    const derivedItem = page.getByRole('menuitem', { name: /Rename column…/ });
    await expect(derivedItem).toHaveAttribute('aria-disabled', 'true');
    await expect(derivedItem).toHaveAttribute(
      'title',
      'a derived column is named by its signature',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // ── From the column menu (MENU-03): Rename column… names F2 and opens the field.
    await header(page, 'Column 3').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Column menu' });
    await expect(menu).toBeVisible();
    const item = menu.getByRole('menuitem', { name: /Rename column…/ });
    await expect(item).toContainText('F2');
    await item.click();
    await expect(columnField(page)).toBeFocused();
    await page.keyboard.type('Status');
    await page.keyboard.press('Enter');
    await expect(header(page, 'Status')).toBeVisible();

    // ── The home (INSP-04): the Table tab's Title text and the selected column's Name.
    await b5.click();
    const rail = await openRail(page);
    await rail.getByRole('tab', { name: 'Table' }).click();
    const titleText = rail.getByRole('textbox', { name: 'Title text' });
    await expect(titleText).toHaveValue('Roster');
    const name = rail.getByRole('textbox', { name: 'Name' });
    await expect(name).toHaveValue('Place');
    await name.fill('Camp');
    await name.press('Enter');
    await expect(header(page, 'Camp')).toBeVisible();
    await expect(live(page)).toHaveText('Renamed column Place to Camp');
    await checkA11y(`table tab names ${String(width)}`);
    await snapshot(`table-tab-names-${String(width)}`);

    // ── One undo step per rename (KEYS-03); from the grid, not the field (which keeps its own).
    await b5.click();
    await page.keyboard.press(`${mod}+KeyZ`);
    await expect(header(page, 'Place')).toBeVisible();
    await expect(header(page, 'Status')).toBeVisible();
    await page.keyboard.press(`${mod}+Shift+KeyZ`);
    await expect(header(page, 'Camp')).toBeVisible();

    // ── With the header row hidden (GRID-11) the dividers sit in a strip over the first
    // body row: the selected column's is a separator with its name, the arrows resize it.
    await rail.getByRole('button', { name: 'Fewer header rows' }).click();
    await expect(page.getByRole('columnheader')).toHaveCount(0);
    await expect(page.getByRole('separator', { name: /^Resize column / })).toHaveCount(4);
    // Shift+Tab from the first cell reaches the selected column's divider (A11Y-01), as it
    // does with the header row shown; the arrows resize it, Shift steps four.
    const b4 = page.locator('[data-address="B4"]');
    await b4.click();
    await page.keyboard.press('Shift+Tab');
    const first = page.getByRole('separator', { name: 'Resize column Camp' });
    await expect(first).toBeFocused();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(first).toHaveAttribute('aria-valuenow', '5');
    await expect(b4).toHaveCSS('width', '800px');
    await page.keyboard.press(`${mod}+KeyZ`);
    await expect(first).toHaveAttribute('aria-valuenow', '1');
    // A drag on Owner's divider previews and commits once; a double-click fits it back.
    const owner = page.getByRole('separator', { name: 'Resize column Owner' });
    const box = await owner.boundingBox();
    if (!box) throw new Error('divider has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 170, box.y + box.height / 2, { steps: 6 });
    await expect(page.locator('[data-address="C4"]')).toHaveCSS('width', '320px');
    await page.mouse.up();
    await expect(owner).toHaveAttribute('aria-valuenow', '2');
    await expect(live(page)).toHaveText(/Owner is 2 units wide/);
    await owner.dblclick();
    await expect(owner).toHaveAttribute('aria-valuenow', '1');
    await expect(live(page)).toHaveText(/Fitted 1 column to content/);
    // The cell menu fits the column too, with no header (and so no column menu) to open.
    await page.locator('[data-address="C4"]').click({ button: 'right' });
    const fitItem = page.getByRole('menuitem', { name: 'Fit column width to content' });
    await expect(fitItem).toBeVisible();
    await expect(fitItem).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await checkA11y(`hidden header dividers ${String(width)}`);
    await snapshot(`hidden-header-dividers-${String(width)}`);
    await rail.getByRole('button', { name: 'More header rows' }).click();
    await expect(page.getByRole('columnheader')).toHaveCount(4);
    await expect(page.getByRole('separator', { name: /^Resize column / })).toHaveCount(4);
    // The resting cue: a selected table's column boundaries carry a 2 px rule in the strong
    // border token before any hover (ADR-051); the divider's line is transparent otherwise.
    const rule = (name: string) =>
      page
        .getByRole('separator', { name })
        .evaluate((el) => getComputedStyle(el, '::after').backgroundColor);
    expect(await rule('Resize column Camp')).not.toBe('rgba(0, 0, 0, 0)');
    await snapshot(`selected-table-dividers-${String(width)}`);
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await settled(page, 'body');
    expect(await rule('Resize column Camp')).not.toBe('rgba(0, 0, 0, 0)');
    await checkA11y(`selected table dividers dark ${String(width)}`);
    await snapshot(`selected-table-dividers-${String(width)}-dark`);
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });

    // ── Reload: tokens live in memory, so the sign-in comes again; the room kept the names.
    await page.reload();
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'Roster' })).toBeVisible();
    await expect(header(page, 'Camp')).toBeVisible();
    await expect(header(page, 'Owner')).toBeVisible();
    await expect(header(page, 'Status')).toBeVisible();
    await expect(page.locator('[data-address="D6"]')).toContainText('3,440');
    await checkA11y(`renamed table after reload ${String(width)}`);
  });
}

test('RESP-02 at 480 the phone shows the names and offers no rename: no field on a double-tap or F2, no divider, no menu', async ({
  page,
  checkA11y,
}) => {
  const room = await installFakes(page);
  await asPhone(page, 480, 900);
  // A table renamed elsewhere: the phone shows the names it was given.
  const gd = openDocument(room.doc);
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, {
    sheetId,
    at: { col: 1, row: 1 },
    columns: 2,
    rows: 2,
    title: 'Roster',
  });
  renameColumn(gd, tableId, tableRecord(gd.tables.get(tableId)!).columns[1]!.id, 'Owner');
  await signInTo(page, `/d/${DOC_ID}`);
  await expect(page.getByRole('grid', { name: 'Roster' })).toBeVisible();
  await expect(header(page, 'Owner')).toBeVisible();
  await header(page, 'Owner').dblclick();
  await expect(columnField(page)).toHaveCount(0);
  await page.getByText('Roster', { exact: true }).first().dblclick();
  await expect(titleField(page)).toHaveCount(0);
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('separator')).toHaveCount(0);
  await header(page, 'Owner').click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await checkA11y('renamed table phone 480');
});
