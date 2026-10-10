/**
 * Set tables, phase 3 (SET-01, SET-09, SET-10, SET-11, DOC-02, MENU-03; ADR-056, SPEC §1):
 * the sets E, C and B are on the sheet; the product E × C × B is built through Add table
 * (Cartesian product, One column per set) and through Fill column with formula… on a plain
 * table (One column), and a note typed beside a tuple stays on that tuple's row. Against the
 * built bundle at 1440 and 1024 px, axe on every new surface. Everything outside the browser
 * is a labelled FAKE at the network edge: Cognito (`fakes/cognito`), the documents REST API
 * and the room (`fakes/room`).
 */
import type { Page } from '@playwright/test';
import {
  addRow,
  cellText,
  computedRowId,
  createSheet,
  createTable,
  listSheets,
  nestRow,
  openDocument,
  renameColumn,
  setCellText,
  setTableLook,
  tableRecord,
  tablesOnSheet,
  type GedeDoc,
  type Id,
} from '@gede/core';
import { asDesktop, asPhone, expect, test, zoomed200 } from './fixtures/test.js';
import { FAKE_SIGN_IN_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000se56';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-56',
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
  title: 'Sets',
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

/** A Simple set as Add table makes one (range, description), holding `elements`. */
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

const tableTitled = (room: FakeRoom, title: string) => {
  const gd = openDocument(room.doc);
  return tablesOnSheet(gd, listSheets(gd)[0]?.id ?? '').find((t) => t.title === title);
};

/** Wait for the dialog's entrance (and every transition in it) before axe measures. */
async function settled(page: Page): Promise<void> {
  await page
    .getByRole('dialog')
    .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
}

/** Pick `title` for the `n`th set of the product. */
async function pickSet(page: Page, n: number, title: string) {
  await page.getByRole('combobox', { name: `Set ${String(n)} of the product` }).click();
  await page.getByRole('option', { name: new RegExp(`^${title}\\b`) }).click();
}

/** Type `text` into the cell of `grid` at row `row` (0 = first body row), column `col`. */
async function typeInto(page: Page, gridName: string, row: number, col: number, text: string) {
  const grid = page.getByRole('grid', { name: gridName });
  const cell = grid
    .getByRole('row')
    .nth(row + 1)
    .getByRole('gridcell')
    .nth(col);
  const address = await cell.getAttribute('data-address');
  await cell.dblclick();
  await page.getByLabel(`Edit ${address ?? ''}`).fill(text);
  await page.keyboard.press('Enter');
}

for (const width of [1440, 1024] as const) {
  test(`SET-01 SET-09 SET-10 SET-11 DOC-02 MENU-03 at ${String(width)} px: E × C × B is built from Add table in One column per set and from Fill column with formula… in One column; a note typed beside a tuple stays on its row`, async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    const sheetId = createSheet(seeded);
    seedSet(seeded, sheetId, 'E', 1, ['a', 'b', 'c']);
    seedSet(seeded, sheetId, 'C', 4, ['b', 'c', 'x']);
    seedSet(seeded, sheetId, 'B', 7, ['x', 'y']);
    await asDesktop(page, width, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'B' })).toBeVisible();

    // ── Add table asks the kind (SET-01, DOC-02): Plain table preselected and focused.
    await page.getByRole('button', { name: 'Add table' }).click();
    const kindDialog = page.getByRole('dialog', { name: 'What kind of table is this?' });
    await expect(kindDialog).toBeVisible();
    await expect(kindDialog.getByRole('radio', { name: /^Plain table/ })).toBeFocused();
    await expect(kindDialog.getByRole('radio', { name: /^Plain table/ })).toBeChecked();
    await settled(page);
    await checkA11y(`add table kind ${String(width)}`);
    await snapshot(`add-table-kind-${String(width)}`);
    await kindDialog.getByRole('radio', { name: /^Cartesian product/ }).click();
    await kindDialog.getByRole('button', { name: 'Pick sets' }).click();

    // ── Pick sets (SET-09): E, C, then B added; One column per set.
    const pickDialog = page.getByRole('dialog', { name: 'Add a computed table' });
    await expect(pickDialog.getByTestId('set-picker-formula')).toHaveText('= Cross(E, C)');
    await pickDialog.getByRole('button', { name: 'Add another set' }).click();
    await pickSet(page, 3, 'B');
    await expect(pickDialog.getByTestId('set-picker-formula')).toHaveText('= Cross(E, C, B)');
    await expect(pickDialog.getByRole('radio', { name: /^One column per set/ })).toBeChecked();
    await settled(page);
    await checkA11y(`pick sets ${String(width)}`);
    await snapshot(`pick-sets-${String(width)}`);
    await pickDialog.getByRole('button', { name: 'Add table' }).click();
    await expect(pickDialog).toHaveCount(0);

    const product = page.getByRole('grid', { name: 'E × C × B' });
    await expect(product).toBeVisible();
    for (const label of ['x1 ∈ E', 'x2 ∈ C', 'x3 ∈ B', 'note']) {
      await expect(
        product.getByRole('columnheader', { name: new RegExp(`^${label}`) }),
      ).toBeVisible();
    }
    await expect.poll(() => tableTitled(room, 'E × C × B')?.rows.length).toBe(18);
    const spread = tableTitled(room, 'E × C × B')!;
    expect(spread.kind).toBe('product');
    const firstTuple = computedRowId(spread.id, '(a, b, x)');
    expect(spread.rows[0]).toBe(firstTuple);
    await expect(product.getByRole('row').nth(1).getByRole('gridcell').nth(2)).toHaveText(/x/);

    // ── A note beside the tuple (a, b, x) lives on that tuple's row (SET-11).
    await typeInto(page, 'E × C × B', 0, 3, 'first tuple');
    await expect
      .poll(() => {
        const t = tableTitled(room, 'E × C × B')!;
        const map = openDocument(room.doc).tables.get(t.id)!;
        const note = t.columns[3]!.id;
        const cells = map.get('cells') as { has: (key: string) => boolean };
        return cells.has(`${firstTuple}:${note}`);
      })
      .toBe(true);

    // ── Fill column with formula… on a plain table's empty column (SET-10, MENU-03).
    await page.getByRole('button', { name: 'Add table' }).click();
    await page.keyboard.press('Enter');
    const plain = page.getByRole('grid', { name: 'Table 5' });
    await expect(plain).toBeVisible();
    await plain.getByRole('columnheader', { name: /^Column 1/ }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Column menu' });
    await menu.getByRole('menuitem', { name: /Fill column with formula…/ }).click();
    const fillDialog = page.getByRole('dialog', { name: 'Fill Column 1 with a formula' });
    await expect(fillDialog).toBeVisible();
    await fillDialog.getByRole('button', { name: 'Add another set' }).click();
    await pickSet(page, 3, 'B');
    await fillDialog.getByRole('radio', { name: /^One column\b(?! per)/ }).click();
    await expect(fillDialog.getByTestId('set-picker-formula')).toHaveText('= Cross(E, C, B)');
    await settled(page);
    await checkA11y(`fill column ${String(width)}`);
    await snapshot(`fill-column-${String(width)}`);
    await fillDialog.getByRole('button', { name: 'Fill column' }).click();
    await expect(fillDialog).toHaveCount(0);

    // Eighteen computed rows; the plain table's five rows stay, typed by no one (SPEC §2.3).
    await expect.poll(() => tableTitled(room, 'Table 5')?.rows.length).toBe(18 + 5);
    const filled = tableTitled(room, 'Table 5')!;
    expect(filled.columns[0]!.computed).toEqual(expect.objectContaining({ shape: 'column' }));
    const tuple = computedRowId(filled.id, '(a, b, x)');
    const row = filled.rows.indexOf(tuple);
    expect(row).toBeGreaterThanOrEqual(0);
    await expect(
      plain
        .getByRole('row')
        .nth(row + 1)
        .getByRole('gridcell')
        .nth(0),
    ).toHaveText('(a, b, x)');
    await typeInto(page, 'Table 5', row, 1, 'beside (a, b, x)');
    await expect
      .poll(() => {
        const map = openDocument(room.doc).tables.get(filled.id)!;
        const cells = map.get('cells') as { has: (key: string) => boolean };
        return cells.has(`${tuple}:${filled.columns[1]!.id}`);
      })
      .toBe(true);
    // Fill is now unavailable on the filled column, with the reason (MENU-02).
    await plain.getByRole('columnheader', { name: /^Column 1/ }).click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: /Fill column with formula…/ })).toHaveAttribute(
      'title',
      'the column is computed',
    );
    await page.keyboard.press('Escape');
    await checkA11y(`computed tables ${String(width)}`);
    await snapshot(`computed-tables-${String(width)}`);
  });
}

