/**
 * Reference journeys against the built bundle (REF-01..REF-05, HIER-07,
 * A11Y-04, RESP-02). Same labelled FAKES at the network edge as
 * `formulas.spec.ts` (Cognito, the documents REST API, the y-websocket room);
 * the SPA, the Yjs replica, the formula Worker and the reconcilers run for
 * real. The inspector's Derive panel is composed by the integrator, so the
 * derived, pulled and mapping columns are bound on the collaborator's
 * replica (`room.doc`) with the same `@gede/core` mutations the panel calls,
 * and the grid is what is asserted.
 */
import type { Page } from '@playwright/test';
import {
  addDerivedColumn,
  addMappingColumn,
  openDocument,
  setPull,
  setRowWrapped,
  setTablePosition,
  tableRecord,
  type GedeDoc,
  type Id,
} from '@gede/core';
import { asPhone, expect, test } from './fixtures/test.js';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000e2e2';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-3',
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
  title: 'Trek references',
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

/** The first table the person added (`Table 1`) on the collaborator's replica. */
function tableTitled(
  gd: GedeDoc,
  title: string,
): { id: Id; rows: readonly Id[]; cols: readonly Id[] } {
  const found = [...gd.tables.values()]
    .map((map) => tableRecord(map))
    .find((r) => r.title === title);
  if (found === undefined) throw new Error(`${title} not found`);
  return { id: found.id, rows: found.rows, cols: found.columns.map((c) => c.id) };
}

