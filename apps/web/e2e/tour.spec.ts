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
      mailSentAt: string | null;
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
        mailSentAt: null,
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
const checklist = (page: Page) => page.getByTestId('dimension-checklist');

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The smallest box around every match of `selector`, each clipped by its
 * scrolling ancestors (the canvas plane, the inspector rail) — what the tour
 * spotlights (ONB-04).
 */
async function unionBox(page: Page, selector: string): Promise<Box | null> {
  const boxes = await unionBoxes(page, selector);
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}

/** The painted (clipped) boxes of `selector`'s matches; an element clipped away has none. */
async function unionBoxes(page: Page, selector: string): Promise<Box[]> {
  return page.locator(selector).evaluateAll((elements) =>
    elements.flatMap((el) => {
      const r = el.getBoundingClientRect();
      let box = { x: r.left, y: r.top, width: r.width, height: r.height };
      for (let node = el.parentElement; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (!/auto|scroll|hidden|clip/.test(`${style.overflowX} ${style.overflowY}`)) continue;
        const c = node.getBoundingClientRect();
        const x = Math.max(box.x, c.left);
        const y = Math.max(box.y, c.top);
        const right = Math.min(box.x + box.width, c.right);
        const bottom = Math.min(box.y + box.height, c.bottom);
        if (right <= x || bottom <= y) return [];
        box = { x, y, width: right - x, height: bottom - y };
      }
      return [box];
    }),
  );
}

/** Whether the scrim is `a`'s box 5 px out on every side (ONB-04), and the card is clear of `a`. */
function spotlightMatches(a: Box, s: Box, box: Box): boolean {
  const ring =
    Math.abs(s.x - (a.x - 5)) <= 1 &&
    Math.abs(s.y - (a.y - 5)) <= 1 &&
    Math.abs(s.width - (a.width + 10)) <= 2 &&
    Math.abs(s.height - (a.height + 10)) <= 2;
  const overlaps =
    box.x < a.x + a.width &&
    a.x < box.x + box.width &&
    box.y < a.y + a.height &&
    a.y < box.y + box.height;
  return ring && !overlaps;
}

/**
 * The card must sit inside the viewport and, when it has a target, not cover
 * it. A target with several anchors (`pointing`) is spotlit as their union.
 * Polled as one measurement, since the ring follows layout by animation frame.
 */
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
  await expectSpotlightOn(page, `[data-tour="${target}"]`);
}

/** The scrim is the union of `selector`'s painted boxes, 5 px out, and the card is clear of it. */
async function expectSpotlightOn(page: Page, selector: string): Promise<void> {
  await expect(page.locator(selector).first()).toBeVisible();
  await expect
    .poll(
      async () => {
        const a = await unionBox(page, selector);
        if (a === null) return 'nothing painted yet';
        const s = (await scrim(page).boundingBox())!;
        const c = (await card(page).boundingBox())!;
        return spotlightMatches(a, s, c) ? 'placed' : JSON.stringify({ a, s, c });
      },
      { message: `the spotlight follows ${selector}` },
    )
    .toBe('placed');
}

/** Type `text` into an empty cell and commit it; the entity index, if it opened, is answered first. */
async function commitFormula(page: Page, address: string, text: string): Promise<void> {
  await page.locator(`[data-address="${address}"]`).dblclick();
  const editor = page.getByLabel(`Edit ${address}`);
  await editor.fill(text);
  await expect(editor).toHaveText(text);
  await editor.press('Enter');
  if (await editor.count()) {
    // The `@` index took the Enter as its pick; the formula is unchanged, so commit again.
    await expect(editor).toHaveText(text);
    await editor.press('Enter');
  }
  await expect(editor).toHaveCount(0);
}

/**
 * Step 3 as the tour guides it, from its `add` card to step 4: `+ Graph`,
 * Escape (back to `add`, never Skip), `+ Graph` again, the pointing target
 * over Deliverables, then one dimension unticked in the Graph tab. Every
 * sub-card carries the step's counter and gets axe in both themes.
 */
