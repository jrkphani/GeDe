/**
 * Wave 2 chrome journeys — the inspector rail (INSP-01..12, RESP-02..04,
 * FIND-06), the context menus (MENU-01..05) and the keyboard map (KEYS-01,
 * KEYS-08) — against the built bundle at 480, 768, 1024 and 1440 px, with axe
 * on every new surface. Everything outside the browser is a labelled FAKE at
 * the network edge: Cognito (`fakes/cognito`), the documents REST API
 * (routes below) and the y-websocket room (`fakes/room`).
 */
import { BREAKPOINTS, expect, test, zoomed200, type Breakpoint } from './fixtures/test.js';
import type { Page } from '@playwright/test';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import { createSheet, createTable, openDocument, setCellText, tableById } from '@gede/core';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000wav2';
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

// The Desktop Chrome profile reports a Windows UA, so `mod` is Control for the app's own chords
// (they resolve by code against the UA). The browser's built-in copy / paste accelerator is the
// host's: Meta on a macOS runner, Control elsewhere.
const mod = 'Control';
const hostMod = process.platform === 'darwin' ? 'Meta' : 'Control';

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
  // A collaborator has already authored a sheet with a small table.
  const gd = openDocument(room.doc);
  const sheet = createSheet(gd, { label: 'Trek' });
  const t1 = createTable(gd, { sheetId: sheet, at: { col: 1, row: 1 }, columns: 3, rows: 4 });
  const r1 = tableById(gd, t1)!;
  setCellText(gd, t1, r1.rows[0]!, r1.columns[0]!.id, 'Kathmandu');
  setCellText(gd, t1, r1.rows[1]!, r1.columns[0]!.id, 'Lukla');
  setCellText(gd, t1, r1.rows[2]!, r1.columns[1]!.id, '=Sum(B5:B6)');
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
  const notNow = page.getByRole('button', { name: 'Not now' });
  const target = new RegExp(`${path.replace('?', '\\?')}$`);
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(target, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page).toHaveURL(target);
}

async function openDoc(page: Page, width: Breakpoint, height = 900): Promise<FakeRoom> {
  const room = await installFakes(page);
  await page.setViewportSize({ width, height });
  await signInTo(page, `/d/${DOC_ID}`);
  await expect(page.getByRole('tab', { name: /Trek/ })).toBeVisible();
  await expect(page.getByRole('grid').first()).toBeVisible();
  return room;
}

const inspector = (page: Page) => page.getByTestId('inspector');

/** Wait for a surface's enter animation, so axe samples its final colours, not a blend. */
async function settled(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
}
const firstCell = (page: Page) => page.getByRole('grid').first().getByRole('gridcell').first();