/** The two steps of Add table, with E and C on the sheet, then Escape: nothing is added. */
async function walkAddTable(
  page: Page,
  room: FakeRoom,
  screen: string,
  checkA11y: (s: string) => Promise<unknown>,
  snapshot: (s: string) => Promise<void>,
) {
  await page.getByRole('button', { name: 'Add table' }).click();
  const kindDialog = page.getByRole('dialog', { name: 'What kind of table is this?' });
  await expect(kindDialog.getByRole('radio', { name: /^Plain table/ })).toBeFocused();
  // Keyboard only: the arrows move the kind, Enter takes the computed kind to Pick sets.
  // Radix checks the card that gains focus while the arrow is still down, as a finger holds it.
  await page.keyboard.down('ArrowUp');
  await expect(kindDialog.getByRole('radio', { name: /^Cartesian product/ })).toBeChecked();
  await page.keyboard.up('ArrowUp');
  await expect(kindDialog.getByRole('button', { name: 'Pick sets' })).toBeVisible();
  await settled(page);
  await checkA11y(`add table kind ${screen}`);
  await snapshot(`add-table-kind-${screen}`);
  await page.keyboard.press('Enter');
  const pickDialog = page.getByRole('dialog', { name: 'Add a computed table' });
  await expect(pickDialog.getByTestId('set-picker-formula')).toHaveText('= Cross(E, C)');
  await settled(page);
  await checkA11y(`pick sets ${screen}`);
  await snapshot(`pick-sets-${screen}`);
  await page.keyboard.press('Escape');
  await expect(pickDialog).toHaveCount(0);
  expect(openDocument(room.doc).tables.size).toBe(2);
}