async function graphStep(
  page: Page,
  checkA11y: (screen: string) => Promise<unknown>,
  width: number,
): Promise<void> {
  const label = String(width);
  const step3 = page.getByRole('dialog', { name: 'Add a context graph' });
  await expect(step3).toBeVisible();
  await expect(step3).toHaveAttribute('data-step', '3');
  await expect(step3).toHaveAttribute('data-substep', 'add');
  await expect(step3.getByText('STEP 3 OF 5', { exact: true })).toBeVisible();
  await expect(step3.locator('.gd-tour__dot--done')).toHaveCount(3);
  await expect(
    step3.getByText('No Numbers equivalent — it is not a chart. It reads and writes the table.'),
  ).toBeVisible();
  await expect(step3.getByRole('button', { name: /next/i })).toHaveCount(0);
  await expectCardPlaced(page, 'graph');
  await checkCardBothThemes(page, checkA11y, `tour step 3a ${label}`);

  // 3b — pointing mode: the targets over both tables are spotlit as one; the banner is lit.
  await page.getByRole('button', { name: 'Add graph' }).click();
  const point = page.getByRole('dialog', { name: 'Point it at a table' });
  await expect(point).toBeVisible();
  await expect(point).toHaveAttribute('data-step', '3');
  await expect(point).toHaveAttribute('data-substep', 'point');
  await expect(point.getByText('STEP 3 OF 5', { exact: true })).toBeVisible();
  await expect(point.locator('.gd-tour__dot--done')).toHaveCount(3);
  await expect(point.locator('.gd-tour__action')).toHaveText(/Click a table to bind the graph$/);
  await expect(point.getByText(/Deliverables and Team/)).toBeVisible();
  await expect(
    point.getByText('No Numbers equivalent — it is not a chart. It reads and writes the table.'),
  ).toBeVisible();
  await expect(page.getByTestId('pointing-target')).toHaveCount(2);
  await expect(page.getByText('Click a table to bind the graph.')).toBeVisible();
  await expect(page.locator('.gd-doc__pointing--lit')).toHaveCount(1);
  // The toolbar button is no longer the spotlight; the targets and the banner are, as one.
  await expectCardPlaced(page, 'pointing');
  await expectInsideSpotlight(page, '[data-testid="pointing-banner"]');
  await expectInsideSpotlight(page, '[aria-label="Bind the graph to Deliverables"]');
  // The Team table sits to the right of the canvas at these widths: the card says so.
  const painted = await unionBoxes(page, '[data-testid="pointing-target"]');
  if (painted.length < 2) await expect(point.getByTestId('tour-off-canvas')).toBeVisible();
  else await expect(point.getByTestId('tour-off-canvas')).toHaveCount(0);
  await checkCardBothThemes(page, checkA11y, `tour step 3b ${label}`);
  // GRAPH-03: Escape cancels pointing and returns to 3a — Skip is the only exit (ONB-07).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pointing-target')).toHaveCount(0);
  await expect(step3).toBeVisible();
  await expect(step3).toHaveAttribute('data-substep', 'add');
  await expect(step3.getByRole('button', { name: 'Skip' })).toBeVisible();
  await expectCardPlaced(page, 'graph');
  // The banner's Cancel does the same.
  await page.getByRole('button', { name: 'Add graph' }).click();
  await expect(point).toBeVisible();
  await page.getByTestId('pointing-banner').getByRole('button', { name: 'Cancel' }).click();
  await expect(step3).toHaveAttribute('data-substep', 'add');
  await page.getByRole('button', { name: 'Add graph' }).click();
  await expect(point).toBeVisible();
  await page.getByRole('button', { name: 'Bind the graph to Deliverables' }).click();
  await expect(page.getByRole('region', { name: 'Ring graph of Deliverables' })).toBeVisible();

  // 3c — the dimensions: the rail opens in Format mode on the Graph tab; the checklist is spotlit.
  const dimensions = page.getByRole('dialog', { name: 'Choose the dimensions' });
  await expect(dimensions).toBeVisible();
  await expect(dimensions).toHaveAttribute('data-step', '3');
  await expect(dimensions).toHaveAttribute('data-substep', 'dimensions');
  await expect(dimensions.getByText('STEP 3 OF 5', { exact: true })).toBeVisible();
  await expect(dimensions.locator('.gd-tour__dot--done')).toHaveCount(3);
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-state', 'open');
  await expect(page.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
  await expect(dimensions.locator('.gd-tour__action')).toHaveText(
    /Tick at least two dimensions in the Graph tab$/,
  );
  const list = checklist(page);
  await expect(list).toBeVisible();
  // GRAPH-05: the product's defaults, nothing more — the first three columns are ticked — and
  // the defaults alone never advance: step 4 is not here (ONB-05).
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(3);
  await expect(list.getByRole('checkbox', { name: /^Deliverable/ })).toBeChecked();
  await expect(page.getByRole('dialog', { name: 'Find across every table' })).toHaveCount(0);
  // The spotlight is the checklist with its Add dimension column control; the card covers
  // neither them nor the tab strip.
  await expectCardPlaced(page, 'dimensions');
  await expectInsideSpotlight(page, 'button[data-tour="dimensions"]');
  await expectClearOf(page, page.getByRole('tablist', { name: 'Format' }));
  await checkCardBothThemes(page, checkA11y, `tour step 3c ${label}`);
  // ONB-11: the checklist is operable under the tour. Unticking one leaves Owner and Status.
  await list.getByRole('checkbox', { name: /^Deliverable/ }).click();
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(2);
}

/** `selector`'s painted box lies inside the scrim's cut-out: it is not dimmed (ONB-04, ONB-11). */
async function expectInsideSpotlight(page: Page, selector: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const a = await unionBox(page, selector);
        if (a === null) return 'nothing painted yet';
        const s = (await scrim(page).boundingBox())!;
        const inside =
          a.x >= s.x - 1 &&
          a.y >= s.y - 1 &&
          a.x + a.width <= s.x + s.width + 1 &&
          a.y + a.height <= s.y + s.height + 1;
        return inside ? 'inside' : JSON.stringify({ a, s });
      },
      { message: `${selector} is inside the spotlight` },
    )
    .toBe('inside');
}

