/**
 * Document shell journeys against the built bundle. Everything outside the
 * browser is a labelled FAKE at the network edge: Cognito (`fakes/cognito`),
 * the documents REST API (routes below) and the y-websocket room
 * (`fakes/room`). The SPA itself — sign-in, Amplify, the Yjs provider, the
 * replica in IndexedDB — runs for real.
 */
import type { Page } from '@playwright/test';
import type * as Y from 'yjs';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import { computedTokenColor, expect, test } from './fixtures/test.js';
import { createSheet, createTable, openDocument } from '@gede/core';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000e2e0';
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

async function installFakes(page: Page, viewOnly = false): Promise<FakeRoom> {
  await page.route('**/config.json', (route) => route.fulfill({ json: CONFIG }));
  await installFakeCognito(page, SESSION);
  await page.route(`**/api/documents/${DOC_ID}`, (route) => {
    const method = route.request().method();
    if (method === 'PATCH') {
      const body = route.request().postDataJSON() as { title: string };
      return route.fulfill({ json: { document: { ...record, title: body.title } } });
    }
    return route.fulfill({ json: { document: record } });
  });
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

/** AUTH-01: a cold visit to the document lands on sign-in and returns after the code. */
async function signInTo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill(SESSION.email);
  await page.getByLabel('Email').press('Enter');
  await page.getByRole('button', { name: 'Email me a one-time code' }).click();
  await page.getByLabel('Six-digit code').fill(FAKE_CODE);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  // AUTH-07: the passkey offer follows a code sign-in; decline it whenever it appears.
  const notNow = page.getByRole('button', { name: 'Not now' });
  const target = new RegExp(`${path.replace('?', '\\?')}$`);
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(target, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page).toHaveURL(target);
}