function seedTwo(room: FakeRoom): void {
  const seeded = openDocument(room.doc);
  const sheetId = createSheet(seeded);
  seedSet(seeded, sheetId, 'E', 1, ['a', 'b']);
  seedSet(seeded, sheetId, 'C', 4, ['x']);
}

test('SET-01 A11Y-01 at 768 px the kind and the sets are picked by keyboard alone; Escape adds nothing', async ({
  page,
  checkA11y,
  snapshot,
}) => {
  const room = await installFakes(page);
  seedTwo(room);
  await asDesktop(page, 768, 900);
  await signInTo(page, `/d/${DOC_ID}`);
  await expect(page.getByRole('grid', { name: 'C' })).toBeVisible();
  await walkAddTable(page, room, '768', checkA11y, snapshot);
});

test.describe('200 % zoom', () => {
  test.use(zoomed200(1024));
  test('SET-01 A11Y-06 at 200 % zoom both steps of Add table read and fit', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await installFakes(page);
    seedTwo(room);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('tab', { name: /Sheet 1/ })).toBeVisible();
    await walkAddTable(page, room, '1024 200%', checkA11y, snapshot);
  });
});

/** E, C and a plain two-column table P with no rows. */
function seedTwoAndPlain(room: FakeRoom): void {
  const seeded = openDocument(room.doc);
  const sheetId = createSheet(seeded);
  seedSet(seeded, sheetId, 'E', 1, ['a', 'b']);
  seedSet(seeded, sheetId, 'C', 4, ['b', 'c']);
  createTable(seeded, { sheetId, at: { col: 1, row: 8 }, columns: 2, rows: 0, title: 'P' });
}