/** The card does not intersect `locator`'s box. */
async function expectClearOf(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  const a = (await locator.boundingBox())!;
  const c = (await card(page).boundingBox())!;
  const overlaps =
    c.x < a.x + a.width && a.x < c.x + c.width && c.y < a.y + a.height && a.y < c.y + c.height;
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
  test(`ONB-01 ONB-02 ONB-04 ONB-05 ONB-06 ONB-09 ONB-10 ONB-11 ONB-14 ONB-03 FX-01 GRAPH-03 GRAPH-05 at ${String(width)}: the tour starts on arrival, spotlights the pinned sample, and advances only as each action is performed for real — the reference and Concat sub-flow, the graph sub-flow — and completion confirms and sets the account flag`, async ({
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

    // Step 2b — Concat (FX-01): same counter and dots, still centred (ONB-06), Numbers named first.
    const concat = page.getByRole('dialog', { name: 'Join text with =Concat()' });
    await expect(concat).toBeVisible();
    await expect(concat).toHaveAttribute('data-step', '2');
    await expect(concat).toHaveAttribute('data-substep', 'concat');
    await expect(concat.getByText('STEP 2 OF 5', { exact: true })).toBeVisible();
    await expect(concat.locator('.gd-tour__dot--done')).toHaveCount(2);
    await expect(concat.getByText(/^Numbers: CONCATENATE or &/)).toBeVisible();
    await expect(concat.getByText('Commit a Concat over two or more arguments')).toHaveClass(
      /gd-tour__action/,
    );
    await expectCardPlaced(page, null);
    await checkCardBothThemes(page, checkA11y, `tour step 2b ${String(width)}`);
    // The card's own example, in the empty Owner role cell of row 3: C5 is Priya.
    await commitFormula(page, 'G7', '=Concat(C5, " — ", @Team.Priya.Role)');
    await expect(
      page.locator('[data-address="G7"]').getByTestId('formula-cell').locator('.gd-formula__value'),
    ).toHaveText('Priya — Product engineer');

    // Step 3 — the graph sub-flow: + Graph, point at Deliverables, choose the dimensions.
    await graphStep(page, checkA11y, width);

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
    // Two Blocked cells, and the graph bound in step 3 whose Status dimension (kept in 3c)
    // carries the value (FIND-03 "graph dimension values", #125).
    await expect(page.getByTestId('find-count')).toHaveText(/of 3/);

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

/** Steps 1 and 2 as the journey does them, to reach step 3's first card. */
async function reachGraphStep(page: Page): Promise<void> {
  await page.getByRole('row').filter({ hasText: 'Guided sample' }).dblclick();
  await expect(page).toHaveURL(new RegExp(`/d/${SAMPLE_ID}$`));
  await expect(
    page.getByRole('dialog', { name: 'Reference a cell in another table' }),
  ).toBeVisible();
  await expect(page.getByRole('grid').first()).toBeVisible();
  await commitFormula(page, 'G6', '=@Team.Marcus.Role');
  await expect(page.getByRole('dialog', { name: 'Join text with =Concat()' })).toBeVisible();
  await commitFormula(page, 'G7', '=Concat(C5, " — ", @Team.Priya.Role)');
  await expect(page.getByRole('dialog', { name: 'Add a context graph' })).toBeVisible();
}

for (const width of [1024, 1440] as const) {
  test(`A11Y-01 ONB-11 GRAPH-03 GRAPH-05 at ${String(width)}: step 3 completes with the mouse unplugged — Enter on Add graph hands focus to the first target, Tab cycles targets, Skip and the banner's controls, Enter binds, Space ticks`, async ({
    page,
    checkA11y,
  }) => {
    test.setTimeout(120_000);
    await installFakes(page, null);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await reachGraphStep(page);
    const rowsBefore = await page.locator('[data-address^="B"][data-address$="5"]').count();
    // The toolbar command, focused and activated from the keyboard.
    const addGraph = page.getByRole('button', { name: 'Add graph' });
    await addGraph.focus();
    await expect(addGraph).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Point it at a table' })).toBeVisible();
    // GRAPH-03: pointing mode hands focus to its first target (a button); Tab cycles the
    // mode's controls — targets, the tour's Skip, the banner's buttons — never the grid.
    const deliverables = page.getByRole('button', { name: 'Bind the graph to Deliverables' });
    await expect(deliverables).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Bind the graph to Team' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(card(page).getByRole('button', { name: 'Skip' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Add shaped table' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      page.getByTestId('pointing-banner').getByRole('button', { name: 'Cancel' }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(deliverables).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(
      page.getByTestId('pointing-banner').getByRole('button', { name: 'Cancel' }),
    ).toBeFocused();
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+Tab');
    await expect(deliverables).toBeFocused();
    // No Tab walked the table: the sample still has its eight rows (GRID-05 appends past the last).
    expect(await page.locator('[data-address^="B"][data-address$="5"]').count()).toBe(rowsBefore);
    await expect(page.locator('[data-address="B13"]')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Choose the dimensions' })).toBeVisible();
    await expect(page.getByTestId('inspector')).toHaveAttribute('data-state', 'open');
    await expect(page.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
    // The tour put focus on the checklist's first box, so the next action is one key away:
    // Space toggles a Radix checkbox.
    const deliverable = checklist(page).getByRole('checkbox', { name: /^Deliverable/ });
    await expect(deliverable).toBeFocused();
    await page.keyboard.press('Space');
    await expect(deliverable).not.toBeChecked();
    await expect(page.getByRole('dialog', { name: 'Find across every table' })).toBeVisible();
    await settled(page);
    await checkA11y(`tour step 4 after keyboard step 3 ${String(width)}`);
  });
}

test.describe('200 % zoom', () => {
  // A 2048 × 900 window at 200 % browser zoom: 1024 CSS px wide and 450 tall, device scale 2.
  test.use({ viewport: { width: 1024, height: 450 }, deviceScaleFactor: 2 });

  test('ONB-04 ONB-11 GRAPH-03 GRAPH-05 at 1024 × 200 % the graph sub-flow keeps every card inside the viewport and clear of the targets, the banner and the checklist', async ({
    page,
    checkA11y,
  }) => {
    test.setTimeout(120_000);
    await installFakes(page, null);
    await signIn(page);
    await reachGraphStep(page);
    await expectCardPlaced(page, 'graph');
    await page.getByRole('button', { name: 'Add graph' }).click();
    const point = page.getByRole('dialog', { name: 'Point it at a table' });
    await expect(point).toBeVisible();
    // 450 CSS px tall: the banner-to-tables spotlight leaves no room for the card below,
    // beside or above it, so it takes the bottom-right corner (ADR-045) — inside the
    // viewport, clear of the banner, its controls and the Deliverables label chip.
    await expect(point).toHaveAttribute('data-placement', 'corner');
    // The card's own height decides its top (ONB-09), one frame after it is measured.
    await expect
      .poll(async () => {
        const box = (await card(page).boundingBox())!;
        return box.x + box.width <= 1024 && box.y + box.height <= 450;
      })
      .toBe(true);
    await expectClearOf(page, page.getByTestId('pointing-banner'));
    await expectClearOf(
      page,
      page
        .getByRole('button', { name: 'Bind the graph to Deliverables' })
        .locator('.gd-pointing__label'),
    );
    await expectInsideSpotlight(page, '[data-testid="pointing-banner"]');
    await checkCardBothThemes(page, checkA11y, 'tour step 3b 1024 200%');
    await page.getByRole('button', { name: 'Bind the graph to Deliverables' }).click();
    const dimensions = page.getByRole('dialog', { name: 'Choose the dimensions' });
    await expect(dimensions).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
    await expectCardPlaced(page, 'dimensions');
    await expectClearOf(page, page.getByRole('tablist', { name: 'Format' }));
    await checkCardBothThemes(page, checkA11y, 'tour step 3c 1024 200%');
    await checklist(page)
      .getByRole('checkbox', { name: /^Deliverable/ })
      .click();
    await expect(page.getByRole('dialog', { name: 'Find across every table' })).toBeVisible();
  });
});

test('ONB-07 GRAPH-03 Skip during pointing ends the tour and cancels pointing mode: no banner or targets are left behind', async ({
  page,
}) => {
  const fakes = await installFakes(page, null);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await reachGraphStep(page);
  await page.getByRole('button', { name: 'Add graph' }).click();
  const point = page.getByRole('dialog', { name: 'Point it at a table' });
  await expect(point).toBeVisible();
  await point.getByRole('button', { name: 'Skip' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(scrim(page)).toHaveCount(0);
  await expect(page.getByTestId('pointing-banner')).toHaveCount(0);
  await expect(page.getByTestId('pointing-target')).toHaveCount(0);
  await expect.poll(() => fakes.patches).toEqual([{ tourDone: true }]);
});

test('ONB-13 RESP-03 ONB-04 at 768 the graph sub-flow runs with the inspector as an overlay: it opens for the dimensions card, the spotlight tracks the checklist, and falls back to the ring while the overlay is dismissed', async ({
  page,
  checkA11y,
}) => {
  test.setTimeout(120_000);
  await installFakes(page, null);
  await page.setViewportSize({ width: 768, height: 900 });
  await signIn(page);
  await reachGraphStep(page);
  const rail = page.getByTestId('inspector');
  await expect(rail).toHaveAttribute('data-state', 'collapsed');
  await page.getByRole('button', { name: 'Add graph' }).click();
  await expectCardPlaced(page, 'pointing');
  await checkCardBothThemes(page, checkA11y, 'tour step 3b 768');
  await page.getByRole('button', { name: 'Bind the graph to Deliverables' }).click();
  const dimensions = page.getByRole('dialog', { name: 'Choose the dimensions' });
  await expect(dimensions).toBeVisible();
  // RESP-03: below 1024 the open rail is an overlay; the tour opened it for the Graph tab.
  await expect(rail).toHaveAttribute('data-state', 'open');
  await expect(rail).toHaveAttribute('data-overlay', 'true');
  await expect(page.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
  await expectCardPlaced(page, 'dimensions');
  await checkCardBothThemes(page, checkA11y, 'tour step 3c 768');
  // Escape dismisses the overlay (not the tour): the checklist is gone and the graph is still
  // selected, so the strip's Expand control is spotlit; expanding brings the checklist back.
  await page.keyboard.press('Escape');
  await expect(rail).toHaveAttribute('data-state', 'collapsed');
  await expect(dimensions).toBeVisible();
  await expectSpotlightOn(page, '[data-tour="inspector-expand"]');
  await page.getByRole('button', { name: 'Expand inspector' }).click();
  await expect(rail).toHaveAttribute('data-state', 'open');
  await expect(page.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
  await expectCardPlaced(page, 'dimensions');
  // Deselecting the graph (a click on the canvas) drops the Graph tab: the ring is spotlit,
  // and selecting it again brings the rail and the checklist back.
  await page.getByTestId('plane').click({ position: { x: 40, y: 600 } });
  await expect(page.getByRole('tab', { name: 'Graph' })).toHaveCount(0);
  const ring = page.getByRole('region', { name: 'Ring graph of Deliverables' });
  await expectSpotlightOn(page, '[data-graph-kind="ring"][data-pair-id]:not([data-selected])');
  await ring.getByRole('button').first().click();
  await expect(rail).toHaveAttribute('data-state', 'open');
  await expectCardPlaced(page, 'dimensions');
  await checklist(page)
    .getByRole('checkbox', { name: /^Deliverable/ })
    .click();
  await expect(page.getByRole('dialog', { name: 'Find across every table' })).toBeVisible();
  await settled(page);
  await checkA11y('tour step 4 768');
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
