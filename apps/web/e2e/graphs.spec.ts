/**
 * Context graph journeys against the built bundle (GRAPH-01..11, INSP-08,
 * REF-05, A11Y-04, RESP-02). Same labelled FAKES at the network edge as
 * `references.spec.ts` (Cognito, the documents REST API, the y-websocket
 * room); the SPA, the Yjs replica and the formula Worker run for real. Axe
 * runs on the graph screens light and dark at 1024 and 1440, and at 480
 * where the pair is read-only.
 */
import type { Page } from '@playwright/test';
import {
  createShapedTableWithGraph,
  listSheets,
  openDocument,
  setCellText,
  tableRecord,
  type GedeDoc,
  type Id,
} from '@gede/core';
import { expect, test, zoomed200 } from './fixtures/test.js';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000e2e5';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-5',
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
  title: 'Trek contexts',
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

/** Region × Season × Grade through the grid: three complete contexts and one draft. */
async function fillTable(page: Page): Promise<void> {
  // Table 1 at B2: title rows 2–3, header row 4, data B5:D9.
  await enter(page, 'B5', 'Nepal');
  await enter(page, 'C5', 'Spring');
  await enter(page, 'D5', 'Easy');
  await enter(page, 'B6', 'India');
  await enter(page, 'C6', 'Spring');
  await enter(page, 'D6', 'Hard');
  await enter(page, 'B7', 'Nepal');
  await enter(page, 'C7', 'Autumn');
  await enter(page, 'D7', 'Hard');
  await enter(page, 'B8', 'Bhutan');
}