for (const width of [1024, 1440]) {
  test(`REF-01 REF-02 REF-03 REF-04 REF-05 HIER-07 A11Y-04 at ${String(width)}: an @ pick becomes a live reference, a derived column recomputes under its lineage header, pulled rows mirror live and are read-only, a mapping cell picks from the target column`, async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    // Table 1 at B2: title rows 2–3, header row 4, data B5:D9.
    await enter(page, 'B5', 'Lukla (2860 m)');
    await enter(page, 'B6', 'Namche (3440 m)');
    await enter(page, 'C5', 'Nepal');
    await enter(page, 'C6', 'Nepal');
    await enter(page, 'B7', 'Leh (3500 m)');
    await enter(page, 'C7', 'India');

    // ── REF-01: `@` in a plain cell offers the entity index; the pick commits a reference.
    const d5 = page.locator('[data-address="D5"]');
    await d5.dblclick();
    const editor = page.getByLabel('Edit D5');
    await editor.pressSequentially('@Nam');
    const list = page.getByRole('listbox', { name: 'Entities' });
    await expect(list).toBeVisible();
    await expect(list).toContainText('@"Table 1"."Namche (3440 m)"');
    await page.keyboard.press('Enter');
    await expect(editor).toHaveCount(0);
    const reference = d5.getByTestId('reference-cell');
    await expect(reference.locator('.gd-ref__value')).toHaveText('Namche (3440 m)');
    await expect(reference.getByLabel(/^Reference, /)).toHaveText('@');
    await expect(reference).toHaveAttribute('title', '@"Table 1"."Namche (3440 m)"');
    // Stored as one entity-bound token (ADR-023), never the label.
    const tables = room.doc.getMap('tables').toJSON() as Record<
      string,
      { cells: Record<string, unknown> }
    >;
    const stored = Object.values(tables).flatMap((t) => Object.values(t.cells));
    expect(stored.some((v) => typeof v === 'string' && /^=\{e:[0-9A-Z:]+\}$/.test(v))).toBe(true);
    // Live: the referenced label changes, the reference follows and the path re-spells.
    await enter(page, 'B6', 'Namche Bazaar');
    await expect(reference.locator('.gd-ref__value')).toHaveText('Namche Bazaar');
    await expect(reference).toHaveAttribute('title', '@"Table 1"."Namche Bazaar"');

    // ── REF-04 / HIER-07: a derived column bound on the collaborator's replica.
    const gd = openDocument(room.doc);
    const t = tableTitled(gd, 'Table 1');
    addDerivedColumn(gd, t.id, {
      sourceColId: t.cols[0] ?? '',
      method: 'Extract',
      args: ['/\\(([^)]*)\\)/'],
    });
    // The derived column sits after its source: C is now the pipeline, D the old C.
    const header = page.getByRole('columnheader', { name: /@"Column 1"\.Extract/ });
    await expect(header).toBeVisible();
    const lineage = page.getByTestId('lineage-header');
    await expect(lineage).toContainText('derived pipeline ▸ 1 step');
    const c5 = page.locator('[data-address="C5"]');
    await expect(c5).toHaveAttribute('data-read-only', 'derived');
    await expect(c5.getByTestId('formula-cell').locator('.gd-formula__value')).toHaveText('2860 m');
    // Upstream change recomputes through the Worker.
    await enter(page, 'B5', 'Lukla (2900 m)');
    await expect(c5.getByTestId('formula-cell').locator('.gd-formula__value')).toHaveText('2900 m');
    // Typing into the derived cell is refused with the reason as text (REF-05, A11Y-04).
    await c5.click();
    await page.keyboard.type('x');
    await expect(page.getByLabel('Edit C5')).toHaveCount(0);
    await expect(page.getByTestId('live-region')).toContainText('read-only: derived column');

    // ── REF-03: a mapping column over the region column (now D).
    addMappingColumn(gd, t.id, { tableId: t.id, colId: t.cols[1] ?? '' });
    const mappingHeader = page.getByRole('columnheader', { name: /↔ Table 1 · Column 2/ });
    await expect(mappingHeader).toBeVisible();
    const f5 = page.locator('[data-address="F5"]');
    await expect(f5).toHaveAttribute('data-read-only', 'linked');
    // Keyboard: arm the cell from its neighbour, Enter opens the picker (a pointer press on the
    // trigger opens it too).
    await page.locator('[data-address="E5"]').click();
    await page.keyboard.press('ArrowRight');
    await expect(f5).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    const options = page.getByRole('listbox');
    await expect(options).toBeVisible();
    await expect(options.getByRole('option')).toHaveText(['India', 'Nepal']);
    await checkA11y(`mapping picker open at ${String(width)}`);
    await options.getByRole('option', { name: 'India' }).click();
    await expect(f5.getByRole('combobox')).toHaveText('India');
    await expect(page.getByTestId('live-region')).toContainText('F5 set to India');
    // Closing the list hands focus back to the grid's cell (not the trigger, and never
    // `body`: the `inert` the open list put on the page is gone before focus returns), so
    // Escape then ↓ moves the selection without reopening the picker (GRID-05, A11Y-01).
    await expect(f5).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(f5).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-address="F6"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.keyboard.press('ArrowUp');
    await expect(f5).toHaveAttribute('aria-selected', 'true');

    // ── REF-02: a second table pulls the Nepal rows; the receiving column renames itself.
    await page.getByRole('button', { name: 'Add table' }).click();
    await expect(page.getByRole('grid', { name: 'Table 2' })).toBeVisible();
    const second = tableTitled(gd, 'Table 2');
    // Well beneath Table 1 (which grows child rows later) and inside the 1024 viewport: the
    // canvas virtualises tables outside it, and a table beside Table 1 sits past 1024 px.
    setTablePosition(gd, second.id, { col: 1, row: 30 });
    setPull(gd, second.id, second.cols[0] ?? '', {
      tableId: t.id,
      colId: t.cols[0] ?? '',
      filter: 'nepal',
    });
    const table2 = page.getByRole('grid', { name: 'Table 2' });
    await expect(table2.getByRole('columnheader', { name: /↰ Table 1 · Column 1/ })).toBeVisible();
    const pulled = table2.getByTestId('pulled-cell');
    await expect(pulled).toHaveCount(2);
    await expect(pulled.first().locator('.gd-ref__value')).toHaveText('Lukla (2900 m)');
    await expect(pulled.first().getByLabel(/^Pulled, /)).toHaveText('↰');
    // A pulled row is read-only in every column (REF-05).
    const pulledCells = table2.getByRole('gridcell', {
      name: /Read-only: pulled from another table/,
    });
    // The receiving column in the five own rows, plus two pulled rows × three columns:
    // every cell of a pulled row says so.
    await expect(pulledCells).toHaveCount(5 + 6);
    await expect(pulledCells.first()).toHaveAttribute('aria-readonly', 'true');
    // Live: a source edit re-filters the mirror.
    await enter(page, 'D7', 'Nepal');
    await expect(pulled).toHaveCount(3);

    // ── Wrapped row: the reference path renders beneath the value (ADR-024).
    // (The reference cell moved from D5 to E5 when the derived column was inserted.)
    setRowWrapped(gd, t.id, t.rows[0] ?? '', true);
    await expect(page.locator('[data-address="E5"] .gd-ref__path')).toHaveText(
      '@"Table 1"."Namche Bazaar"',
    );

    // ── HIER-07: a Split() column materialises read-only child rows beneath each parent.
    addDerivedColumn(gd, t.id, { sourceColId: t.cols[0] ?? '', method: 'Split', args: [' '] });
    // With nested rows the table is a treegrid to assistive tech (ADR-025).
    const table1 = page.getByRole('treegrid', { name: 'Table 1' });
    const children = table1.locator('[data-read-only="splitChild"]');
    await expect(children.first()).toBeVisible();
    // "Lukla (2900 m)" splits into three pieces; the first child row (beneath the wrapped
    // parent, so row 7) holds "Lukla" in the Split column. The column's reason names the
    // derived column; every other cell of the child row names the split (A11Y-04).
    await expect(
      table1.getByRole('gridcell', { name: /^C7, Lukla, Read-only: derived column/ }),
    ).toBeVisible();
    await expect(
      table1.getByRole('gridcell', { name: /^B7, Read-only: split child row/ }),
    ).toBeVisible();

    // The pick made earlier survived two structural edits (the mapping column is G now).
    await expect(page.locator('[data-address="G5"]').getByRole('combobox')).toHaveText('India');

    await checkA11y(`references at ${String(width)}`);
    await snapshot(`references-${String(width)}`);
    // Dark: the same tokens, no state carried by hue alone (A11Y-04), and axe on the whole
    // page with every reference kind on screen.
    if (width === 1440) {
      await page.emulateMedia({ colorScheme: 'dark' });
      // The theme swap runs the tokens' colour transitions; axe samples computed colours,
      // so wait for every transition to finish before measuring contrast.
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      await expect(table1.getByTestId('reference-cell').locator('.gd-ref__value')).toHaveText(
        'Namche Bazaar',
      );
      await checkA11y(`references dark at ${String(width)}`);
      await snapshot(`references-dark-${String(width)}`);
    }
  });
}