test.describe('Phase 3 red-team regressions', () => {
  test('RESP-02 SET-10 an open Fill column dialog goes when the window becomes a phone, and nothing is filled', async ({
    page,
  }) => {
    const room = await installFakes(page);
    seedTwoAndPlain(room);
    await asDesktop(page, 1024, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    const plain = page.getByRole('grid', { name: 'P' });
    await plain.getByRole('columnheader', { name: /^Column 1/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Fill column with formula…/ }).click();
    const fill = page.getByRole('dialog', { name: /Fill Column 1 with a formula/ });
    await expect(fill).toBeVisible();
    await asPhone(page, 480, 900);
    await expect(fill).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fill column' })).toHaveCount(0);
    expect(tableTitled(room, 'P')?.columns.map((c) => c.source)).toEqual(['entered', 'entered']);
    // Back at desktop width the dialog does not come back on its own.
    await asDesktop(page, 1024, 900);
    await expect(page.getByRole('grid', { name: 'P' })).toBeVisible();
    await expect(fill).toHaveCount(0);
  });

  test('RESP-02 SET-01 an open Add table dialog goes when the window becomes a phone', async ({
    page,
  }) => {
    const room = await installFakes(page);
    seedTwoAndPlain(room);
    await asDesktop(page, 1024, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'P' })).toBeVisible();
    await page.getByRole('button', { name: 'Add table' }).click();
    const kindDialog = page.getByRole('dialog', { name: 'What kind of table is this?' });
    await expect(kindDialog).toBeVisible();
    await asPhone(page, 480, 900);
    await expect(kindDialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add table' })).toHaveCount(0);
    expect(openDocument(room.doc).tables.size).toBe(3);
  });

  test('SET-10 SET-08 the note column of a computed E ∪ C offers no second formula: E ∪ C keeps showing E ∪ C', async ({
    page,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    seedTwoAndPlain(room);
    await asDesktop(page, 1440, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'P' })).toBeVisible();
    await page.getByRole('button', { name: 'Add table' }).click();
    const kindDialog = page.getByRole('dialog', { name: 'What kind of table is this?' });
    await kindDialog.getByRole('radio', { name: /^Computed by formula/ }).click();
    await kindDialog.getByRole('button', { name: 'Pick sets' }).click();
    const pickDialog = page.getByRole('dialog', { name: 'Add a computed table' });
    // Focus lands on the first field of the step, the checked operation.
    await expect(pickDialog.getByRole('radio', { name: /^Union/ })).toBeFocused();
    await expect(pickDialog.getByTestId('set-picker-formula')).toHaveText('= Union(E, C)');
    await pickDialog.getByRole('button', { name: 'Add table' }).click();
    const union = page.getByRole('grid', { name: 'E ∪ C' });
    await expect(union).toBeVisible();
    await expect.poll(() => tableTitled(room, 'E ∪ C')?.rows.length).toBe(3);
    await union.getByRole('columnheader', { name: /^note/ }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Column menu' });
    await expect(menu.getByRole('menuitem', { name: /Fill column with formula…/ })).toHaveAttribute(
      'title',
      'the table already has a formula',
    );
    await page.keyboard.press('Escape');
    await checkA11y('computed table note column 1440');
    expect(tableTitled(room, 'E ∪ C')?.computedFormula).toMatch(/^=Union\(/);
    await expect(union.getByRole('row')).toHaveCount(4);
  });

  test('SET-01 MENU-01 Add table here on the canvas asks the kind, as the toolbar does', async ({
    page,
  }) => {
    const room = await installFakes(page);
    seedTwoAndPlain(room);
    await asDesktop(page, 1024, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'P' })).toBeVisible();
    const plane = page.getByTestId('plane');
    const box = (await plane.boundingBox())!;
    await plane.click({
      button: 'right',
      position: { x: box.width - 120, y: box.height - 120 },
    });
    await page.getByRole('menuitem', { name: 'Add table here' }).click();
    const kindDialog = page.getByRole('dialog', { name: 'What kind of table is this?' });
    await expect(kindDialog.getByRole('radio', { name: /^Plain table/ })).toBeChecked();
    await kindDialog.getByRole('radio', { name: /^Simple set/ }).click();
    await kindDialog.getByRole('button', { name: 'Add table' }).click();
    await expect(kindDialog).toHaveCount(0);
    await expect.poll(() => openDocument(room.doc).tables.size).toBe(4);
    const added = tableTitled(room, 'Table 4');
    expect(added?.kind).toBe('simple');
  });

  test('SET-09 FX-09 a product past the cap is refused with ⚠ too many tuples in its header, the message naming the count and the limit', async ({
    page,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    const sheetId = createSheet(seeded);
    seedSet(
      seeded,
      sheetId,
      'E',
      1,
      Array.from({ length: 101 }, (_, i) => `e${String(i)}`),
    );
    seedSet(
      seeded,
      sheetId,
      'C',
      4,
      Array.from({ length: 100 }, (_, i) => `c${String(i)}`),
    );
    await asDesktop(page, 1440, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'C' })).toBeVisible();
    await page.getByRole('button', { name: 'Add table' }).click();
    const kindDialog = page.getByRole('dialog', { name: 'What kind of table is this?' });
    await kindDialog.getByRole('radio', { name: /^Cartesian product/ }).click();
    await kindDialog.getByRole('button', { name: 'Pick sets' }).click();
    const pickDialog = page.getByRole('dialog', { name: 'Add a computed table' });
    await pickDialog.getByRole('radio', { name: /^One column\b(?! per)/ }).click();
    await pickDialog.getByRole('button', { name: 'Add table' }).click();
    await expect.poll(() => tableTitled(room, 'E × C')?.kind).toBe('product');
    // The product sits below the 101-row E; scroll the canvas down to it.
    const product = page.getByRole('grid', { name: 'E × C' });
    const plane = page.getByTestId('plane');
    await plane.hover();
    await expect(async () => {
      await page.mouse.wheel(0, 600);
      await expect(product).toBeVisible({ timeout: 300 });
    }).toPass({ timeout: 15_000 });
    const message = 'Cross would make 10,100 tuples, past the limit of 10,000; narrow the sets';
    // In words in the title bar, the message beside them for assistive technology and hover.
    const error = page.getByRole('region', { name: 'E × C' }).getByTestId('computed-error');
    await expect(error).toContainText('too many tuples');
    await expect(error).toContainText(message);
    await expect(error).toHaveAttribute('title', message);
    // And as ⚠ on the computed column's heading, named by the same words.
    await expect(
      product
        .getByRole('columnheader', { name: /^range/ })
        .getByRole('img', { name: `too many tuples: ${message}` }),
    ).toBeVisible();
    expect(tableTitled(room, 'E × C')?.rows.length).toBe(0);
    await checkA11y('product past the cap 1440');
  });
});

/**
 * Set tables, phase 4 (SET-02..07; designs SimpleSet and FamilyOfSets): a Simple set reads
 * its meta row, title row, degree rail and count strip as it is typed into; a comma value in
 * its range offers Split into rows; a family states each row's kind in words. Axe on each.
 */