for (const width of [1024, 1440] as const) {
  test(`GRAPH-01 GRAPH-02 GRAPH-03 GRAPH-05 GRAPH-06 GRAPH-07 GRAPH-08 GRAPH-09 GRAPH-10 GRAPH-11 INSP-08 REF-05 A11Y-04 at ${String(width)}: + Graph points, binds a pair, derives live, emphasises across the pair, writes back, moves on the lattice`, async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    await fillTable(page);

    // ── GRAPH-03: pointing mode — dashed accent targets, a banner, Escape cancels.
    await page.getByRole('button', { name: 'Add graph' }).click();
    await expect(page.getByText('Click a table to bind the graph.')).toBeVisible();
    const target = page.getByRole('button', { name: 'Bind the graph to Table 1' });
    await expect(target).toBeVisible();
    await checkA11y(`graph pointing at ${String(width)}`);
    await page.keyboard.press('Escape');
    await expect(target).toHaveCount(0);
    await expect(page.getByText('Click a table to bind the graph.')).toHaveCount(0);

    // ── GRAPH-01 / GRAPH-02: the click binds a ring and coverage pair below the table.
    await page.getByRole('button', { name: 'Add graph' }).click();
    await page.getByRole('button', { name: 'Bind the graph to Table 1' }).click();
    const ring = page.getByRole('region', { name: 'Ring graph of Table 1' });
    const coverage = page.getByRole('region', { name: 'Coverage graph of Table 1' });
    await expect(ring).toBeVisible();
    await expect(coverage).toBeVisible();
    const graphs = room.doc.getMap('graphs').toJSON() as Record<
      string,
      { kind: string; pairId: string; tableId: string; gridCol: number; gridRow: number }
    >;
    const halves = Object.values(graphs);
    expect(halves.map((g) => g.kind).sort()).toEqual(['coverage', 'ring']);
    expect(new Set(halves.map((g) => g.pairId)).size).toBe(1);
    expect(halves.every((g) => g.gridRow === halves[0]?.gridRow)).toBe(true);

    // ── GRAPH-06 / GRAPH-07: symbols in row order, a draft is hollow and dashed, the header counts tuples.
    await expect(ring.getByTestId('graph-dimensions')).toHaveText('Column 1 · Column 2 · Column 3');
    await expect(ring.getByTestId('graph-stat')).toHaveText('3 / 12');
    const nodes = page.getByTestId('ring-graph').getByRole('button', { name: /^Context / });
    await expect(nodes).toHaveText(['α', 'β', 'γ', 'δ']);
    const draft = page.getByTestId('ring-graph').getByRole('button', { name: /^Context δ/ });
    await expect(draft).toHaveAttribute('data-complete', 'false');
    await expect(draft.locator('circle')).toHaveCSS('stroke-dasharray', /3/);
    await expect(page.getByTestId('ring-graph').locator('.gd-ring__arc')).toHaveCount(3);

    // ── INSP-08 / GRAPH-05: the Graph tab with the checklist, counts, axes, pins and counts.
    // Below 1200 px the rail starts collapsed (INSP-02) and opens as an overlay (RESP-03).
    const openInspector = async () => {
      const rail = page.getByTestId('inspector');
      if ((await rail.getAttribute('data-state')) !== 'open') {
        await page.getByRole('button', { name: 'Format inspector' }).click();
        await expect(rail).toHaveAttribute('data-state', 'open');
      }
    };
    await openInspector();
    await page.getByRole('tab', { name: 'Graph' }).click();
    const checklist = page.getByTestId('dimension-checklist');
    await expect(checklist.getByText('3 values')).toBeVisible(); // Nepal, India, Bhutan
    await expect(page.getByTestId('graph-contexts')).toHaveText(
      '4 contexts · 3 distinct tuples covered of 12 · 1 draft',
    );
    await checkA11y(`graph inspector at ${String(width)}`);
    // The pin control, while the tab is open: an explicit pin (GRAPH-08).
    const axes = coverage.getByTestId('coverage-axes');
    await expect(axes).toHaveText('rows Column 1 · columns Column 2 · pinned Column 3: Easy');
    await page.getByRole('combobox', { name: /Pin Column 3/ }).click();
    await page.getByRole('option', { name: 'Hard' }).click();
    await expect(axes).toHaveText('rows Column 1 · columns Column 2 · pinned Column 3: Hard');
    await page.getByRole('combobox', { name: /Pin Column 3/ }).click();
    await page.getByRole('option', { name: 'Easy' }).click();
    await expect(axes).toHaveText('rows Column 1 · columns Column 2 · pinned Column 3: Easy');
    if (width < 1200) await page.keyboard.press('Escape');

    // ── GRAPH-08: with no explicit pin the slice follows the selected context. Clear the
    // stored pin by re-pointing? No — a fresh pair below shows the default: use a second pair.
    // (The stored pin above stays explicit; the selection default is covered by the unit tests.)
    await page
      .getByTestId('ring-graph')
      .getByRole('button', { name: 'Context β: India · Spring · Hard, complete' })
      .click();
    // GRAPH-10: the click selected the source row.
    await expect(page.locator('[data-address="B6"]')).toHaveAttribute('aria-selected', 'true');

    // ── GRAPH-09: hover mutes what is not adjacent across the pair, draws spokes, lights the row.
    const alpha = page
      .getByTestId('ring-graph')
      .getByRole('button', { name: 'Context α: Nepal · Spring · Easy, complete' });
    await alpha.hover();
    await expect(page.getByTestId('ring-spoke')).toHaveCount(3);
    await expect(page.locator('.gd-table__row--lit')).toHaveCount(1);
    await expect(page.locator('.gd-table__row--lit [data-address="B5"]')).toHaveCount(1);
    await expect(
      page.getByTestId('ring-graph').getByRole('button', { name: /^Context β/ }),
    ).toHaveClass(/gd-ring__node--muted/);
    await snapshot(`graph-hover-${String(width)}`);
    await checkA11y(`graph hover at ${String(width)}`);
    await page.mouse.move(0, 0);
    await expect(page.locator('.gd-table__row--lit')).toHaveCount(0);

    // ── GRAPH-10: an empty coverage cell appends a row pre-filled with its tuple, pins included.
    await page
      .getByTestId('coverage-graph')
      .getByRole('button', { name: 'Unexplored: India · Autumn · Easy. Add a row' })
      .click();
    await expect(page.locator('[data-address="B10"]')).toHaveText('India');
    await expect(page.locator('[data-address="C10"]')).toHaveText('Autumn');
    await expect(page.locator('[data-address="D10"]')).toHaveText('Easy');
    await expect(ring.getByTestId('graph-stat')).toHaveText('4 / 12');
    const gd = openDocument(room.doc);
    const t = tableTitled(gd, 'Table 1');
    expect(t.rows.length).toBe(6);

    // ── GRAPH-11: the corner resizes and the header moves, snapped to the lattice.
    const header = ring.getByRole('button', { name: /^Move Ring graph/ });
    const hb = await header.boundingBox();
    if (hb === null) throw new Error('header box');
    const hx = hb.x + hb.width / 2;
    const hy = hb.y + hb.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx + 40, hy + 10, { steps: 4 });
    await page.mouse.move(hx + 160 * 2 + 20, hy + 22 * 3 - 5, { steps: 6 });
    await page.mouse.up();
    const moved = Object.values(
      room.doc.getMap('graphs').toJSON() as Record<
        string,
        { kind: string; gridCol: number; gridRow: number }
      >,
    ).find((g) => g.kind === 'ring');
    expect(moved?.gridCol).toBe((halves.find((g) => g.kind === 'ring')?.gridCol ?? 0) + 2);
    expect(moved?.gridRow).toBe((halves.find((g) => g.kind === 'ring')?.gridRow ?? 0) + 3);
    await expect(ring).toHaveCSS('left', `${String((moved?.gridCol ?? 0) * 160)}px`);
    // Keyboard on the corner: one unit a press (GRAPH-11, A11Y-01).
    const corner = ring.getByRole('separator', { name: /^Resize Ring graph/ });
    await corner.focus();
    await page.keyboard.press('ArrowRight');
    await expect(corner).toHaveAttribute('aria-valuetext', '7 by 28 units');

    // ── Keyboard inside the ring: Tab reaches one stop, arrows move between nodes, Enter selects.
    await page
      .getByTestId('ring-graph')
      .getByRole('button', { name: /^Context α/ })
      .focus();
    await page.keyboard.press('ArrowRight');
    await expect(
      page.getByTestId('ring-graph').getByRole('button', { name: /^Context β/ }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-address="B6"]')).toHaveAttribute('aria-selected', 'true');

    // ── REF-05: a derived column is listed disabled with its reason.
    const { addDerivedColumn } = await import('@gede/core');
    addDerivedColumn(gd, t.id, { sourceColId: t.cols[0] ?? '', method: 'Extract', args: ['/a/'] });
    await ring.getByRole('button', { name: /^Move Ring graph/ }).click();
    await openInspector();
    await page.getByRole('tab', { name: 'Graph' }).click();
    await expect(checklist.getByText('derived column')).toBeVisible();
    await expect(checklist.getByLabel(/Extract/)).toBeDisabled();

    await checkA11y(`graph screen at ${String(width)}`);
    await snapshot(`graph-${String(width)}`);
    // Dark: the same tokens; every state also carried by shape or text (A11Y-04).
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await expect(draft).toHaveAttribute('data-complete', 'false');
    await checkA11y(`graph screen dark at ${String(width)}`);
    await snapshot(`graph-dark-${String(width)}`);
  });
}