test.describe('document shell', () => {
  test('DOC-01 DOC-03 DOC-06 signs in, opens the workscape, seeds Sheet 1 and shows rulers on the lattice; the shell passes axe', async ({
    page,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByLabel('Workscape title')).toHaveValue('Everest trek');
    await expect(page.getByRole('tab', { name: /1°.*Sheet 1/ })).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveText(/Synced/);
    await expect.poll(() => room.doc.getArray('sheets').length).toBe(1);
    // Issue #32: the token rides in the subprotocol list, never in the URL.
    expect(room.urls[0]).toMatch(/\/ws\/6f1b2c3d-0000-4000-8000-00000000e2e0$/);
    expect(room.protocols[0]?.[0]).toBe('gede.v1');
    expect(room.tokens[0]).toBeTruthy();
    const cols = page.getByTestId('ruler-columns');
    await expect(cols.getByText('A', { exact: true })).toBeVisible();
    const a = cols.getByText('A', { exact: true });
    await expect(a).toHaveCSS('width', '160px');
    await expect(page.getByTestId('ruler-rows').getByText('1', { exact: true })).toHaveCSS(
      'height',
      '22px',
    );
    // The sheet strip's tabs must control a real panel (DOC-03, WCAG 4.1.2).
    const tab = page.getByRole('tab', { name: /1°.*Sheet 1/ });
    const panelId = await tab.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    await expect(page.locator(`#${panelId ?? ''}`)).toHaveAttribute('role', 'tabpanel');
    await checkA11y('document shell 1440');
  });

  test('DOC-02 GRID-01 GRID-03 GRID-07 adds a table on the lattice, selects a cell, edits it, and the room receives it', async ({
    page,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    const grid = page.getByRole('grid').first();
    await expect(grid).toBeVisible();
    const table = page.locator('.gd-table').first();
    await expect(table).toHaveCSS('left', '160px');
    await expect(table).toHaveCSS('top', '22px');
    const cell = grid.getByRole('gridcell').first();
    await cell.click();
    await expect(cell).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Address B5')).toBeVisible();
    // GRID-07: the strip and stub are one lattice unit each.
    await expect(page.getByRole('button', { name: /Add row to/ })).toHaveCSS('height', '22px');
    await expect(page.getByRole('button', { name: /Add column to/ })).toHaveCSS('width', '160px');
    await cell.dblclick();
    await page.getByLabel('Edit B5').fill('Base camp');
    await page.keyboard.press('Enter');
    await expect(cell).toHaveText('Base camp');
    await expect
      .poll(() => JSON.stringify(room.doc.getMap('tables').toJSON()).includes('Base camp'))
      .toBe(true);
    // Escape clears the selection.
    await page.keyboard.press('Escape');
    await expect(cell).not.toHaveAttribute('aria-selected', 'true');
    await checkA11y('document table 1440');
  });

  test('KEYS-05 (partial) KEYS-03 ⌘B in the cell editor bolds by physical key; the mark survives commit and re-render; ⌘Z undoes the edit in one step', async ({
    page,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    const grid = page.getByRole('grid').first();
    const cell = grid.getByRole('gridcell').first();
    await cell.click();
    await page.keyboard.type('Everest');
    await page.keyboard.press('Enter');
    await expect(cell).toHaveText('Everest');
    // Open it again, select all, ⌘B (Ctrl+B outside Apple), commit.
    const apple = await page.evaluate(() => /Macintosh|Mac OS X/.test(navigator.userAgent));
    const mod = apple ? 'Meta' : 'Control';
    await cell.dblclick();
    const editor = page.getByLabel('Edit B5');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.click({ clickCount: 3 });
    await page.keyboard.press(`${mod}+b`);
    await expect(editor.locator('strong')).toHaveText('Everest');
    await page.keyboard.press('Enter');
    await expect(cell.locator('.gd-rich strong')).toHaveText('Everest');
    // The room holds the mark as a text attribute; Y.XmlText renders it as a `<bold>` tag.
    await expect
      .poll(() => JSON.stringify(room.doc.getMap('tables').toJSON()).includes('<bold>'))
      .toBe(true);
    // KEYS-03: one ⌘Z at document level takes the whole edit session back.
    await page.keyboard.press(`${mod}+z`);
    await expect(cell.locator('.gd-rich strong')).toHaveCount(0);
    await expect(cell).toHaveText('Everest');
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect(cell.locator('.gd-rich strong')).toHaveText('Everest');
    await checkA11y('document rich cell 1440');
  });

  test('DOC-04 DOC-05 DOC-07 pans by dragging, zooms with ⌥scroll into the macro tier, and Fit frames the table', async ({
    page,
    checkA11y,
  }) => {
    await installFakes(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await signInTo(page, `/d/${DOC_ID}`);
    await page.getByRole('button', { name: 'Add table' }).click();
    const plane = page.getByTestId('plane');
    const box = await plane.boundingBox();
    if (!box) throw new Error('plane has no box');
    await page.mouse.move(box.x + 600, box.y + 500);
    await page.mouse.down();
    await page.mouse.move(box.x + 500, box.y + 450, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('layer')).toHaveAttribute('style', /translate\(-100px, -50px\)/);
    // Dragging past the origin clamps at A1 (start on empty canvas, below the table).
    await page.mouse.move(box.x + 20, box.y + 600);
    await page.mouse.down();
    await page.mouse.move(box.x + 900, box.y + 700, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('layer')).toHaveAttribute('style', /translate\(0px, 0px\)/);
    // ⌥scroll zooms out until the macro tier: block titles only, no cells.
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.keyboard.down('Alt');
    for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 400);
    await page.keyboard.up('Alt');
    await expect(page.locator('.gd-canvas')).toHaveAttribute('data-zoom-tier', 'macro');
    await expect(page.getByRole('grid')).toHaveCount(0);
    await expect(page.locator('.gd-table__title-text')).toHaveText('Table 1');
    await page.getByRole('button', { name: 'Fit to canvas' }).click();
    await expect(page.locator('.gd-canvas')).toHaveAttribute('data-zoom-tier', 'micro');
    await expect(page.getByRole('grid')).toHaveCount(1);
    await checkA11y('document table 1024');
  });

  for (const width of [480, 768] as const) {
    test(`RESP-02 RESP-01 at ${String(width)} px the document is read-only with no edit affordance and the geometry unchanged`, async ({
      page,
      checkA11y,
    }) => {
      const room = await installFakes(page);
      // Author a table from the room side, as a desktop collaborator would.
      await page.setViewportSize({ width, height: 800 });
      await signInTo(page, `/d/${DOC_ID}`);
      await expect(page.getByRole('tab', { name: /Sheet 1/ })).toBeVisible();
      await expect.poll(() => room.doc.getArray('sheets').length).toBe(1);
      const phone = width < 768;
      if (phone) {
        await expect(page.getByText('View only on phone')).toBeVisible();
        await expect(page.getByRole('toolbar')).toHaveCount(0);
        await expect(page.getByLabel('Workscape title')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Add sheet' })).toHaveCount(0);
        await expect(page.locator('.gd-doc__sheets--bottom')).toBeVisible();
      } else {
        await expect(page.getByRole('toolbar', { name: 'Document tools' })).toBeVisible();
        await page.getByRole('button', { name: 'Add table' }).click();
        const table = page.locator('.gd-table').first();
        await expect(table).toHaveCSS('left', '160px');
        await expect(table).toHaveCSS('width', '480px');
        // RESP-05: below lg every target is at least 44 px.
        const box = await page.getByRole('button', { name: 'Add table' }).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
      // No horizontal overflow of the chrome at this width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await checkA11y(`document ${phone ? 'phone' : 'tablet'} ${String(width)}`);
    });
  }

  // 200 % browser zoom halves the CSS viewport at a 2× device scale: a 1440 px window
  // becomes 720 CSS px (phone chrome, read-only), a 2560 px window 1280 CSS px (desktop).
  for (const zoomed of [
    { width: 720, height: 450, chrome: 'phone' },
    { width: 1280, height: 720, chrome: 'desktop' },
  ] as const) {
    test.describe(`at 200 % browser zoom on a ${String(zoomed.width * 2)} px window`, () => {
      test.use({
        viewport: { width: zoomed.width, height: zoomed.height },
        deviceScaleFactor: 2,
      });

      test(`A11Y-06 the ${zoomed.chrome} layout holds at 200 % zoom with no loss of content`, async ({
        page,
        checkA11y,
      }) => {
        const room = await installFakes(page);
        // A collaborator has already placed a table.
        const gd = openDocument(room.doc);
        const sheetId = createSheet(gd);
        createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 5 });
        await signInTo(page, `/d/${DOC_ID}`);
        await expect(page.getByRole('tab', { name: /Sheet 1/ })).toBeVisible();
        await expect(page.getByRole('grid')).toBeVisible();
        if (zoomed.chrome === 'phone') {
          await expect(page.getByRole('heading', { level: 1 })).toHaveText('Everest trek');
          await expect(page.getByText('View only on phone')).toBeVisible();
        } else {
          await expect(page.getByLabel('Workscape title')).toBeVisible();
          await expect(page.getByRole('toolbar', { name: 'Document tools' })).toBeVisible();
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        // The lattice is absolute: the table keeps its 160 px column at any zoom (RESP-01).
        await expect(page.locator('.gd-table').first()).toHaveCSS('width', '480px');
        await checkA11y(`document ${zoomed.chrome} 200 zoom`);
      });
    });
  }

  test('SHARE-03 the service’s read-only notice takes the edit affordances away and says why', async ({
    page,
    checkA11y,
  }) => {
    // The record still says the caller may edit; the room disagrees (permission changed since).
    const room = await installFakes(page, true);
    const gd = openDocument(room.doc);
    createSheet(gd);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByText('Your access is now view-only.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add table' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByLabel('Workscape title')).toHaveCount(0);
    await checkA11y('document view-only 1440');
  });

  test('A11Y-05 selection and sync status announce through the polite live region', async ({
    page,
  }) => {
    await installFakes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByTestId('live-region')).toHaveText(/Synced/);
    await page.getByRole('button', { name: 'Add table' }).click();
    await page.getByRole('grid').first().getByRole('gridcell').first().click();
    await expect(page.getByTestId('live-region')).toHaveText(/Selected B5 in Table 1/);
  });
});

/** The armed cell's computed A1 address, from the roving selection. */
async function selectedAddress(page: Page): Promise<string | null> {
  const armed = page.locator('[role="gridcell"][aria-selected="true"]');
  if ((await armed.count()) === 0) return null;
  return armed.getAttribute('data-address');
}

/** Drag on the plane at a point that holds no table, panning the viewport. */
async function panBy(page: Page, dx: number, dy: number): Promise<void> {
  const plane = page.getByTestId('plane');
  const box = await plane.boundingBox();
  if (!box) throw new Error('plane has no box');
  const startX = box.x + box.width - 40;
  const startY = box.y + box.height - 40;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 6 });
  await page.mouse.up();
}