for (const width of [1440, 1024] as const) {
  test(`SET-02 SET-03 SET-04 SET-05 SET-07 at ${String(width)} px: a Simple set states its meta row, title row, degrees and counts as it is typed into, and a comma value splits into rows`, async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    const sheetId = createSheet(seeded);
    seedSet(seeded, sheetId, 'E', 2, ['a', 'b', 'c', 'b']);
    await asDesktop(page, width, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    const set = page.getByRole('grid', { name: 'E' });
    await expect(set).toBeVisible();
    const section = page.locator('section[aria-label="E"]');

    // ── The meta row (SET-03): id, and “—” where the definition says nothing; the kind sits
    // in the title row (SET-04).
    const meta = section.getByTestId('set-meta');
    await expect(section.getByTestId('set-kind-badge')).toHaveText('Simple set');
    const facts = meta.getByRole('list', { name: 'Set facts' }).getByRole('listitem');
    await expect(facts).toHaveCount(5);
    // Spoken (visually hidden), then shown.
    await expect(facts.nth(2)).toHaveText(
      'bound or free variable: not determined from the definition—',
    );
    // ── The rail (SET-07) and the count strip (SET-05): a repeat counts in the bag only.
    await expect(section.getByTestId('set-degree')).toHaveText([
      '−2°',
      '−1°',
      '±0°',
      '+1°',
      '+2°',
      '+3°',
      '+4°',
    ]);
    await expect(section.getByTestId('set-counts')).toContainText('|E| = 3');
    await expect(section.getByTestId('set-counts')).toContainText('bag 4');
    await expect(section.getByTestId('set-note')).toHaveText(['repeat of +2°']);
    // The rail is presentation: the first element keeps the address a plain table's has (C5).
    await expect(set.getByRole('row').nth(1).getByRole('gridcell').first()).toHaveAttribute(
      'data-address',
      'C5',
    );
    await checkA11y(`simple set ${String(width)}`);
    await snapshot(`simple-set-${String(width)}`);

    // ── A comma value typed into the range offers Split into rows (SET-02).
    await typeInto(page, 'E', 2, 0, 'c, d, e');
    const offer = page.getByRole('button', { name: 'Split into rows' });
    await expect(offer).toBeVisible();
    await expect(page.getByText('C7 holds 3 elements', { exact: true })).toBeVisible();
    // The toast fades in; axe measures it once its entrance has finished.
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
    );
    await checkA11y(`split offer ${String(width)}`);
    await offer.click();
    await expect.poll(() => tableTitled(room, 'E')?.rows.length).toBe(6);
    await expect(section.getByTestId('set-counts')).toContainText('|E| = 5');
    await expect(section.getByTestId('set-counts')).toContainText('bag 6');
    // The meta row and the counts follow the typing; the definition is the caption (SET-04).
    await expect(meta).not.toContainText('singleton');
  });
}

test('SET-06 SET-07 at 1440 px a family states each row as element, set or family in words, with degrees by depth', async ({
  page,
  checkA11y,
}) => {
  const room = await installFakes(page);
  const seeded = openDocument(room.doc);
  const sheetId = createSheet(seeded);
  seedSet(seeded, sheetId, 'T', 2, ['d', 'A', 'a', 'b']);
  const family = tablesOnSheet(seeded, sheetId)[0]!;
  seeded.tables.get(family.id)!.set('kind', 'family');
  await asDesktop(page, 1440, 900);
  await signInTo(page, `/d/${DOC_ID}`);
  const section = page.locator('section[aria-label="T"]');
  await expect(section.getByRole('grid', { name: 'T' })).toBeVisible();
  // Nest a and b under A by keyboard (HIER-01): the suite's Desktop Chrome UA is Windows, so ⌘]
  // is Control here. Once a row nests the grid is a treegrid, so rows are found through the
  // table's section.
  for (const row of [3, 4]) {
    await section.getByRole('row').nth(row).getByRole('gridcell').first().click();
    await page.keyboard.press('Control+BracketRight');
  }
  await expect(section.getByTestId('set-kind-badge')).toHaveText('Family of sets');
  // A kind column (SET-06), headed “kind”, inside the table's right edge.
  await expect(section.getByTestId('set-kind-header')).toHaveText('kind');
  await expect(section.getByTestId('set-kind')).toHaveText([
    'element',
    'set',
    'element',
    'element',
  ]);
  await expect(section.getByTestId('set-note')).toHaveCount(0);
  await expect(section.getByTestId('set-degree')).toHaveText([
    '−2°',
    '−1°',
    '±0°',
    '+1°',
    '+2°',
    '+2.1°',
    '+2.2°',
  ]);
  await expect(section.getByTestId('set-counts')).toContainText('|T| = 2');
  await expect(section.getByTestId('set-counts')).toContainText('bag 3');
  await checkA11y('family of sets 1440');
});

/** The right edges of the meta-row values that pass the list's own right edge. */
async function clippedFacts(page: Page, section: ReturnType<Page['locator']>): Promise<string[]> {
  const list = section.getByTestId('set-meta').getByRole('list', { name: 'Set facts' });
  const box = await list.boundingBox();
  if (box === null) throw new Error('no meta row');
  const out: string[] = [];
  for (const item of await list.getByRole('listitem').all()) {
    const b = await item.boundingBox();
    if (b === null || b.x + b.width > box.x + box.width + 0.5 || b.width < 8) {
      out.push((await item.getAttribute('title')) ?? '');
    }
  }
  return out;
}

/** A family T = d, A = {a, b} at column C, seeded nested. */
function seedFamily(room: FakeRoom): Id {
  const seeded = openDocument(room.doc);
  const sheetId = createSheet(seeded);
  const id = seedSet(seeded, sheetId, 'T', 2, ['d', 'A', 'a', 'b']);
  const table = seeded.tables.get(id)!;
  table.set('kind', 'family');
  const rows = tableRecord(table).rows;
  for (const rowId of rows.slice(2)) nestRow(seeded, id, rowId);
  setTableLook(seeded, id, { caption: '{ d, {a, b} }' });
  return id;
}