test('GRAPH-04 GRAPH-10 "Add shaped table" binds a pair in one step; Shift+Enter on a node opens a child sheet named after the symbol', async ({
  page,
}) => {
  const room = await installFakes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInTo(page, `/d/${DOC_ID}`);
  await page.getByRole('button', { name: 'Add shaped table here' }).click();
  await expect(page.getByRole('columnheader', { name: /Dimension A/ })).toBeVisible();
  const ring = page.getByRole('region', { name: 'Ring graph of Contexts 1' });
  await expect(ring).toBeVisible();
  await expect(ring.getByTestId('graph-dimensions')).toHaveText(
    'Dimension A · Dimension B · Dimension C',
  );
  // One context typed in through the shaped table.
  const gd = openDocument(room.doc);
  const t = tableTitled(gd, 'Contexts 1');
  setCellText(gd, t.id, t.rows[0] ?? '', t.cols[0] ?? '', 'Base camp');
  const node = page.getByTestId('ring-graph').getByRole('button', { name: /^Context α/ });
  await expect(node).toBeVisible();
  await node.focus();
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByRole('tab', { name: /α/, selected: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Dimension A/ })).toBeVisible();
  await expect(page.getByText('Children of α')).toBeVisible();
  const sheets = room.doc.getArray('sheets').toJSON() as { label: string; parentContext: string }[];
  expect(sheets[1]?.label).toBe('α');
  expect(sheets[1]?.parentContext).toContain('α');
});

