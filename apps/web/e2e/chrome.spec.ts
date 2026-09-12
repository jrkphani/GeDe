/**
 * Document chrome at every width, zoom and theme: the title row fits (#124),
 * every secondary target is 44 px below lg (#135), and the phone contract
 * follows the pointer, not the width alone (#137, ADR-039). Fakes as in
 * document.spec.ts: Cognito, the documents REST API and the y-websocket room
 * are labelled fakes at the network edge; the SPA runs for real.
 */
import type { Page } from '@playwright/test';
import { createSheet, createTable, openDocument } from '@gede/core';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import {
  asDesktop,
  asPhone,
  BREAKPOINTS,
  expect,
  expectNoHorizontalOverflow,
  test,
  zoomed200,
} from './fixtures/test.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000c4e0';
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
/** The audit's repro: the guided sample's 27-character title (#124). */
const LONG_TITLE = 'Q3 Delivery — Guided sample';

async function installFakes(page: Page, title = LONG_TITLE): Promise<FakeRoom> {
  const record = {
    id: DOC_ID,
    title,
    ownerId: SESSION.sub,
    permission: 'owner',
    linkAccess: 'none',
    sharedWithOthers: true,
    updatedAt: '2026-09-12T00:00:00.000Z',
    deletedAt: null,
  };
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
  const room = new FakeRoom();
  await room.install(page);
  // A collaborator has already placed a table, so the header ▼ and dividers exist.
  const gd = openDocument(room.doc);
  const sheetId = createSheet(gd);
  createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 4 });
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
  await expect(page.getByRole('tab', { name: /Sheet 1/ })).toBeVisible();
  await expect(page.getByRole('grid')).toBeVisible();
}

/** The title row fits: the note is whole, the title truncates, nothing scrolls sideways. */
async function expectTitleRowFits(page: Page, phone: boolean): Promise<void> {
  await expectNoHorizontalOverflow(page);
  const viewport = page.viewportSize()!;
  const bar = page.locator('.gd-doc__titlebar');
  const barBox = (await bar.boundingBox())!;
  expect(barBox.x + barBox.width, 'the title row fits the viewport').toBeLessThanOrEqual(
    viewport.width + 0.5,
  );
  if (phone) {
    const note = page.getByText('View only on phone');
    await expect(note).toBeVisible();
    const box = (await note.boundingBox())!;
    expect(box.x + box.width, 'the read-only note is whole').toBeLessThanOrEqual(viewport.width);
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveText(LONG_TITLE);
    const clipped = await h1.evaluate((el) => ({
      ellipsis: getComputedStyle(el).textOverflow,
      truncated: el.scrollWidth > el.clientWidth,
      right: el.getBoundingClientRect().right,
    }));
    expect(clipped.ellipsis).toBe('ellipsis');
    expect(clipped.right).toBeLessThanOrEqual(viewport.width);
    await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
  } else {
    const title = page.getByLabel('Workscape title');
    await expect(title).toHaveValue(LONG_TITLE);
    const box = (await title.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    await expect(page.getByRole('toolbar', { name: 'Document tools' })).toBeVisible();
  }
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`title row, ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    for (const width of [320, ...BREAKPOINTS] as const) {
      const phone = width < 768;
      test(`DOC-01 RESP-02 A11Y-06 at ${String(width)} px a 27-character title fits the ${phone ? 'phone' : 'editable'} title row without sideways scroll (#124)`, async ({
        page,
        checkA11y,
        snapshot,
      }) => {
        await installFakes(page);
        await (phone ? asPhone(page, width) : asDesktop(page, width));
        await signInTo(page, `/d/${DOC_ID}`);
        await expectTitleRowFits(page, phone);
        await snapshot(`chrome title ${String(width)} ${scheme}`);
        await checkA11y(`chrome title ${String(width)} ${scheme}`);
      });
    }

    for (const width of BREAKPOINTS) {
      // A phone at 200 %: 240 / 384 / 512 / 720 CSS px with a coarse pointer (the audit's
      // failing cases). WCAG 1.4.10 reflow holds from 320 px; 240 is under the floor.
      test.describe(`${String(width)} px at 200 % zoom, touch`, () => {
        test.use({ ...zoomed200(width), hasTouch: true });
        test(`A11Y-06 RESP-02 the phone title row holds at 200 % zoom on ${String(width)} px (#124)`, async ({
          page,
          checkA11y,
        }) => {
          await installFakes(page);
          await signInTo(page, `/d/${DOC_ID}`);
          if (width / 2 >= 320) await expectTitleRowFits(page, true);
          else await expect(page.getByText('View only on phone')).toBeVisible();
          await checkA11y(`chrome title zoom200 touch ${String(width)} ${scheme}`);
        });
      });
      // A desktop at 200 %: the same CSS widths with a mouse stay editable (ADR-039).
      test.describe(`${String(width)} px at 200 % zoom, mouse`, () => {
        test.use(zoomed200(width));
        test(`A11Y-06 RESP-03 the editable title row holds at 200 % zoom on ${String(width)} px (#137)`, async ({
          page,
          checkA11y,
        }) => {
          await installFakes(page);
          await signInTo(page, `/d/${DOC_ID}`);
          await expect(page.getByText('View only on phone')).toHaveCount(0);
          if (width / 2 >= 320) await expectTitleRowFits(page, false);
          else await expect(page.getByLabel('Workscape title')).toHaveValue(LONG_TITLE);
          await checkA11y(`chrome title zoom200 mouse ${String(width)} ${scheme}`);
        });
      });
    }
  });
}

test.describe('targets below lg', () => {
  test('RESP-05 at 768 px every document chrome target measures at least 44 × 44 px, the header ▼ and divider included (#135)', async ({
    page,
    checkA11y,
  }) => {
    await installFakes(page);
    await asDesktop(page, 768);
    await signInTo(page, `/d/${DOC_ID}`);
    // Select a cell so the column's ▼ and divider are in the tab order (not required to measure).
    await page.getByRole('grid').getByRole('gridcell').first().click();
    const targets = [
      page.getByRole('link', { name: 'Back to my workscapes' }),
      page.getByRole('button', { name: 'Share' }),
      page.getByRole('button', { name: 'Add sheet' }),
      page.getByRole('button', { name: /(Expand|Collapse) inspector/ }).first(),
      page.getByRole('button', { name: /^Sort, filter or group/ }).first(),
      page.getByRole('separator', { name: /^Resize column/ }).first(),
    ];
    for (const target of targets) {
      const box = (await target.boundingBox())!;
      const name = await target.evaluate(
        (el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName,
      );
      expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
    }
    const title = (await page.getByLabel('Workscape title').boundingBox())!;
    expect(title.height, 'title field height').toBeGreaterThanOrEqual(44);

    // The grown boxes are really hit-testable, i.e. not clipped by the header row: a point
    // near the top of each box (inside the table's title bar) resolves to the control.
    for (const [role, name] of [
      ['button', /^Sort, filter or group/],
      ['separator', /^Resize column/],
    ] as const) {
      const target = page.getByRole(role, { name }).first();
      const box = (await target.boundingBox())!;
      const hit = await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          return el === null
            ? null
            : (el.closest('[aria-label]')?.getAttribute('aria-label') ?? el.tagName);
        },
        { x: box.x + box.width / 2, y: box.y + 4 },
      );
      expect(hit).toMatch(name);
    }
    await checkA11y('chrome targets 768');
  });
});