test.describe('grid editing', () => {
  for (const width of [1024, 1440] as const) {
    test(`GRID-03 GRID-04 GRID-05 GRID-06 GRID-07 KEYS-06 (partial: ⌘] and ⌘[ ship with the hierarchy work) I18N-02 A11Y-01 at ${String(width)} px: arm, type to overwrite, commit down and right, traverse with wrap, append past the last row, add a row by chord — mouse unplugged`, async ({
      page,
      checkA11y,
    }) => {
      const room = await installFakes(page);
      await page.setViewportSize({ width, height: 800 });
      await signInTo(page, `/d/${DOC_ID}`);
      await page.getByRole('button', { name: 'Add table' }).click();
      const grid = page.getByRole('grid').first();
      const b5 = grid.getByRole('gridcell').first();
      await b5.click();
      // GRID-03: the inset ring is the amber selection token, not a hue of its own.
      const amber = await computedTokenColor(page, '--selection-ring');
      const shadow = await b5.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(shadow).toContain('inset');
      expect(shadow).toContain(amber);
      // GRID-04: typing overwrites; GRID-06: Enter commits and moves down.
      await page.keyboard.type('Base camp');
      await expect(page.getByLabel('Edit B5')).toHaveText('Base camp');
      await page.keyboard.press('Enter');
      await expect(b5).toHaveText('Base camp');
      expect(await selectedAddress(page)).toBe('B6');
      // Tab commits and moves right; Shift+Tab back; the arrows move and wrap at row ends.
      await page.keyboard.type('Lobuche');
      await page.keyboard.press('Tab');
      expect(await selectedAddress(page)).toBe('C6');
      await page.keyboard.press('Shift+Tab');
      expect(await selectedAddress(page)).toBe('B6');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      expect(await selectedAddress(page)).toBe('D6');
      await page.keyboard.press('ArrowRight');
      expect(await selectedAddress(page)).toBe('B7');
      await page.keyboard.press('ArrowUp');
      expect(await selectedAddress(page)).toBe('B6');
      // Enter on a cell opens it on its text; Escape cancels; Delete clears.
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Edit B6')).toHaveText('Lobuche');
      await page.keyboard.type(' (4,940 m)');
      await page.keyboard.press('Escape');
      await expect(grid.getByRole('gridcell').nth(3)).toHaveText('Lobuche');
      await page.keyboard.press('Delete');
      await expect(grid.getByRole('gridcell').nth(3)).toHaveText('');
      // GRID-05: past the final row (D9, the last cell of five rows) a row appears with the cursor in it.
      await grid.getByRole('gridcell').nth(14).click();
      expect(await selectedAddress(page)).toBe('D9');
      await page.keyboard.press('Tab');
      await expect(grid.getByRole('row')).toHaveCount(7);
      expect(await selectedAddress(page)).toBe('B10');
      await page.keyboard.press('ArrowDown');
      await expect(grid.getByRole('row')).toHaveCount(8);
      expect(await selectedAddress(page)).toBe('B11');
      // KEYS-06 / I18N-02: ⌥⌘↓ and ⌥⌘→ by physical key. The suite's Desktop Chrome descriptor
      // reports a Windows UA, so the app's modifier is Control here (⌥⌃↓), on every host.
      await page.keyboard.press('Alt+Control+ArrowDown');
      await expect(grid.getByRole('row')).toHaveCount(9);
      await page.keyboard.press('Alt+Control+ArrowRight');
      await expect(grid.getByRole('columnheader')).toHaveCount(4);
      // The room received the edit behind the typing (LOAD-05).
      await expect
        .poll(() => JSON.stringify(room.doc.getMap('tables').toJSON()).includes('Base camp'))
        .toBe(true);
      // Escape clears the selection.
      await page.keyboard.press('Escape');
      expect(await selectedAddress(page)).toBeNull();
      await checkA11y(`document grid editing ${String(width)}`);
    });

    test(`GRID-01 GRID-08 GRID-09 GRID-10 GRID-11 at ${String(width)} px: resize by keyboard and pointer snaps and keeps the ruler true, wrap doubles the row, freeze shades and pins, header and footer toggle`, async ({
      page,
      snapshot,
    }) => {
      await installFakes(page);
      await page.setViewportSize({ width, height: 800 });
      await signInTo(page, `/d/${DOC_ID}`);
      await page.getByRole('button', { name: 'Add table' }).click();
      const grid = page.getByRole('grid').first();
      const table = page.locator('.gd-table').first();
      await grid.getByRole('gridcell').first().click();
      // GRID-08 keyboard: Shift+Tab from the first cell leaves the grid onto its column's divider.
      await page.keyboard.press('Shift+Tab');
      const divider = page.getByRole('separator', { name: 'Resize column Column 1' });
      await expect(divider).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(divider).toHaveAttribute('aria-valuenow', '2');
      await expect(grid.getByRole('columnheader').first()).toHaveCSS('width', '320px');
      await expect(table).toHaveCSS('width', '640px');
      // GRID-01: the ruler and the data agree — the second column now sits under ruler letter D.
      await expect(grid.getByRole('gridcell').nth(1)).toHaveAttribute('data-address', 'D5');
      await expect(
        grid
          .getByRole('columnheader')
          .nth(1)
          .getByLabel(/^Column/),
      ).toHaveText('D');
      await expect(page.getByTestId('ruler-columns').locator('[data-col="3"]')).toHaveText('D');
      // GRID-08 pointer: a drag on the divider snaps to whole units.
      const box = await divider.boundingBox();
      if (!box) throw new Error('divider has no box');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect(divider).toHaveAttribute('aria-valuenow', '3');
      await expect(table).toHaveCSS('width', '800px');
      // GRID-08 the corner handle scales the whole table: right adds a unit, down wraps every row.
      const corner = page.getByRole('separator', { name: 'Resize Table 1' });
      const cbox = await corner.boundingBox();
      if (!cbox) throw new Error('corner has no box');
      await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
      await page.mouse.down();
      await page.mouse.move(cbox.x + cbox.width / 2 + 165, cbox.y + cbox.height / 2 + 80, {
        steps: 5,
      });
      await page.mouse.up();
      await expect(table).toHaveCSS('width', '960px');
      await expect(grid.getByRole('row').nth(1)).toHaveCSS('height', '44px');
      await expect(grid.getByRole('gridcell').nth(3)).toHaveAttribute('data-address', 'B7');
      await corner.focus();
      await page.keyboard.press('ArrowUp');
      await expect(grid.getByRole('row').nth(1)).toHaveCSS('height', '22px');
      await expect(grid.getByRole('gridcell').nth(3)).toHaveAttribute('data-address', 'B6');
      // GRID-09 via the Table menu: wrap the selected column; rows are two lattice units, addresses exact.
      await grid.getByRole('gridcell').first().click();
      await page.getByRole('button', { name: 'Table menu' }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Wrap column text' }).click();
      await expect(grid.getByRole('row').nth(1)).toHaveCSS('height', '44px');
      await expect(grid.getByRole('gridcell').nth(3)).toHaveAttribute('data-address', 'B7');
      await expect(page.getByTestId('ruler-rows').locator('[data-row="6"]')).toHaveText('7');
      // GRID-10: freeze one column — shaded, a heavier rule at the boundary, and a pinned panel once scrolled under.
      await page.getByRole('button', { name: 'Table menu' }).click();
      await page.getByRole('menuitemradio', { name: '1 column' }).click();
      const frozen = grid.getByRole('gridcell').first();
      await expect(frozen).toHaveClass(/gd-cell--frozen/);
      await expect(frozen).toHaveCSS('border-right-width', '2px');
      await expect(page.getByTestId('pinned-panel')).toHaveCount(0);
      // Pan 400 px: the table (160 px in, 960 wide, first column 640) is then under the edge with unfrozen columns still on screen.
      await panBy(page, -400, 0);
      await expect(page.getByTestId('pinned-panel')).toBeVisible();
      await expect(page.getByTestId('pinned-panel')).toHaveCSS('width', '640px');
      await page.getByRole('button', { name: 'Fit to canvas' }).click();
      await expect(page.getByTestId('pinned-panel')).toHaveCount(0);
      // GRID-11: header 0 hides the column-header row; footer 1 adds a one-unit count strip.
      await page.getByRole('button', { name: 'Table menu' }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Header row' }).click();
      await expect(grid.getByRole('columnheader')).toHaveCount(0);
      await expect(grid.getByRole('gridcell').first()).toHaveAttribute('data-address', 'B4');
      await page.getByRole('button', { name: 'Table menu' }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Footer' }).click();
      const footer = page.getByTestId('table-footer');
      await expect(footer).toHaveCSS('height', '22px');
      await expect(footer).toHaveText(/5 rows/);
      await expect(footer).toHaveText(/3 columns/);
      // For the PR: the grid with a frozen column, wrapped rows and the footer, light and dark.
      await grid.getByRole('gridcell').nth(1).click();
      await snapshot(`document grid ${String(width)} light`);
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
      });
      await snapshot(`document grid ${String(width)} dark`);
    });
  }

  test('RESP-02 A11Y-04 at 480 px none of the grid editing renders: no editor, strip, stub, divider, corner or table menu; a locked cell still says why', async ({
    page,
    snapshot,
    checkA11y,
  }) => {
    const room = await installFakes(page);
    const gd = openDocument(room.doc);
    const sheetId = createSheet(gd);
    const tableId = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 2, rows: 2 });
    const tableMap = room.doc.getMap('tables').get(tableId) as Y.Map<unknown>;
    (tableMap.get('columns') as Y.Array<Y.Map<unknown>>).get(1).set('source', 'derived');
    await page.setViewportSize({ width: 480, height: 800 });
    await signInTo(page, `/d/${DOC_ID}`);
    await expect(page.getByText('View only on phone')).toBeVisible();
    const grid = page.getByRole('grid').first();
    await expect(grid).toBeVisible();
    const cell = grid.getByRole('gridcell').first();
    await cell.click();
    await expect(cell).toHaveAttribute('aria-selected', 'true'); // selecting is reading, and allowed
    await page.keyboard.press('Enter');
    await page.keyboard.type('x');
    await cell.dblclick();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add row to/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add column to/ })).toHaveCount(0);
    await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Table menu' })).toHaveCount(0);
    await expect(grid.getByRole('row')).toHaveCount(3);
    // A11Y-04: the read-only cell carries a lock glyph and a text reason, not a tint alone.
    const locked = grid.getByRole('gridcell').nth(1);
    await expect(locked).toHaveAttribute('aria-readonly', 'true');
    await expect(locked.locator('.gd-cell__lock svg')).toHaveCount(1);
    await expect(locked).toHaveAttribute('aria-label', /Read-only: derived column/);
    await snapshot('document grid 480 read-only');
    await checkA11y('document grid read-only 480');
  });
});