test('RESP-02 GRAPH-01 at 480 the pair renders read-only: no drag, no corner, no pointing, no write-back', async ({
  page,
  checkA11y,
  snapshot,
}) => {
  const room = await installFakes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInTo(page, `/d/${DOC_ID}`);
  await page.getByRole('button', { name: 'Add table' }).click();
  await enter(page, 'B5', 'Nepal');
  await enter(page, 'C5', 'Spring');
  await enter(page, 'B6', 'India');
  await page.getByRole('button', { name: 'Add graph' }).click();
  await page.getByRole('button', { name: 'Bind the graph to Table 1' }).click();
  await expect(page.getByTestId('ring-graph')).toBeVisible();
  await page.setViewportSize({ width: 480, height: 900 });
  await expect(page.getByText('View only on phone')).toBeVisible();
  await expect(page.getByTestId('ring-graph')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Move Ring graph/ })).toHaveCount(0);
  await expect(page.getByRole('separator', { name: /^Resize/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add graph' })).toHaveCount(0);
  const empty = page
    .getByTestId('coverage-graph')
    .getByRole('button', { name: /^Unexplored/ })
    .first();
  await expect(empty).toHaveAttribute('aria-disabled', 'true');
  const rowsBefore = room.doc.getMap('tables').toJSON() as Record<string, { rows: string[] }>;
  const count = Object.values(rowsBefore)[0]?.rows.length ?? 0;
  await empty.click({ force: true });
  await page.waitForTimeout(200);
  const rowsAfter = room.doc.getMap('tables').toJSON() as Record<string, { rows: string[] }>;
  expect(Object.values(rowsAfter)[0]?.rows.length).toBe(count);
  await checkA11y('graph phone at 480');
  await snapshot('graph-480');
});

test('GRAPH-01 GRAPH-11 RESP-03 at 768 the pair renders editable on its lattice', async ({
  page,
  checkA11y,
  snapshot,
}) => {
  await installFakes(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await signInTo(page, `/d/${DOC_ID}`);
  await page.getByRole('button', { name: 'Add shaped table here' }).click();
  const ring = page.getByRole('region', { name: 'Ring graph of Contexts 1' });
  await expect(ring).toBeVisible();
  await expect(ring.getByRole('button', { name: /^Move Ring graph/ })).toBeVisible();
  await expect(ring).toHaveCSS('width', '960px');
  await checkA11y('graph tablet at 768');
  await snapshot('graph-768');
});

test.describe('200 % zoom', () => {
  test.use(zoomed200(1440));
  test('A11Y-06 GRAPH-01 at 200 % zoom the pair still sits on its lattice and reads', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    // 1440 at 200 % is a 720 px layout viewport: the phone contract holds (RESP-02), so the
    // pair is made on the collaborator's replica and arrives over the socket, read-only here.
    const room = await installFakes(page);
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByRole('tab', { name: /Sheet 1/ })).toBeVisible();
    const gd = openDocument(room.doc);
    const sheetId = listSheets(gd)[0]?.id ?? '';
    const made = createShapedTableWithGraph(gd, { sheetId, at: { col: 1, row: 1 } });
    const t = tableTitled(gd, 'Contexts 1');
    setCellText(gd, made.tableId, t.rows[0] ?? '', t.cols[0] ?? '', 'Base camp');
    const ring = page.getByRole('region', { name: 'Ring graph of Contexts 1' });
    await expect(ring).toBeVisible();
    await expect(
      page.getByTestId('ring-graph').getByRole('button', { name: /^Context α/ }),
    ).toBeVisible();
    await expect(ring.getByRole('button', { name: /^Move Ring graph/ })).toHaveCount(0);
    await checkA11y('graph zoom200 1440');
    await snapshot('graph-zoom200-1440');
  });
});