test.describe('inspector rail', () => {
  test('INSP-02 RESP-04 at 1440 the rail starts docked at 322 px; collapse leaves a 38 px strip; expand restores it; the rail passes axe', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    await openDoc(page, 1440);
    const rail = inspector(page);
    await expect(rail).toHaveAttribute('data-state', 'open');
    await expect(rail).toHaveCSS('width', '322px');
    await firstCell(page).click();
    await expect(rail.getByLabel('Address B5')).toBeVisible();
    await checkA11y('inspector docked 1440');
    await snapshot('inspector-1440');
    // Light and dark: the same rail under the token swap (A11Y-03 pairs measured in contrast.test.ts).
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await settled(page, '[data-testid="inspector"]');
    await checkA11y('inspector docked 1440 dark');
    await snapshot('inspector-1440-dark');
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });
    await page.getByRole('button', { name: 'Collapse inspector' }).click();
    await expect(rail).toHaveAttribute('data-state', 'collapsed');
    await expect(rail).toHaveCSS('width', '38px');
    await expect(rail.getByRole('button', { name: 'Expand inspector' })).toBeVisible();
    await checkA11y('inspector strip 1440');
    await snapshot('inspector-strip-1440');
    // ⌥⌘I toggles it back (KEYS-07).
    await page.keyboard.press(`Alt+${mod}+KeyI`);
    await expect(rail).toHaveAttribute('data-state', 'open');
  });

  test('INSP-02 RESP-04 at 1024 the rail starts collapsed and docks at 322 px when opened; toolbars wrap, nothing clips', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    await openDoc(page, 1024, 768);
    const rail = inspector(page);
    await expect(rail).toHaveAttribute('data-state', 'collapsed');
    await page.getByRole('button', { name: 'Format inspector' }).click();
    await expect(rail).toHaveAttribute('data-state', 'open');
    await expect(rail).toHaveCSS('width', '322px');
    const canvas = await page.getByTestId('plane').boundingBox();
    expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(1024 - 322 + 1);
    await checkA11y('inspector docked 1024');
    await snapshot('inspector-1024');
  });

  test('RESP-03 at 768 the rail opens as an overlay over the canvas and can be collapsed to the strip', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    await openDoc(page, 768);
    const rail = inspector(page);
    await expect(rail).toHaveAttribute('data-state', 'collapsed');
    const before = await page.getByTestId('plane').boundingBox();
    await page.getByRole('button', { name: 'Format inspector' }).click();
    await expect(rail).toHaveAttribute('data-state', 'open');
    const after = await page.getByTestId('plane').boundingBox();
    // Overlay: the canvas keeps its width under the rail (RESP-01: nothing reflows).
    expect(after!.width).toBeCloseTo(before!.width, 0);
    await expect(rail).toHaveCSS('position', 'absolute');
    await checkA11y('inspector overlay 768');
    await snapshot('inspector-768');
    // An overlay dismisses like every layered surface: a press outside it, or Escape —
    // and that Escape does not also clear the selection (D7).
    await firstCell(page).click();
    await expect(rail).toHaveAttribute('data-state', 'collapsed');
    await expect(firstCell(page)).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Format inspector' }).click();
    await expect(rail).toHaveAttribute('data-state', 'open');
    await expect(rail.getByLabel('Address B5')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rail).toHaveAttribute('data-state', 'collapsed');
    await expect(firstCell(page)).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Format inspector' }).click();
    await expect(rail).toHaveAttribute('data-state', 'open');
    const plane = (await page.getByTestId('plane').boundingBox())!;
    await page.mouse.click(plane.x + 40, plane.y + plane.height - 60);
    await expect(rail).toHaveAttribute('data-state', 'collapsed');
  });

  test('SHARE-04 DOC-06 (#65) at 50 % the presence tag keeps its screen size and the row labels stay a label apart', async ({
    page,
  }) => {
    const room = await openDoc(page, 1440);
    const gd = openDocument(room.doc);
    const tableId = Array.from(gd.tables.keys())[0]!;
    const record = tableById(gd, tableId)!;
    room.announcePresence({
      userId: 'e2e-user-2',
      name: 'Shankar',
      colour: 2,
      sheetId: record.sheetId,
      cell: { tableId, rowId: record.rows[0]!, colId: record.columns[0]!.id },
    });
    const tag = page.locator('.gd-cell__presence-tag');
    await expect(tag).toHaveText('Shankar');
    const at100 = (await tag.boundingBox())!;
    expect(at100.height).toBeGreaterThanOrEqual(12);
    await page.getByRole('button', { name: /^Zoom \d+%/ }).click();
    await page.getByRole('menuitem', { name: '50%', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Zoom 50%' })).toBeVisible();
    const at50 = (await tag.boundingBox())!;
    expect(at50.height).toBeCloseTo(at100.height, 0);
    expect(at50.width).toBeCloseTo(at100.width, 0);
    // Ruler: every other row is labelled and the labels never come closer than 12 px.
    const rows = page.getByTestId('ruler-rows').locator('[data-labelled]');
    const boxes = await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    expect(boxes.length).toBeGreaterThan(2);
    for (let i = 1; i < boxes.length; i += 1)
      expect(boxes[i]! - boxes[i - 1]!).toBeGreaterThanOrEqual(12);
    await expect(page.getByTestId('ruler-rows').locator('[data-row="1"]')).toHaveText('');
    await expect(page.getByTestId('ruler-rows').locator('[data-row="2"]')).toHaveText('3');
  });

  test('RESP-02 at 480 there is no inspector, no strip, no context menu and no edit affordance', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    await openDoc(page, 480);
    await expect(inspector(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Format inspector' })).toHaveCount(0);
    await firstCell(page).click({ button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add row to/ })).toHaveCount(0);
    await expect(page.getByText('View only on phone')).toBeVisible();
    await checkA11y('document phone 480');
    await snapshot('document-480');
  });

  test('INSP-01 INSP-04 (partial) INSP-05 (partial) INSP-06 (partial) INSP-12 FMT-06 the tabs write through at once: header row off, a column format with its scope sentence, a whole-cell mark', async ({
    page,
    checkA11y,
  }) => {
    const room = await openDoc(page, 1440);
    await firstCell(page).click();
    const rail = inspector(page);
    await expect(rail.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true');
    await rail.getByRole('switch', { name: 'Header row' }).click();
    await expect
      .poll(() => JSON.stringify(room.doc.getMap('tables').toJSON()))
      .toContain('"headerRows":0');
    await rail.getByRole('tab', { name: 'Cell' }).click();
    const format = rail.getByRole('region', { name: 'data format' });
    await expect(format).toContainText('Formats Column 1 as Automatic for all 4 rows');
    await format.getByRole('combobox', { name: 'Format' }).click();
    await page.getByRole('option', { name: 'Number' }).click();
    await expect(format).toContainText('Formats Column 1 as Number for all 4 rows');
    await expect
      .poll(() => JSON.stringify(room.doc.getMap('tables').toJSON()))
      .toContain('"format":"number"');
    // FX-07: the formula section shows the projected expression and its ƒ badge.
    await page.getByRole('grid').first().getByRole('gridcell').nth(7).click();
    await expect(rail.getByTestId('inspector-formula')).toContainText('=Sum(B5:B6)');
    await settled(page, '[data-testid="inspector"]');
    await checkA11y('inspector cell tab 1440');
    await firstCell(page).click();
    await rail.getByRole('tab', { name: 'Text' }).click();
    await rail.getByRole('button', { name: 'Bold' }).click();
    await expect(firstCell(page).locator('.gd-rich strong')).toHaveText('Kathmandu');
    await expect(rail.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await checkA11y('inspector text tab 1440');
    // INSP-11: an unimplemented control is disabled with its reason.
    await rail.getByRole('tab', { name: 'Arrange' }).click();
    const front = rail.getByRole('button', { name: 'Front' });
    await expect(front).toHaveAttribute('aria-disabled', 'true');
    await expect(front).toHaveAttribute('title', /arrives with #85/);
    await checkA11y('inspector arrange tab 1440');
    await page.getByRole('button', { name: 'Organize inspector' }).click();
    await expect(rail.getByRole('tab', { name: 'Categories' })).toBeVisible();
    await checkA11y('inspector organize 1440');
  });

  test('FIND-06 with the rail open the result list lives in the inspector and follows the current match', async ({
    page,
  }) => {
    await openDoc(page, 1440);
    await page.keyboard.press(`${mod}+KeyF`);
    await page.getByRole('textbox', { name: 'Find' }).fill('Lukla');
    await expect(page.getByTestId('find-count')).toHaveText('1 of 1');
    await page
      .getByRole('search', { name: 'Find' })
      .getByRole('button', { name: /^Results/ })
      .click();
    const list = inspector(page).getByTestId('find-results');
    await expect(list.locator('[aria-current="true"]')).toContainText('B6 in Table 1');
  });
});

test.describe('context menus', () => {
  test('MENU-01 MENU-02 MENU-04 MENU-05 right-click on a cell opens its menu in order; a disabled command keeps its reason; Escape returns focus; the menu passes axe', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    const room = await openDoc(page, 1440);
    const cell = firstCell(page);
    await cell.click();
    await cell.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Cell menu' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Add row below/ })).toContainText('⌥⌘↓');
    const merge = menu.getByRole('menuitem', { name: 'Merge cells', exact: true });
    await expect(merge).toHaveAttribute('aria-disabled', 'true');
    await expect(merge).toHaveAttribute('title', 'arrives with #87 (merge controls)');
    await settled(page, '[role="menu"]');
    await checkA11y('cell context menu 1440');
    await snapshot('cell-menu-1440');
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await settled(page, '[role="menu"]');
    await checkA11y('cell context menu 1440 dark');
    await snapshot('cell-menu-1440-dark');
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(cell).toBeFocused();
    // Shift+F10 opens it from the keyboard; a command writes through to the room.
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Cell menu' })).toBeVisible();
    await page.getByRole('menuitem', { name: /^Add row below/ }).click();
    await expect(page.getByRole('grid').first().getByRole('row')).toHaveCount(6); // header + 5
    await expect
      .poll(
        () =>
          Object.values(room.doc.getMap('tables').toJSON() as Record<string, { rows: string[] }>)[0]
            ?.rows.length,
      )
      .toBe(5);
  });

  test('MENU-03 right-click on a column header opens the column menu; Hide column hides it', async ({
    page,
    checkA11y,
  }) => {
    await openDoc(page, 1440);
    const grid = page.getByRole('grid').first();
    await grid.getByRole('columnheader').nth(2).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Column menu' });
    await expect(menu).toBeVisible();
    // MENU-02: what no release has yet stays present, disabled, with its reason.
    await expect(menu.getByRole('menuitem', { name: 'Fit width to content' })).toHaveAttribute(
      'title',
      'arrives with #82 (table appearance)',
    );
    await settled(page, '[role="menu"]');
    await checkA11y('column context menu 1440');
    // SORT-01 (#74) through the column menu: Sort descending reorders the viewer's rows.
    await menu.getByRole('menuitem', { name: 'Sort descending' }).click();
    await expect(page.getByTestId('live-region')).toHaveText(/Sorted Column 3 Z–A/);
    await grid.getByRole('columnheader').nth(2).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide column' }).click();
    await expect(grid.getByRole('columnheader')).toHaveCount(2);
  });

  test.describe('touch', () => {
    test.use({ hasTouch: true });
    test('RESP-03 RESP-05 at 768 the menu opens on long-press and its items are 44 px targets', async ({
      page,
    }) => {
      await openDoc(page, 768);
      const cell = firstCell(page);
      const box = (await cell.boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
      });
      // The menu appears under the finger while it is still down (Radix's 700 ms). Headless
      // Chromium runs no animation frames while a CDP touch is held, and `expect` polls on
      // them, so the checks here are one-shot reads after the delay.
      await page.waitForTimeout(900);
      const menu = page.getByRole('menu', { name: 'Cell menu' });
      expect(await menu.count()).toBe(1);
      expect(await menu.isVisible()).toBe(true);
      const item = menu.getByRole('menuitem', { name: /^Add row below/ });
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      // Lifting the finger neither picks an item nor dismisses the menu.
      await page.waitForTimeout(150);
      await expect(menu).toBeVisible();
    });
  });
});

test.describe('keyboard map', () => {
  test('KEYS-01 KEYS-08 ? opens the shortcut sheet grouped as the reference; Esc closes it; the toolbar names the same chords', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    await openDoc(page, 1440);
    await page.keyboard.press('Shift+Slash');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    const groups = await sheet
      .getByRole('region')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    expect(groups).toEqual(['Document', 'Edit', 'Find', 'Format', 'Table and cells', 'View']);
    await expect(sheet.getByRole('region', { name: 'View' })).toContainText('⌥⌘I');
    // KEYS-02 / KEYS-07: the browser's own chords are listed and say so (ADR-030).
    await expect(sheet.getByRole('region', { name: 'Document' })).toContainText(
      'Close document — the browser’s in Chrome and Safari',
    );
    await settled(page, '[role="dialog"]');
    await checkA11y('shortcut sheet 1440');
    await snapshot('shortcut-sheet-1440');
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await settled(page, '[role="dialog"]');
    await checkA11y('shortcut sheet 1440 dark');
    await snapshot('shortcut-sheet-1440-dark');
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Shift+/',
    );
  });

  test.describe('clipboard, no permissions', () => {
    // ADR-028: the keyboard route is the browser's own copy / paste command and needs no
    // clipboard permission; the config grants them to every other test, so this one
    // revokes them to prove the chords never reach `navigator.clipboard.read`.
    test.use({ permissions: [] });
    test('KEYS-05 KEYS-03 ⌘B on a selected cell bolds the whole cell; ⌘C and ⌘V carry it, marks included, into the cell below with no clipboard permission', async ({
      page,
    }) => {
      await openDoc(page, 1440);
      const grid = page.getByRole('grid').first();
      const cell = firstCell(page);
      await cell.click();
      await page.keyboard.press(`${mod}+KeyB`);
      await expect(cell.locator('.gd-rich strong')).toHaveText('Kathmandu');
      await page.keyboard.press(`${hostMod}+KeyC`);
      await expect(page.getByTestId('live-region')).toHaveText('Copied B5');
      await grid.getByRole('gridcell').nth(6).click();
      await page.keyboard.press(`${hostMod}+KeyV`);
      await expect(grid.getByRole('gridcell').nth(6).locator('.gd-rich strong')).toHaveText(
        'Kathmandu',
      );
      await expect(page.getByTestId('live-region')).toHaveText('Pasted into B7');
    });
  });

  test('KEYS-03 ⌥⇧⌘V pastes the text without its marks — through the browser’s paste where it raises one for the chord, else the async read', async ({
    page,
  }) => {
    await openDoc(page, 1440);
    const grid = page.getByRole('grid').first();
    const cell = firstCell(page);
    await cell.click();
    await page.keyboard.press(`${mod}+KeyB`);
    await expect(cell.locator('.gd-rich strong')).toHaveText('Kathmandu');
    await page.keyboard.press(`${hostMod}+KeyC`);
    await expect(page.getByTestId('live-region')).toHaveText('Copied B5');
    await grid.getByRole('gridcell').nth(9).click();
    await page.keyboard.press(`Alt+Shift+${mod}+KeyV`);
    await expect(grid.getByRole('gridcell').nth(9)).toHaveText('Kathmandu');
    await expect(grid.getByRole('gridcell').nth(9).locator('.gd-rich strong')).toHaveCount(0);
    await expect(page.getByTestId('live-region')).toHaveText('Pasted plain text into B8');
  });
});

test.describe('200 % zoom', () => {
  // At 200 % every breakpoint's layout viewport is under 768 CSS px: the phone contract
  // holds (no rail, no menus), and the chrome must still fit without horizontal overflow.
  for (const width of BREAKPOINTS) {
    test.describe(`${String(width)} px`, () => {
      test.use(zoomed200(width));
      test(`A11Y-06 RESP-02 the document renders at 200 % zoom at ${String(width)} px without horizontal overflow`, async ({
        page,
        checkA11y,
      }) => {
        await installFakes(page);
        await signInTo(page, `/d/${DOC_ID}`);
        await expect(page.getByRole('tab', { name: /Trek/ })).toBeVisible();
        // WCAG 1.4.10 reflow holds from 320 CSS px; 480 at 200 % is 240 px, under the floor.
        if (width / 2 >= 320) {
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          );
          expect(overflow).toBe(false);
        }
        await expect(inspector(page)).toHaveCount(0);
        await checkA11y(`wave2 zoom200 ${String(width)}`);
      });
    });
  }
});