test('INSP-09 the Derive tab lists the pipeline step by step with what each reads, its rows and its last recompute, following the selected derived cell (#127)', async ({
  page,
  checkA11y,
  snapshot,
}) => {
  const room = await installFakes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInTo(page, `/d/${DOC_ID}`);
  await page.getByRole('button', { name: 'Add table' }).click();
  await enter(page, 'B5', 'Lukla (2860 m)');
  await enter(page, 'B6', 'Namche (3440 m)');
  await enter(page, 'B7', 'Leh');
  const gd = openDocument(room.doc);
  const t = tableTitled(gd, 'Table 1');
  addDerivedColumn(gd, t.id, {
    sourceColId: t.cols[0] ?? '',
    method: 'Extract',
    args: ['/\\(([^)]*)\\)/'],
  });
  await expect(page.getByTestId('lineage-header')).toContainText('derived pipeline ▸ 1 step');
  // Select a derived cell: the audit list's step for its column is current.
  await page.locator('[data-address="C5"]').click();
  const rail = page.getByTestId('inspector');
  await rail.getByRole('tab', { name: 'Derive' }).click();
  const step = rail.getByRole('list', { name: 'Derived pipeline' }).getByTestId('pipeline-step');
  await expect(step).toHaveCount(1);
  await expect(step.first()).toHaveAttribute('aria-current', 'true');
  await expect(step.first()).toContainText('Step 1');
  await expect(step.first()).toContainText('@"Column 1".Extract(');
  await expect(step.first()).toContainText('from Column 1');
  // Two rows match the pattern; "Leh" and the empty rows yield nothing, which is not a row.
  await expect(step.first()).toContainText('2 rows');
  await expect(step.first()).toContainText(/recomputed \d{1,2}:\d{2}/);
  await expect(step.first().getByRole('button', { name: /^Edit / })).toBeEnabled();
  await expect(step.first().getByRole('button', { name: /^Remove / })).toBeEnabled();
  await checkA11y('derive pipeline audit 1440');
  await step.first().scrollIntoViewIfNeeded();
  await snapshot('derive-pipeline-1440');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await checkA11y('derive pipeline audit 1440 dark');
  await snapshot('derive-pipeline-1440-dark');
  // A cell in a plain column: no step is current.
  await page.locator('[data-address="B5"]').click();
  await expect(step.first()).not.toHaveAttribute('aria-current', 'true');
});

test('RESP-02 REF-03 on a phone a mapping cell shows its value and offers no picker', async ({
  page,
}) => {
  const room = await installFakes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInTo(page, `/d/${DOC_ID}`);
  await page.getByRole('button', { name: 'Add table' }).click();
  await enter(page, 'B5', 'Nepal');
  const gd = openDocument(room.doc);
  const t = tableTitled(gd, 'Table 1');
  addMappingColumn(gd, t.id, { tableId: t.id, colId: t.cols[0] ?? '' });
  await expect(page.getByRole('columnheader', { name: /↔ Table 1/ })).toBeVisible();
  await asPhone(page, 480, 900);
  const mapping = page.getByTestId('mapping-cell').first();
  await expect(mapping).toBeVisible();
  await expect(page.getByTestId('mapping-cell').getByRole('combobox')).toHaveCount(0);
});