test.describe('Phase 4 red-team regressions', () => {
  test('SET-03 at 1440 px every meta-row value of a default two-column set is visible, not clipped', async ({
    page,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    const sheetId = createSheet(seeded);
    const id = seedSet(seeded, sheetId, 'E', 2, ['a']);
    setTableLook(seeded, id, { caption: '∀x { x | x is a letter in abc }' });
    await asDesktop(page, 1440, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    const section = page.locator('section[aria-label="E"]');
    await expect(section.getByRole('grid', { name: 'E' })).toBeVisible();
    const facts = section.getByTestId('set-meta').getByRole('listitem');
    await expect(facts).toHaveCount(5);
    await expect(facts.nth(4)).toHaveAttribute('title', 'special status: singleton');
    await expect(facts.nth(4)).toHaveText(/singleton$/);
    expect(await clippedFacts(page, section)).toEqual([]);
    // The status, finiteness and binding read whole; only the id gives way to an ellipsis.
    for (const n of [1, 2, 3, 4]) {
      const shown = facts.nth(n).locator('.gd-set-meta__shown');
      // Laid out at least as wide as its text: no ellipsis, not even a sub-pixel one.
      expect(
        await shown.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect().width <= el.getBoundingClientRect().width + 0.01;
        }),
        (await facts.nth(n).getAttribute('title')) ?? '',
      ).toBe(true);
    }
  });

  test('SET-07 the degree rail stays inside its table: nothing draws over an abutting table, and a set at column A keeps its rail', async ({
    page,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    const sheetId = createSheet(seeded);
    seedSet(seeded, sheetId, 'A', 0, ['p', 'q']);
    createTable(seeded, { sheetId, at: { col: 3, row: 1 }, columns: 2, rows: 2, title: 'Plain' });
    seedSet(seeded, sheetId, 'E', 5, ['a', 'b']);
    await asDesktop(page, 1440, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    const plain = page.locator('section[aria-label="Plain"]');
    await expect(plain.getByRole('grid', { name: 'Plain' })).toBeVisible();
    const plainBox = (await plain.boundingBox())!;
    for (const title of ['A', 'E']) {
      const section = page.locator(`section[aria-label="${title}"]`);
      const box = (await section.boundingBox())!;
      // Select the set, so the row gutter is drawn too.
      await section.getByRole('gridcell').first().click();
      for (const label of await section.getByTestId('set-degree').all()) {
        const b = (await label.boundingBox())!;
        expect(b.x, `${title} ${(await label.textContent()) ?? ''}`).toBeGreaterThanOrEqual(box.x);
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width);
        // Never over the plain table to the left of E.
        // (The plain table's hairline border sits outside its footprint, over E's first pixel.)
        expect(b.x >= plainBox.x + plainBox.width - 1.5 || b.x + b.width <= plainBox.x).toBe(true);
      }
      await expect(section.getByTestId('set-degree').filter({ hasText: '+1°' })).toBeVisible();
    }
    // The first element still sits at its lattice address: A5 for the set at column A.
    await expect(
      page.getByRole('grid', { name: 'A' }).getByRole('row').nth(1).getByRole('gridcell').first(),
    ).toHaveAttribute('data-address', 'A5');
    await checkA11y('rail beside an abutting table');
  });

  test('RESP-02 SET-02 a Split into rows offer left open does not come back after the window passes through phone width', async ({
    page,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    seedSet(seeded, createSheet(seeded), 'E', 2, ['a', 'b']);
    await asDesktop(page, 1024, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'E' })).toBeVisible();
    await typeInto(page, 'E', 1, 0, 'b, c');
    const offer = page.getByRole('button', { name: 'Split into rows' });
    await expect(offer).toBeVisible();
    await asPhone(page, 480, 900);
    await expect(offer).toHaveCount(0);
    await asDesktop(page, 1024, 900);
    await expect(page.getByRole('grid', { name: 'E' })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(offer).toHaveCount(0);
    // Nothing was split: the value stays as typed (Enter on the last row added an empty one).
    const e = tableTitled(room, 'E')!;
    const table = openDocument(room.doc).tables.get(e.id)!;
    expect(e.rows.map((r) => cellText(table, r, e.columns[0]!.id))).toEqual(['a', 'b, c', '']);
  });

  test('SET-02 SET-05 after the offer has gone, Split into rows is still in the cell menu, and the counts read the comma value as the formulas do', async ({
    page,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    seedSet(seeded, createSheet(seeded), 'E', 2, ['a', 'b', 'z']);
    await asDesktop(page, 1440, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    const section = page.locator('section[aria-label="E"]');
    await expect(section.getByRole('grid', { name: 'E' })).toBeVisible();
    await typeInto(page, 'E', 1, 0, 'c, d, e');
    const offer = page.getByRole('button', { name: 'Split into rows' });
    await expect(offer).toBeVisible();
    await page.keyboard.press('F8');
    await page.keyboard.press('Escape');
    await expect(offer).toHaveCount(0);
    // Unsplit, the cell is three elements to Union(E) and to the footer alike.
    await expect(section.getByTestId('set-counts')).toContainText('|E| = 5');
    await expect(section.getByTestId('set-counts')).toContainText('bag 5');
    const cell = page
      .getByRole('grid', { name: 'E' })
      .getByRole('row')
      .nth(2)
      .getByRole('gridcell')
      .first();
    await cell.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Split into rows' }).click();
    await expect.poll(() => tableTitled(room, 'E')?.rows.length).toBe(5);
    await expect(section.getByTestId('set-counts')).toContainText('|E| = 5');
  });

  for (const width of [768, 1024] as const) {
    test(`SET-06 SET-07 at ${String(width)} px a family’s kind column and rail sit inside the table`, async ({
      page,
      checkA11y,
    }) => {
      const room = await installFakes(page);
      seedFamily(room);
      await asDesktop(page, width, 900);
      await signInTo(page, `/d/${DOC_ID}`);
      const section = page.locator('section[aria-label="T"]');
      await expect(section.getByRole('treegrid', { name: 'T' })).toBeVisible();
      await expect(section.getByTestId('set-kind')).toHaveText([
        'element',
        'set',
        'element',
        'element',
      ]);
      const box = (await section.boundingBox())!;
      for (const el of [
        ...(await section.getByTestId('set-kind').all()),
        ...(await section.getByTestId('set-degree').all()),
      ]) {
        const b = (await el.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(box.x);
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      }
      await checkA11y(`family ${String(width)}`);
    });
  }

  test('RESP-02 SET-06 at 480 px a family reads, with its kinds and degrees, and offers nothing to edit or split', async ({
    page,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    seedFamily(room);
    await asPhone(page, 480, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    const section = page.locator('section[aria-label="T"]');
    await expect(section.getByTestId('set-kind').first()).toBeVisible();
    await expect(section.getByTestId('set-kind')).toHaveText([
      'element',
      'set',
      'element',
      'element',
    ]);
    await expect(section.getByTestId('set-counts')).toContainText('|T| = 2');
    await expect(page.getByRole('button', { name: 'Split into rows' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add table' })).toHaveCount(0);
    await checkA11y('family 480');
  });
});

test.describe('Phase 4 at 200 % zoom', () => {
  test.use(zoomed200(1440));
  test('SET-03 SET-06 SET-07 A11Y-06 at 200 % zoom a family’s meta row, rail and kind column read and stay inside the table', async ({
    page,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    seedFamily(room);
    await signInTo(page, `/d/${DOC_ID}`);
    const section = page.locator('section[aria-label="T"]');
    await expect(section.getByTestId('set-kind').first()).toBeVisible();
    expect(await clippedFacts(page, section)).toEqual([]);
    const box = (await section.boundingBox())!;
    for (const el of await section.getByTestId('set-degree').all()) {
      const b = (await el.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(box.x);
    }
    await checkA11y('family 1440 200%');
  });
});

test.describe('Phase 4 second red-team regressions', () => {
  test('SET-02 KEYS-01 Split into rows from the cell menu keeps focus on the cell, withdraws the offer, and ⌘Z undoes it', async ({
    page,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    seedSet(seeded, createSheet(seeded), 'E', 2, ['a', 'b']);
    await asDesktop(page, 1440, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'E' })).toBeVisible();
    // The offer opens on the commit; the split is then made from the cell menu instead.
    await typeInto(page, 'E', 0, 0, 'x, y, z');
    const offer = page.getByRole('button', { name: 'Split into rows' });
    await expect(offer).toBeVisible();
    const cell = page
      .getByRole('grid', { name: 'E' })
      .getByRole('row')
      .nth(1)
      .getByRole('gridcell')
      .first();
    await cell.click();
    await expect(cell).toBeFocused();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Split into rows' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => tableTitled(room, 'E')?.rows.length).toBe(4);
    // The offer for a cell already split is gone, and the keyboard is still on the cell.
    await expect(offer).toHaveCount(0);
    await expect(cell).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'into 3 rows' })).toHaveCount(1);
    // The suite's UA is Windows: ⌘ is Control.
    await page.keyboard.press('Control+KeyZ');
    await expect.poll(() => tableTitled(room, 'E')?.rows.length).toBe(2);
    const e = tableTitled(room, 'E')!;
    const table = openDocument(room.doc).tables.get(e.id)!;
    expect(cellText(table, e.rows[0]!, e.columns[0]!.id)).toBe('x, y, z');
  });

  test('SET-02 the Split offer’s toast: pressing it once splits, and it closes', async ({
    page,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    seedSet(seeded, createSheet(seeded), 'E', 2, ['a', 'b']);
    await asDesktop(page, 1440, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('grid', { name: 'E' })).toBeVisible();
    await typeInto(page, 'E', 0, 0, 'p, q');
    const offer = page.getByRole('button', { name: 'Split into rows' });
    await offer.click();
    await expect.poll(() => tableTitled(room, 'E')?.rows.length).toBe(3);
    await expect(offer).toHaveCount(0);
  });

  for (const width of [1440, 1024, 768] as const) {
    test(`SET-06 at ${String(width)} px a one-column family: the kind column is a column of its own, the elements read whole`, async ({
      page,
      checkA11y,
    }) => {
      const room = await installFakes(page);
      const seeded = openDocument(room.doc);
      const sheetId = createSheet(seeded);
      const id = createTable(seeded, {
        sheetId,
        at: { col: 2, row: 1 },
        columns: 1,
        rows: 3,
        title: 'F',
        kind: 'family',
      });
      const record = tableRecord(seeded.tables.get(id)!);
      const [first, second, third] = record.rows;
      const range = record.columns[0]!.id;
      setCellText(seeded, id, first!, range, 'Alphabetical');
      setCellText(seeded, id, second!, range, 'beta');
      setCellText(seeded, id, third!, range, 'gamma');
      nestRow(seeded, id, second!);
      nestRow(seeded, id, third!);
      // A table abutting the family's kind column on the right is never drawn over.
      createTable(seeded, { sheetId, at: { col: 4, row: 1 }, columns: 1, rows: 1, title: 'Next' });
      await asDesktop(page, width, 900);
      await signInTo(page, `/d/${DOC_ID}`);
      const section = page.locator('section[aria-label="F"]');
      await expect(section.getByTestId('set-kind')).toHaveText(['set', 'element', 'element']);
      const tags = await section.locator('.gd-set-kind__tag').all();
      const cells = await section.getByRole('row').getByRole('gridcell').all();
      expect(cells).toHaveLength(3);
      for (const [i, cell] of cells.entries()) {
        // The whole text — not its clipped box — ends before the kind tag begins.
        const textRight = await cell.evaluate((el) => {
          const range = document.createRange();
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let right = 0;
          for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
            range.selectNodeContents(n);
            right = Math.max(right, range.getBoundingClientRect().right);
          }
          return right;
        });
        const tag = (await tags[i]!.boundingBox())!;
        expect(textRight, `row ${String(i)}`).toBeLessThanOrEqual(tag.x + 0.5);
        const box = (await cell.boundingBox())!;
        expect(textRight, `row ${String(i)} fits its cell`).toBeLessThanOrEqual(box.x + box.width);
      }
      // Every meta value reads (a value, never an empty pill), and the badge reads whole.
      expect(await clippedFacts(page, section)).toEqual([]);
      for (const shown of await section.locator('.gd-set-meta__shown').all()) {
        expect(((await shown.textContent()) ?? '').trim()).not.toBe('');
      }
      const badge = section.getByTestId('set-kind-badge');
      expect(await badge.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // The kind column stays inside the family; the next table is not drawn over.
      const familyBox = (await section.boundingBox())!;
      const nextBox = (await page.locator('section[aria-label="Next"]').boundingBox())!;
      for (const tag of tags) {
        const b = (await tag.boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(familyBox.x + familyBox.width + 0.5);
        expect(b.x + b.width).toBeLessThanOrEqual(nextBox.x + 0.5);
      }
      await checkA11y(`one-column family ${String(width)}`);
    });
  }

  test('SET-06 REF-01 a family row that references another set through @ holds that set’s elements, read-only, and follows it', async ({
    page,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    const seeded = openDocument(room.doc);
    const sheetId = createSheet(seeded);
    seedSet(seeded, sheetId, 'A', 7, ['p', 'q']);
    const family = seedSet(seeded, sheetId, 'T', 2, ['d', 'x']);
    seeded.tables.get(family)!.set('kind', 'family');
    await asDesktop(page, 1440, 900);
    await signInTo(page, `/d/${DOC_ID}`);
    const section = page.locator('section[aria-label="T"]');
    await expect(section.getByRole('grid', { name: 'T' })).toBeVisible();
    // REF-01: `@` in a plain cell opens the picker; the set A is offered whole, first, and
    // Enter picks it and commits the reference.
    await typeInto(page, 'T', 1, 0, '@A');
    await expect(section.getByTestId('set-kind')).toHaveText([
      'element',
      'set',
      'element',
      'element',
    ]);
    await expect(section.getByTestId('set-degree')).toContainText(['+2.1°', '+2.2°']);
    await expect(section.getByTestId('set-counts')).toContainText('|T| = 2');
    // A followed row is read-only: typing into it is refused, with the reason.
    const followed = section.getByRole('row').nth(4).getByRole('gridcell').first();
    await followed.click();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel(/^Edit /)).toHaveCount(0);
    // The source changes; the family follows.
    const a = tableTitled(room, 'A')!;
    setCellText(openDocument(room.doc), a.id, a.rows[1]!, a.columns[0]!.id, 'r');
    await expect
      .poll(() => {
        const t = tableTitled(room, 'T')!;
        const table = openDocument(room.doc).tables.get(t.id)!;
        return t.rows.map((r) => cellText(table, r, t.columns[0]!.id));
      })
      .toEqual(['d', '=@A', 'p', 'r']);
    await checkA11y('family with an @ reference');
  });
});
