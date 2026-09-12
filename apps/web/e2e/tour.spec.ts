/**
 * The first-run guided tour against the built bundle (ONB-01..14). Labelled
 * FAKES at the network edge: Cognito, `/api/me` (the account's tour flag and
 * sample id, with PATCH recorded), the documents list with the pinned sample,
 * the sample's record and sharing routes, and the y-websocket room seeded
 * with the real sample (`seedSampleWorkscape` from `@gede/core`). The SPA —
 * library, document, formula Worker, Find, Share sheet and the tour itself —
 * runs for real. Axe runs on every card, light and dark, at 1024 and 1440.
 */
import type { Page } from '@playwright/test';
import { seedSampleWorkscape } from '@gede/core';
import { FAKE_CODE, installFakeCognito } from './fakes/cognito.js';
import type { FakeSession } from './fakes/jwt.js';
import { FakeRoom } from './fakes/room.js';
import { asPhone, computedTokenColor, expect, test } from './fixtures/test.js';

const SAMPLE_ID = '7a2b3c4d-0000-4000-8000-0000000000b1';
const OTHER_ID = '7a2b3c4d-0000-4000-8000-0000000000b2';
const SESSION: FakeSession = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_fakepool',
  clientId: 'fakeclientid0000000000000',
  sub: 'e2e-user-7',
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

/** The suite's device profile (Desktop Chrome) reports a Windows UA, so `mod` resolves to Ctrl (I18N-02). */
const mod = 'Control';

const listing = (id: string, title: string, sample: boolean, updatedAt: string) => ({
  id,
  title,
  kind: 'workscape' as const,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt,
  ownerId: SESSION.sub,
  ownerName: SESSION.name,
  sharedWithOthers: false,
  permission: 'owner' as const,
  sizeBytes: 42000,
  deletedAt: null,
  archivedAt: null,
  everShared: false,
  sample,
  linkAccess: 'none' as const,
});

/** The sample as the service lists it, and a newer document it is pinned above. */
const SAMPLE = listing(SAMPLE_ID, 'Q3 Delivery — Guided sample', true, '2026-09-01T00:00:00Z');
const OTHER = listing(OTHER_ID, 'Everest trek', false, '2026-09-12T10:00:00Z');

interface Fakes {
  /** Every `PATCH /api/me` body, in order (ONB-03, ONB-07, ONB-08). */
  patches: Record<string, unknown>[];
  invites: string[];
  room: FakeRoom;
}

