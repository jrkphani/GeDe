/**
 * Find journeys (FIND-01..10, KEYS-04, A11Y-05) against the built bundle, at
 * 1024 and 1440 px. Everything outside the browser is a labelled FAKE at the
 * network edge: Cognito (`fakes/cognito`), the documents REST API (routes
 * below) and the y-websocket room (`fakes/room`). The SPA — the shell, the
 * shortcut map, the search Worker — runs for real.
 */
import { expect, test } from './fixtures/test.js';
import type { Page } from '@playwright/test';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import { createSheet, createTable, openDocument, setCellText, tableById } from '@gede/core';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000f1nd';
const OTHER_ID = '6f1b2c3d-0000-4000-8000-00000000d0c2';
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
const other = { ...record, id: OTHER_ID, title: 'Singapore budget' };

async function installFakes(page: Page): Promise<FakeRoom> {
  await page.route('**/config.json', (route) => route.fulfill({ json: CONFIG }));
  await installFakeCognito(page, SESSION);
  await page.route(`**/api/documents/${DOC_ID}`, (route) =>
    route.fulfill({ json: { document: record } }),
  );
  await page.route(`**/api/documents/${OTHER_ID}`, (route) =>
    route.fulfill({ json: { document: other } }),
  );
  await page.route(/\/api\/documents\?view=/, (route) =>
    route.fulfill({ json: { documents: [record, other] } }),
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
  // A collaborator has already authored two sheets; sheet 2's table is far from A1.
  const gd = openDocument(room.doc);
  const sheet1 = createSheet(gd, { label: 'Trek' });
  const sheet2 = createSheet(gd, { label: 'Budget' });
  const t1 = createTable(gd, { sheetId: sheet1, at: { col: 1, row: 1 }, columns: 2, rows: 3 });
  const r1 = tableById(gd, t1)!;
  setCellText(gd, t1, r1.rows[0]!, r1.columns[0]!.id, 'Singapore');
  setCellText(gd, t1, r1.rows[1]!, r1.columns[0]!.id, 'Mumbai');
  setCellText(gd, t1, r1.rows[2]!, r1.columns[1]!.id, 'Sngapore office');
  const t2 = createTable(gd, { sheetId: sheet2, at: { col: 20, row: 120 }, columns: 1, rows: 1 });
  const r2 = tableById(gd, t2)!;
  setCellText(gd, t2, r2.rows[0]!, r2.columns[0]!.id, 'Singapore budget');
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

async function openDoc(page: Page, width: 1024 | 1440): Promise<FakeRoom> {
  const room = await installFakes(page);
  await page.setViewportSize({ width, height: width === 1024 ? 768 : 900 });
  await signInTo(page, `/d/${DOC_ID}`);
  await expect(page.getByRole('tab', { name: /Trek/ })).toBeVisible();
  await expect(page.getByRole('grid').first()).toBeVisible();
  return room;
}

/** The suite's device profile (Desktop Chrome) reports a Windows UA, so `mod` resolves to Ctrl (I18N-02). */
const mod = 'Control';

for (const width of [1024, 1440] as const) {
  test.describe(`find at ${String(width)} px`, () => {
    test(`FIND-01 FIND-02 FIND-05 FIND-06 (partial: not in inspector) FIND-07 FIND-09 KEYS-04 A11Y-05 open, type, step, close at ${String(width)}`, async ({
      page,
      checkA11y,
      snapshot,
    }) => {
      await openDoc(page, width);
      // ⌘F opens the bar and focuses the field (the physical F key, by code).
      await page.keyboard.press(`${mod}+KeyF`);
      const bar = page.getByRole('search', { name: 'Find' });
      await expect(bar).toBeVisible();
      const field = page.getByRole('textbox', { name: 'Find' });
      await expect(field).toBeFocused();
      // The bar floats: the canvas plane keeps its full height beneath it.
      const plane = await page.getByTestId('plane').boundingBox();
      const barBox = await bar.boundingBox();
      expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(plane!.y + plane!.height + 1);
      expect(barBox!.y).toBeGreaterThan(plane!.y);
      for (const name of ['Find options', 'Previous match', 'Next match', 'Done']) {
        await expect(bar.getByRole('button', { name })).toBeVisible();
      }
      // Fuzzy by default: "Sngapore" finds Singapore, the office, the budget and the other workscape.
      await field.fill('Sngapore');
      await expect(page.getByTestId('find-count')).toHaveText('1 of 4');
      await expect(page.getByTestId('live-region')).toHaveText(/1 of 4/);
      // Highlights tint in place, the current one with the selection ring.
      const hits = page.locator('.gd-find-hit');
      await expect(hits).toHaveCount(2); // two on sheet 1
      await expect(hits.first()).toHaveClass(/gd-find-hit--current/);
      await expect(hits.first()).toHaveCSS('outline-width', '2px');
      await checkA11y(`find bar ${String(width)}`);
      await snapshot(`find bar ${String(width)}`);
      // Enter steps; ⌘G steps; the second hit ("Singapore" exact) is first, then sheet 2.
      await field.press('Enter');
      await expect(page.getByTestId('find-count')).toHaveText('2 of 4');
      await page.keyboard.press(`${mod}+KeyG`);
      await expect(page.getByTestId('find-count')).toHaveText('3 of 4');
      await expect(page.getByRole('tab', { name: /Budget/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      // The viewport moved to the far table and the cell is on screen.
      await expect(page.getByTestId('layer')).not.toHaveAttribute('style', /translate\(0px, 0px\)/);
      await expect(page.locator('.gd-find-hit--current')).toBeInViewport();
      await expect(page.getByTestId('live-region')).toHaveText(/3 of 4, U124 in Table 1/);
      await page.keyboard.press(`Shift+${mod}+KeyG`);
      await expect(page.getByTestId('find-count')).toHaveText('2 of 4');
      await expect(page.getByRole('tab', { name: /Trek/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      // The result list stays in sync with the bar.
      await bar.getByRole('button', { name: /^Results/ }).click();
      const list = page.getByTestId('find-results');
      await expect(list.locator('[aria-current="true"]')).toContainText('B5 in Table 1');
      // Esc closes and clears the highlighting; ⌘F brings the query back, selected.
      await page.keyboard.press('Escape');
      await expect(bar).toBeHidden();
      await expect(hits).toHaveCount(0);
      await page.keyboard.press(`${mod}+KeyF`);
      await expect(field).toHaveValue('Sngapore');
      await expect(field).toBeFocused();
      expect(
        await field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
      ).toEqual([0, 'Sngapore'.length]);
      // No matches: the counter says so and the bar stays put (FIND-10).
      await field.fill('zzzz');
      await expect(page.getByTestId('find-count')).toHaveText('No matches');
      await expect(page.getByTestId('live-region')).toHaveText(/No matches/);
      await expect(bar).toBeVisible();
    });

    test(`FIND-03 FIND-08 workscape names are their own group; Replace and All write through to the room at ${String(width)}`, async ({
      page,
    }) => {
      const room = await openDoc(page, width);
      await page.keyboard.press(`Alt+${mod}+KeyF`);
      const bar = page.getByRole('search', { name: 'Find' });
      await expect(bar.getByRole('textbox', { name: 'Replace with' })).toBeVisible();
      await page.getByRole('textbox', { name: 'Find' }).fill('Singapore');
      await expect(page.getByTestId('find-count')).toHaveText('1 of 4'); // 3 cells + 1 other workscape
      await bar.getByRole('button', { name: /^Results/ }).click();
      const list = page.getByTestId('find-results');
      await expect(list.getByRole('region', { name: 'Workscapes' }).getByRole('button')).toHaveText(
        /Singapore budget \(workscape\)/,
      );
      await bar.getByRole('button', { name: /^Results/ }).click();
      await page.getByRole('textbox', { name: 'Replace with' }).fill('Mumbai');
      await bar.getByRole('button', { name: 'Replace', exact: true }).click();
      await expect
        .poll(() => JSON.stringify(room.doc.getMap('tables').toJSON()).match(/>Mumbai</g)?.length)
        .toBe(2); // the existing Mumbai cell plus the rewritten one
      await expect(page.getByTestId('find-count')).toHaveText('1 of 3');
      await bar.getByRole('button', { name: 'All', exact: true }).click();
      await expect
        .poll(() => {
          const json = JSON.stringify(room.doc.getMap('tables').toJSON());
          return (
            json.includes('Mumbai budget') &&
            json.includes('Sngapore office') && // a fuzzy near miss is never rewritten (FIND-05 × FIND-08)
            !json.includes('Singapore')
          );
        })
        .toBe(true);
      // The workscape name is read-only; the near miss is left alone (both counted, FIND-08).
      await expect(page.getByTestId('find-skipped')).toHaveText(
        '1 near match left alone, 1 not editable',
      );
      // The near miss and the workscape name are left; neither is rewritten.
      await bar.getByRole('button', { name: /^Results/ }).click();
      await expect(list.getByRole('region', { name: 'Cells' }).getByRole('button')).toHaveText([
        /C7 in Table 1Sngapore office~1/,
      ]);
      await expect(list.getByRole('region', { name: 'Workscapes' }).getByRole('button')).toHaveText(
        [/Singapore budget \(workscape\)/],
      );
      await expect(page.getByTestId('find-count')).toHaveText('1 of 2');
      await expect(bar).toBeVisible();
    });
  });
}