async function installFakes(page: Page, tourDoneAt: string | null): Promise<Fakes> {
  const patches: Record<string, unknown>[] = [];
  const invites: string[] = [];
  let flag = tourDoneAt;
  const profile = () => ({
    id: SESSION.sub,
    sub: SESSION.sub,
    email: SESSION.email,
    displayName: SESSION.name,
    locale: 'en-US',
    tourDoneAt: flag,
    sampleDocumentId: SAMPLE_ID,
  });
  await page.route('**/config.json', (route) => route.fulfill({ json: CONFIG }));
  await installFakeCognito(page, SESSION);
  await page.route('**/api/me', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      if (body.tourDone === true) flag = '2026-09-13T01:00:00.000Z';
      if (body.tourDone === false) flag = null;
    }
    return route.fulfill({ json: profile() });
  });
  await page.route('**/api/documents?**', (route) =>
    route.fulfill({ json: { documents: [OTHER, SAMPLE] } }),
  );
  await page.route('**/api/documents', (route) =>
    route.fulfill({ json: { documents: [OTHER, SAMPLE] } }),
  );
  await page.route(`**/api/documents/${SAMPLE_ID}`, (route) =>
    route.fulfill({ json: { document: SAMPLE } }),
  );
  const sheet = {
    owner: { id: SESSION.sub, name: SESSION.name, email: SESSION.email },
    participants: [] as unknown[],
    invites: [] as {
      id: string;
      email: string;
      permission: string;
      invitedBy: string;
      expiresAt: string;
    }[],
    linkAccess: 'none',
    linkToken: null,
    permission: 'owner',
    callerId: SESSION.sub,
  };
  await page.route(`**/api/documents/${SAMPLE_ID}/**`, (route) => {
    const path = new URL(route.request().url()).pathname.replace(`/api/documents/${SAMPLE_ID}`, '');
    const method = route.request().method();
    if (method === 'GET' && path === '/shares') return route.fulfill({ json: sheet });
    if (method === 'POST' && path === '/invites') {
      const body = route.request().postDataJSON() as { email: string; permission: string };
      invites.push(body.email);
      sheet.invites.push({
        id: `inv-${String(sheet.invites.length + 1)}`,
        email: body.email,
        permission: body.permission,
        invitedBy: SESSION.sub,
        expiresAt: '2026-09-27T00:00:00.000Z',
      });
      // As production answers while SES is in the sandbox (#121): the invitation is
      // created, its mail was refused. The tour's action is the invitation.
      return route.fulfill({
        status: 201,
        json: { kind: 'invite', created: true, delivery: 'failed', shares: sheet },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'not_found', message: 'Nothing at this address', ref: 'e2e' } },
    });
  });
  const room = new FakeRoom({ viewOnly: false });
  // The real sample, as the service seeds it (ONB-01).
  seedSampleWorkscape(room.doc);
  await room.install(page);
  return { patches, invites, room };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email').fill(SESSION.email);
  await page.getByLabel('Email').press('Enter');
  await page.getByRole('button', { name: 'Email me a one-time code' }).click();
  await page.getByLabel('Six-digit code').fill(FAKE_CODE);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  const notNow = page.getByRole('button', { name: 'Not now' });
  await Promise.race([
    notNow.waitFor({ state: 'visible', timeout: 8000 }).then(() => notNow.click()),
    page.waitForURL(/\/$/, { timeout: 8000 }),
  ]).catch(() => undefined);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recents');
  await expect(page.getByText(OTHER.title)).toBeVisible();
}

const card = (page: Page) => page.getByTestId('tour-card');
const scrim = (page: Page) => page.getByTestId('tour-scrim');

/** The card must sit inside the viewport and, when it has a target, not cover it. */
async function expectCardPlaced(page: Page, target: string | null): Promise<void> {
  const box = await card(page).boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  if (target === null) {
    await expect(scrim(page)).toHaveAttribute('data-target', 'none');
    await expect(card(page)).toHaveAttribute('data-placement', 'centre');
    return;
  }
  await expect(scrim(page)).toHaveAttribute('data-target', target);
  const anchor = page.locator(`[data-tour="${target}"]`);
  await expect(anchor).toBeVisible();
  const a = (await anchor.boundingBox())!;
  const s = (await scrim(page).boundingBox())!;
  // ONB-04: the spotlight is the anchor's live box, 5 px out on every side.
  expect(Math.abs(s.x - (a.x - 5))).toBeLessThanOrEqual(1);
  expect(Math.abs(s.y - (a.y - 5))).toBeLessThanOrEqual(1);
  expect(Math.abs(s.width - (a.width + 10))).toBeLessThanOrEqual(2);
  expect(Math.abs(s.height - (a.height + 10))).toBeLessThanOrEqual(2);
  // The card never covers its target.
  const overlaps =
    box!.x < a.x + a.width &&
    a.x < box!.x + box!.width &&
    box!.y < a.y + a.height &&
    a.y < box!.y + box!.height;
  expect(overlaps).toBe(false);
}

/** The card's enter motion blends colours; axe must see it settled. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('.gd-tour__card, .gd-toast')).every((el) =>
      el.getAnimations().every((animation) => animation.playState === 'finished'),
    ),
  );
}

/** Axe on the current card in light, then dark, then back (the scrim and card use theme tokens). */
async function checkCardBothThemes(
  page: Page,
  checkA11y: (screen: string) => Promise<unknown>,
  screen: string,
): Promise<void> {
  await settled(page);
  await checkA11y(`${screen} light`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await checkA11y(`${screen} dark`);
  await page.emulateMedia({ colorScheme: 'light' });
}

for (const width of [1024, 1440] as const) {
  test(`ONB-01 ONB-02 ONB-04 ONB-05 ONB-06 ONB-09 ONB-10 ONB-11 ONB-14 ONB-03 at ${String(width)}: the tour starts on arrival, spotlights the pinned sample, and advances only as each of the five actions is performed for real; completion confirms and sets the account flag`, async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    test.setTimeout(120_000);
    const fakes = await installFakes(page, null);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);

    // Step 1 — the library. The sample is pinned first, flagged, and spotlit.
    const sampleRow = page.getByRole('row').filter({ hasText: 'Guided sample' });
    await expect(sampleRow).toContainText('Sample');
    await expect(page.locator('tr[data-id]').first()).toHaveAttribute('data-id', SAMPLE_ID);
    const step1 = page.getByRole('dialog', { name: 'Open the sample workscape' });
    await expect(step1).toBeVisible();
    await expect(step1).toHaveAttribute('aria-modal', 'false');
    await expect(step1.getByText('STEP 1 OF 5', { exact: true })).toBeVisible();
    await expect(step1.getByText('Double-click “Q3 Delivery — Guided sample”')).toBeVisible();
    await expect(step1.getByRole('button', { name: 'Skip' })).toBeVisible();
    await expect(step1.getByRole('button', { name: /next/i })).toHaveCount(0);
    await expect(step1.locator('.gd-tour__note')).toHaveCount(0);
    await expectCardPlaced(page, 'sample');
    // The pending action is the live amber token (ONB-09), on both themes.
    await expect(step1.locator('.gd-tour__action')).toHaveCSS(
      'color',
      await computedTokenColor(page, '--warning'),
    );
    await checkCardBothThemes(page, checkA11y, `tour step 1 ${String(width)}`);
    await snapshot(`tour-step-1-${String(width)}`);
    // ONB-11: the dim layer takes no pointer; the row underneath is what the double-click reaches.
    expect(fakes.patches).toEqual([]);
    await sampleRow.dblclick();
    await expect(page).toHaveURL(new RegExp(`/d/${SAMPLE_ID}$`));

    // Step 2 — centred, no spotlight (ONB-06); the sample's tables are on the canvas.
    const step2 = page.getByRole('dialog', { name: 'Reference a cell in another table' });
    await expect(step2).toBeVisible();
    await expect(step2.getByText('STEP 2 OF 5', { exact: true })).toBeVisible();
    await expect(
      step2.getByText(
        'Numbers: People::B2, tied to a position. GeDe: =@Entity.Path, tied to the row itself.',
      ),
    ).toBeVisible();
    await expectCardPlaced(page, null);
    await expect(page.getByRole('grid').first()).toBeVisible();
    // ONB-01: the sample keeps its name — the title field is read-only with the reason.
    const title = page.getByLabel('Workscape title');
    await expect(title).toHaveValue('Q3 Delivery — Guided sample');
    await expect(title).toHaveAttribute('readonly', '');
    await expect(title).toHaveAttribute('title', 'The guided sample keeps its name');
    await checkCardBothThemes(page, checkA11y, `tour step 2 ${String(width)}`);
    // The worked reference the sample ships with does not count; typing a new one does.
    // Deliverables at B2: header row 4, data rows 5–12; Owner role is column G.
    const g6 = page.locator('[data-address="G6"]');
    await g6.dblclick();
    const editor = page.getByLabel('Edit G6');
    // "type = then @, and pick an entity" — the entity index offers the Team row, then its column.
    await editor.fill('=@Team.Mar');
    const entities = page.getByRole('listbox', { name: 'Entities' });
    await expect(entities).toContainText('@Team.Marcus');
    // ONB-11: the card never blocked the edit — the editor is live with the draft.
    await expect(step2).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(editor).toHaveText('=@Team.Marcus');
    await editor.press('End');
    await editor.pressSequentially('.Ro');
    await expect(entities).toContainText('@Team.Marcus.Role');
    await page.keyboard.press('Enter');
    await expect(editor).toHaveText('=@Team.Marcus.Role');
    await editor.press('Enter');
    await expect(editor).toHaveCount(0);
    // REF-01: a bare =@ path is a live reference cell showing the source's value.
    await expect(g6.getByTestId('reference-cell')).toContainText('Platform engineer');

    // Step 3 — the graph command in the toolbar.
    const step3 = page.getByRole('dialog', { name: 'Add a context graph' });
    await expect(step3).toBeVisible();
    await expect(
      step3.getByText('No Numbers equivalent — it is not a chart. It reads and writes the table.'),
    ).toBeVisible();
    await expectCardPlaced(page, 'graph');
    await checkCardBothThemes(page, checkA11y, `tour step 3 ${String(width)}`);
    await page.getByRole('button', { name: 'Add graph' }).click();
    await expect(page.getByText('Click a table to bind the graph.')).toBeVisible();
    await expect(step3).toBeVisible();
    await page.getByRole('button', { name: 'Bind the graph to Deliverables' }).click();
    await expect(page.getByRole('region', { name: 'Ring graph of Deliverables' })).toBeVisible();

    // Step 4 — Find.
    const step4 = page.getByRole('dialog', { name: 'Find across every table' });
    await expect(step4).toBeVisible();
    await expect(
      step4.getByText('Numbers searches one sheet at a time. ⌘F here spans every table and graph.'),
    ).toBeVisible();
    await expectCardPlaced(page, 'find');
    await checkCardBothThemes(page, checkA11y, `tour step 4 ${String(width)}`);
    await page.keyboard.press(`${mod}+KeyF`);
    const field = page.getByRole('textbox', { name: 'Find' });
    await expect(field).toBeFocused();
    await expect(step4).toBeVisible();
    await field.fill('Blocked');
    await expect(page.getByTestId('find-count')).toHaveText(/of 2/);

    // Step 5 — Share and invite.
    const step5 = page.getByRole('dialog', { name: 'Invite someone by email' });
    await expect(step5).toBeVisible();
    await expect(
      step5.getByText('Like iCloud sharing, with a permission you set per person.'),
    ).toBeVisible();
    await expect(step5.getByText('STEP 5 OF 5', { exact: true })).toBeVisible();
    await expect(step5.locator('.gd-tour__dot--done')).toHaveCount(5);
    await page.keyboard.press('Escape');
    await expectCardPlaced(page, 'share');
    await checkCardBothThemes(page, checkA11y, `tour step 5 ${String(width)}`);
    await snapshot(`tour-step-5-${String(width)}`);
    await page.getByRole('button', { name: 'Share' }).click();
    const sheet = page.getByRole('dialog', { name: 'Share Q3 Delivery — Guided sample' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('textbox', { name: 'Add people by email' }).fill('akshaya@example.com');
    await page.keyboard.press('Enter');
    await expect(sheet.getByRole('list', { name: 'People with access' })).toContainText(
      'akshaya@example.com',
    );
    await expect.poll(() => fakes.invites).toEqual(['akshaya@example.com']);
    // #121: the mail could not be sent; the invitation is saved and the sheet says so.
    await expect(sheet.getByTestId('share-mail-failed')).toContainText(
      'Invitation saved — the email could not be sent; share the link or try again',
    );
    await expect(sheet.getByRole('button', { name: 'Resend' }).first()).toBeVisible();
    await checkA11y(`share sheet mail failed ${String(width)}`);

    // ONB-14: completion names where to replay; ONB-03: the account flag is set once.
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toBeHidden();
    const done = page.locator('.gd-tour__toast');
    await expect(done).toContainText('All five done. Replay any time from the ? in your library.');
    await expect(done.getByRole('button', { name: 'Replay' })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(scrim(page)).toHaveCount(0);
    await expect.poll(() => fakes.patches).toEqual([{ tourDone: true }]);
    await settled(page);
    await checkA11y(`tour done ${String(width)}`);

    // The tour does not come back on the next arrival: the flag is set on the account.
    await page.getByRole('link', { name: 'Back to my workscapes' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recents');
    await expect(card(page)).toHaveCount(0);
  });
}

test('ONB-07 ONB-03 Skip on step 1 ends the tour for good and sets the account flag; the page was never inert', async ({
  page,
  checkA11y,
}) => {
  const fakes = await installFakes(page, null);
  await page.setViewportSize({ width: 1024, height: 900 });
  await signIn(page);
  const step1 = page.getByRole('dialog', { name: 'Open the sample workscape' });
  await expect(step1).toBeVisible();
  // ONB-11: with the card up, a control outside the spotlight still works.
  await page.getByRole('button', { name: 'Archived' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Archived');
  await page.getByRole('button', { name: 'Recents', exact: true }).click();
  await expect(step1).toBeVisible();
  // Keyboard: Skip is reachable and works.
  await step1.getByRole('button', { name: 'Skip' }).focus();
  await page.keyboard.press('Enter');
  await expect(step1).toBeHidden();
  await expect(scrim(page)).toHaveCount(0);
  await expect.poll(() => fakes.patches).toEqual([{ tourDone: true }]);
  await checkA11y('tour skipped 1024');
});

test('ONB-08 Replay guided tour from the ? help control clears the flag and restarts at step 1; the menu also opens the shortcut sheet', async ({
  page,
  checkA11y,
}) => {
  const fakes = await installFakes(page, '2026-09-01T00:00:00.000Z');
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await expect(card(page)).toHaveCount(0);
  const help = page.getByRole('button', { name: 'Help' });
  await expect(help).toBeVisible();
  await help.click();
  const menu = page.getByRole('menu', { name: 'Help' });
  await expect(menu.getByRole('menuitem', { name: 'Keyboard shortcuts' })).toBeVisible();
  await checkA11y('library help menu 1440');
  await menu.getByRole('menuitem', { name: 'Replay guided tour' }).click();
  // Under load, a trigger click that lands while the last menu is still leaving is taken by
  // Radix as a pointer-down outside the menu and dismisses the one it opens (the one-off
  // ONB-08 timeout): wait for the menu to have gone before the next trigger click.
  await expect(menu).toBeHidden();
  const step1 = page.getByRole('dialog', { name: 'Open the sample workscape' });
  await expect(step1).toBeVisible();
  await expect(step1).toHaveAttribute('data-step', '1');
  await expect.poll(() => fakes.patches).toEqual([{ tourDone: false }]);
  // Replay while running: still step 1.
  await help.click();
  await menu.getByRole('menuitem', { name: 'Replay guided tour' }).click();
  await expect(menu).toBeHidden();
  await expect(step1).toHaveAttribute('data-step', '1');
  await expect.poll(() => fakes.patches).toEqual([{ tourDone: false }, { tourDone: false }]);
  await step1.getByRole('button', { name: 'Skip' }).click();
  await expect(step1).toBeHidden();
  await expect.poll(() => fakes.patches).toHaveLength(3);
  await help.click();
  await menu.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('ONB-13 RESP-02 RESP-05 below 768 px (480) the tour does not run and the flag stays unset; at 768 it does, with a 44 px Skip', async ({
  page,
}) => {
  const fakes = await installFakes(page, null);
  await asPhone(page, 480, 900);
  await signIn(page);
  await expect(page.getByRole('row').filter({ hasText: 'Guided sample' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);
  await expect(scrim(page)).toHaveCount(0);
  expect(fakes.patches).toEqual([]);
  // Widening past the phone breakpoint on the same arrival brings the tour (the flag is still unset).
  await page.setViewportSize({ width: 768, height: 900 });
  const step1 = page.getByRole('dialog', { name: 'Open the sample workscape' });
  await expect(step1).toBeVisible();
  await expectCardPlaced(page, 'sample');
  expect(fakes.patches).toEqual([]);
  // RESP-05: below 1024 px the card's one control is a 44 px target.
  const skip = (await step1.getByRole('button', { name: 'Skip' }).boundingBox())!;
  expect(skip.width).toBeGreaterThanOrEqual(44);
  expect(skip.height).toBeGreaterThanOrEqual(44);
});
