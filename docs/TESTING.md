# Testing

Four layers, one rule for all of them: a test's name starts with the requirement id it
proves (`GRID-03 single click arms a cell`). `docs/TRACEABILITY.md` is generated from those
names by `npm run traceability`; regenerate it in every PR that adds or renames a test.

| Layer                    | Tool                                                   | Where                            | Runs in CI as                                          |
| ------------------------ | ------------------------------------------------------ | -------------------------------- | ------------------------------------------------------ |
| Unit and component       | Vitest (+ React Testing Library, jsdom for `apps/web`) | `**/*.test.ts(x)` next to source | `npm run verify`                                       |
| Infrastructure           | Vitest on synthesized CloudFormation templates         | `infra/test/`                    | `npm run verify`                                       |
| Journeys + accessibility | Playwright (Chromium) + `@axe-core/playwright`         | `apps/web/e2e/`                  | `npm run e2e` (Synth step, after verify)               |
| Live journey             | Playwright (Chromium) against `https://gede.work`      | `apps/web/e2e-live/`             | `npm run e2e:live` (Playwright-Live step, after Smoke) |

## Unit tests

```bash
npm run verify          # typecheck + lint + format:check + literal check + all unit tests
npm run test -w apps/web
npm run test:watch
```

Conventions are in each package's `CLAUDE.md`. No mocked API responses presented as real;
fakes are labelled fakes.

## Journeys (Playwright)

### What runs

The suite needs no backend. It builds the web app with `apps/web/e2e/vite.config.ts` into
`apps/web/e2e/dist/` (never `dist/`, which is what the pipeline deploys), emits
`/config.json` from `apps/web/e2e/fixtures/config.json` — the real, public production client
ids (`ap-southeast-1_1Zp23zP4h`, `1s3mm417d2rp61illc1bsg69bg`, `https://gede.work/api`) —
and serves the result with `vite preview` (port: see Running locally). Journeys that need a session sign in
through the labelled fake Cognito in `e2e/fakes/` (intercepted at the network edge); real OTP
needs a mailbox and passkeys only work on the production RP id.

| Spec                 | Journeys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.spec.ts`       | AUTH-01 `/` and `/d/:id` land on `/sign-in`, the path is retained · AUTH-02 segmented mode switch keeps the email · AUTH-03 Continue disabled until valid, Enter submits · AUTH-04/05 passkey first, hidden without `PublicKeyCredential`, no password field anywhere · AUTH-04 an email with no account (the fake pool answers `SELECT_CHALLENGE` without `EMAIL_OTP`, as production does under `preventUserExistenceErrors`) reads "No account uses this email…" for the code and the passkey alike · AUTH-08 _(partial — Apple is not deployed, #45)_ with Apple configured: Passkey → Apple → Email me a one-time code on the method step (option 1c, by position and by Tab), Apple at the email step too, Apple's wording, ≥ 44 px at every step · A11Y-01 Tab order, Enter, arrows + Space · A11Y-02 the painted focus ring is the `--focus-ring` token, 2 px solid at 2 px offset                                                                                                                                                                                                                                                                                                                                                                                                          |
| `responsive.spec.ts` | A11Y-06 sign-in at 480, 768, 1024, 1440 px and at 200 % zoom at each: no clipping, no horizontal scroll, no truncated label, passkey above code · RESP-05 every sign-in target is at least 44 × 44 px at 480 and 768 px                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `errors.spec.ts`     | Every catalogue page (400/401/403/404/429/500/503/504): copy from ARCHITECTURE-DIGEST §3, amber for 4xx and red for 5xx on the card's top rule, copyable ref announced through the live region (A11Y-04/05) · 503 polls `/api/health` every 15 s and continues on a 2xx · Check now shortcuts the poll · 400 validates a pasted link · the real router's 404 renders inside the app shell, so its live region exists and announces the copied ref (A11Y-05) · RESP-05 every target on every error page, the `ref …` button included, is ≥ 44 × 44 px at 480 and 768 px; 32 px at 1440                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `theme.spec.ts`      | DS dark theme: under `colorScheme: 'dark'` the `--surface` token resolves to `#0f1a15`, `html` and the sign-in card paint it, `color-scheme` is `dark`, `theme-color` matches; `data-theme="light"` pins light over the OS preference and `data-theme="dark"` swaps without it; axe on the dark 404 and sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `i18n.spec.ts`       | I18N-03 with `lang` set to ta-IN, hi-IN or te-IN every element with text on the sign-in screen and the 404 cell computes a line-height of ≥ 1.7 × its font size — button labels (1.2 in Latin) and headings (1.15) included; en-US keeps the design-system scale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `library.spec.ts`    | Signs in through the fake Cognito to the library (documents and `/api/me` faked at the network edge) · DS §3 every icon-only control has a ≥ 32 × 32 px hit area at 1440 · WCAG 3.1.2 each locale autonym in the account menu carries its own `lang`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `document.spec.ts`   | DOC-01..07 shell, rulers, pan/zoom/fit, RESP-01/02 at 480 and 768, 200 % zoom, SHARE-03 read-only notice, A11Y-05 live region · **Grid editing** at 1024 and 1440 px, mouse unplugged: GRID-03 amber inset ring from `--selection-ring`, GRID-04 type-to-overwrite / Enter / Escape / Delete, GRID-05 traversal with row-end wrap and append past the last row, GRID-06 Enter and Tab commit, KEYS-06 ⌥⌘↓ · ⌥⌘→ by `event.code`, GRID-08 divider and corner handle by keyboard and pointer (snapped, ruler letters agree with the data), GRID-09 wrap = 44 px rows with exact addresses, GRID-10 frozen shading, 2 px rule and the pinned panel once panned under, GRID-11 header 0 / footer 1, axe on the edited grid · RESP-02 / A11Y-04 at 480 px: no editor, strip, stub, divider, corner or Table menu; a locked cell keeps its lock glyph and text reason. Screens land in `test-results/screens/document-grid-*.png` (light and dark)                                                                                                                                                                                                                                                                                                                                                       |
| `find.spec.ts`       | FIND-01/02/05/06/07/09 at 1024 and 1440 px: ⌘F (by `event.code`, with the suite's Windows UA `mod` is Ctrl) and the magnifier open the bar and focus the field; the bar floats over the canvas; fuzzy on by default; amber highlights with the current ring; Enter / ⌘G / ⇧⌘G step across sheets and pan the viewport; Esc closes, clears, keeps the query; "No matches" keeps the bar open · FIND-03/08 workscape names as their own group; Replace and All write through the real y-websocket room; read-only matches are never rewritten · A11Y-05 counter announcements · axe on the open bar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `formulas.spec.ts`   | FX-02 FX-04 FX-05 FX-06 FX-07 FX-08 A11Y-04 `=` opens the forms menu, cells clicked while editing land in the draft, the stored formula is id-bound and shown projected, value + `ƒ2` badge (+ expression once the row is wrapped), a row inserted above keeps the value and re-spells the expression, text in range is an error with icon and text, outlines at 100 % and 122 % clear on Escape, the Worker is the transport, axe · FX-04 `@` autocomplete inserts the path and the reference follows a renamed row · FX-06 a reference loop is `circular` on every member                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `hierarchy.spec.ts`  | HIER-02/04/05/06/09/10, KEYS-06, A11Y-01 at 1024 and 1440 px: ⌘] / ⌘[ by `event.code` (Ctrl under the suite's Windows UA) nest and promote the selected row with its subtree, 15 px indent per level in the outline column from `--outline-indent`, ↳ on children, no address moves; the labelled chevron and ⌥← / ⌥→ collapse and expand the whole subtree so the rows below take the freed addresses; the room holds depth and collapse; ⌘Z takes a promote back in one step; axe on the nested and the collapsed table · RESP-02 at 480 px: indent, ↳ and chevron state render, no button, the chords and the glyph write nothing. HIER-01 is tagged partial until the inspector mounts `HierarchyPanel`. Screens land in `test-results/screens/document-hierarchy-*.png`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `graphs.spec.ts`     | GRAPH-01..11, INSP-08, REF-05, A11Y-04 at 1024 and 1440 px, light and dark: + Graph points and binds a pair, derives live, emphasises across the pair, writes back, moves and resizes on the lattice; GRAPH-04/10 shaped table and child sheet; RESP-02 read-only at 480; RESP-03 at 768; A11Y-06 at 200 % · **ADR-047 (#163)** at 1024 and 1440, light and dark, keyboard only: ⇧⌘→ to the ring, ⌫ takes that half only (the coverage stays bound, takes focus and the selection, the announcement names the half and ⌘Z), ⌘Z brings it back, ⌥← collapses a half to its one-row strip (title, dimensions or axes, count kept; chevron `aria-expanded`, 2 px ring at 2 px offset) and ⇧⌘0 frames the tables, ⌥→ expands, the graph context menu lists its routes, ⌘A then ⌫ deletes the table with its pair (no dialog, announced, focus on the plane) and one ⌘Z restores all; 480: no chevron, no delete or collapse route, a collaborator's collapse renders as the strip. Screens: `graph-*`, `graph-half-deleted-*`, `graph-collapsed-*`, `table-deleted-*`                                                                                                                                                                                                                                  |
| `sheets.spec.ts`     | **ADR-048 (#165)** at 1024 and 1440, light and dark, keyboard only: ⇧Tab to the strip, → to the second tab, F2 opens the name field in the tab's place (outside the tablist; axe), Enter renames and announces, ⌘Z restores the name, Shift+F10 opens the tab menu (Add sheet · Rename sheet F2 · Delete sheet ⌫; axe), End + Enter deletes the sheet with its table and no dialog (announcement with the ⌘Z chord, the dependent count and "Now on Sheet 1, Trek"; focus on the tab left; toast with Undo; axe), the cross-sheet reference reads "reference removed", one ⌘Z brings the sheet, table and value back; pointer at 1440: right-click → Rename, double-click, Escape, the last sheet's Delete disabled with its reason and ⌫ on it announcing why; 480: no menu, no rename, no delete. Screens: `sheet-rename-*`, `sheet-menu-*`, `sheet-deleted-toast-*`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tour.spec.ts`       | ONB-01..14 at 1024 and 1440 px: the guided sample is pinned first and flagged; the tour starts on arrival with the account flag unset (`/api/me` faked with `tourDoneAt: null`); step 1 spotlights the row by live bounding box (5 px ring, card 14 px below, never covering it); double-clicking opens the sample seeded from the real `seedSampleWorkscape` in the fake room; step 2 centres with no spotlight and advances only on a new `=@Team.Marcus.Role` typed through the entity index, then a `=Concat()`; step 3 centres too and advances on `=Union(C5:C12, I5:I8)` picked from the `=` forms menu, then `=Diff(I5:I8, C6)`, each asserted to evaluate to what its card says (ADR-055); step 4 on Add graph → bind → a dimension changed; step 5 on ⌘F + a query; step 6 on an invitation through the Share sheet; completion shows the forest toast with Replay and `PATCH /api/me { tourDone: true }` once; axe on every card light and dark (the card's fade settled first) · ONB-07 Skip by keyboard sets the flag; the page was never inert · ONB-08 the `?` help menu replays (flag cleared, step 1) and opens the shortcut sheet · ONB-13 nothing runs at 480 and the flag stays unset; widening to 768 brings the tour. Screens land in `test-results/screens/tour-step-*.png` |

No test is annotated `test.fail`. When the suite finds a defect it cannot fix from `e2e/`,
record it as `test.fail(true, reason)` with the measurement in the reason: the test keeps
running, and the moment the component is fixed the "expected to fail, but passed" result
fails the run, which is the signal to delete the annotation in that PR. The suite's first
run recorded three this way (AUTH-08 Apple button at 41.25 px, RESP-05 targets of 26.75–42.5 px
below 1024 px, A11Y-06 "Change" clipping to "Cha…" at 240 CSS px); PR #30 fixed all three
(`--hit-target` token, root font at 100 %, `.gd-signin__who` wrapping) and the annotations
are gone.

### Error pages without a backend

Only the `*` route can throw without a server (404). The other seven pages are reached
through `apps/web/e2e/harness/index.html` → `apps/web/src/test/e2e-harness/main.tsx`, a second
Vite entry that mounts the real `ErrorCell` inside a real router with the real config at
`/e2e/harness/?status=<code>`. It exists only in `e2e/dist/`. The 503 page really polls
`${apiUrl}/health`; the spec answers that request with `page.route` (a stub at the network
boundary, which is allowed — the component under test is untouched).

### Running locally

```bash
npm run e2e:install     # once: Chrome Headless Shell for this Playwright version
npm run e2e             # build e2e/dist, serve it, run every journey, print the axe summary
npm run e2e:ui          # the same in Playwright's UI mode
npm run e2e -- e2e/errors.spec.ts                     # one spec
E2E_BASE_URL=http://localhost:4173 npm run e2e        # against something already serving e2e/dist
E2E_PORT=4300 npm run e2e                             # pick the preview port yourself
```

The preview port is 4173 in CI and, locally, one derived from the checkout's path
(`4200 + hash(cwd) % 1000`), so two worktrees never share a port; a server already on it fails
the run rather than being reused — `vite preview` caches its file list at start, so a preview
left running would serve a stale build (or another worktree's) without saying so.

Outputs, all under `apps/web/test-results/` (gitignored):

- `axe/<screen>.json` — one record per `checkA11y()` call; `axe/summary.json` — the roll-up
- `screens/<name>.png` — full-page screenshots at every breakpoint and zoom, for the PR
- `e2e.json`, `playwright-report/` (CI only) — the Playwright run itself
- `<test>/trace.zip` on failure — `npx playwright show-trace <file>`

### Adding a journey

1. Import `test` and `expect` from `./fixtures/test.js`, not from `@playwright/test`. The
   fixture adds `checkA11y(screen)` and `snapshot(name)`.
2. Name the test with its requirement id first: `test('AUTH-03 Continue is disabled …')`.
3. Query by role and accessible name (`getByRole('button', { name: 'Continue' })`). A test
   that needs a CSS class to find something is usually reporting a missing name.
4. Call `await checkA11y('<screen> <breakpoint>')` on every screen state the journey reaches.
   The screen name becomes the JSON file name; keep it unique across specs.
5. Network: the app may only reach the preview on `localhost`. Stub anything external with
   `page.route(url, …)`; never stub the app's own modules, never fake a session.
6. Breakpoints and zoom: use `test.use({ viewport: { width, height: 900 } })` for 480, 768,
   1024, 1440 and `test.use(zoomed200(width))` for 200 % zoom (see below); a phone journey
   adds touch (`phoneContext(480)` / `asPhone(page)`). Do not invent other widths.
7. Run `npm run e2e` and `npm run traceability`, commit `docs/TRACEABILITY.md`.

### Breakpoint and zoom conventions

- Widths are the design system's: 480, 768, 1024, 1440 CSS px, height 900. `BREAKPOINTS` in
  `fixtures/test.ts` is the single list.
- 200 % zoom is emulated the way Chromium implements page zoom: the CSS viewport halves
  (240/384/512/720 px) and `deviceScaleFactor` becomes 2 (`zoomed200(width)`). Media queries
  and rem-based type then see exactly what a user pressing Ctrl-+ twice sees. Two things
  that do not work: `deviceScaleFactor: 2` alone (a sharper render of the same layout) and
  CSS `zoom: 2` (media queries keep evaluating the unzoomed width).
- The pass criterion at every size: every control visible and inside the viewport,
  `document.documentElement.scrollWidth <= clientWidth`, and reading order preserved
  (`expectNoHorizontalOverflow`, bounding-box comparisons).
- A phone is a narrow viewport **and** a coarse pointer (ADR-039): width alone is a desktop
  window, editable at any size. `test.use(phoneContext(480))` or `await asPhone(page, 480)`
  turns touch emulation on, which is what flips Chromium's `(pointer: coarse)` and
  `(hover: none)`; `asDesktop(page, width)` turns it off. A phone journey that only sets the
  viewport is wrong — it asserts the phone contract against a desktop. `zoomed200(width)` is
  a desktop at zoom (editable); `{ ...zoomed200(1440), hasTouch: true }` is a phone.
- `chrome.spec.ts` covers the document chrome itself at 320 and every breakpoint, at 200 %
  with a mouse and with touch, light and dark: the title row fits a long title (#124) and
  every secondary target measures 44 px below `lg` (#135).

## Accessibility (axe)

`checkA11y()` runs axe-core with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` tags
(`best-practice` is advisory and deliberately excluded), writes the result and **fails the
test on any `serious` or `critical` violation**. `moderate` and `minor` are recorded, not
failed. Colour contrast (A11Y-03) is `color-contrast`, impact `serious`, so it blocks.

Reading `apps/web/test-results/axe/summary.json`:

```json
{
  "screens": 20,
  "totals": { "critical": 0, "serious": 0, "moderate": 0, "minor": 0 },
  "perScreen": [
    {
      "screen": "sign-in method step 480 zoom200",
      "file": "sign-in-method-step-480-zoom200.json",
      "viewport": { "width": 240, "height": 450 },
      "deviceScaleFactor": 2,
      "passes": 19,
      "incomplete": 0,
      "critical": 0,
      "serious": 0,
      "moderate": 0,
      "minor": 0,
      "rules": []
    }
  ]
}
```

- `rules` lists the violated rule ids; open the per-screen file for `helpUrl`, the CSS
  `target` of every failing node and axe's `failureSummary`.
- `incomplete` counts checks axe could not decide (typically contrast over a gradient or
  an image); they never fail the run but are worth a look when the number moves.
- `passes` is the number of rules that ran and passed; a screen that suddenly reports far
  fewer usually rendered something other than what the test expected.

The same table is printed at the end of every run (locally and in the CodeBuild log), so
the CI record of the scan is the Synth build log; the JSON files live only on the runner.

## Live suite (`apps/web/e2e-live/`)

One journey against the deployed product, nothing faked: real Cognito, real sync service,
real CloudFront. It runs in the pipeline's `Playwright-Live` CodeBuild step after Smoke, and
it is a **post-deploy** check: a red run fails the execution but rolls nothing back —
production is already updated (RUNBOOK §2). Locally it runs against production too; there is
no other environment.

`journey.spec.ts`: sign in → the library loads → New workscape, named after the run → type
in B5, Enter → reload (the session is memory-only, so this is a second sign-in that returns
to the document) shows the text → a fresh browser context (no IndexedDB replica) shows it
too, which is the proof the service persisted it → ⌘F finds it → Share opens the sheet →
Delete, Recently Deleted, Delete All (the permanent confirm) → Sign out lands on
`/signed-out` and `/` is a sign-in again. Requirement ids in the test name as everywhere.

### How it signs in

The pool is passwordless for people and the SPA client has only the `USER_AUTH` flow; the
SPA keeps its tokens in memory (AUTH-09), so there is nothing to seed. The suite therefore
has an account and a client of its own, both created by CDK (`infra/lib/stacks/auth-stack.ts`):

- `gede-e2e`, a second app client whose only flow is `ADMIN_USER_PASSWORD_AUTH` — usable
  with IAM credentials alone, never from a browser; the SPA client is untouched (ADR-011).
- `e2e@gede.work`, created by a small custom-resource Lambda (`infra/assets/e2e-user/`)
  with a permanent password generated into Secrets Manager `gede/prod/e2e-user`. The
  handler receives the secret's ARN, never the value, and logs only the outcome.
- `services/sync` accepts tokens from both clients (`COGNITO_CLIENT_IDS`).
- The pool's pre-authentication trigger (`infra/assets/pre-auth/`) lets `e2e@gede.work` sign
  in through `gede-e2e` only and lets nobody else use that client, so the password never works
  from a browser. What a leak of the secret would expose is one test account and its own
  throwaway documents: the suite never shares, links or invites, and nothing is shared with it.
  Keep the account that way — no step of the live journey may share, or accept an invitation.

Per worker, `fixtures/live.ts` reads the secret and mints real tokens with
`AdminInitiateAuth`. Each sign-in then drives the real screen — email, "Email me a one-time
code" — and answers the SPA's own `InitiateAuth` request at the network edge with those tokens
as an `AuthenticationResult`, exactly the shape Cognito returns when no challenge is needed;
Amplify stores them and raises `signedIn` as after a code. This is the one stub the live
suite has, and it stands at the network boundary: the tokens are Cognito's, minted seconds
earlier, and everything after — `GetUser`, `/api/*`, the WebSocket — is real. The SPA
bundle is the deployed one, byte for byte.

The worker's teardown soft-deletes every document the account owns and calls
`delete-all`, so a red run leaves nothing for the next.

### Running it locally

```bash
export AWS_PROFILE=phani-quadnomics AWS_REGION=ap-southeast-1
export E2E_BASE_URL=https://gede.work
export E2E_USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name GeDe-Prod-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
export E2E_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name GeDe-Prod-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='E2eClientId'].OutputValue" --output text)
export E2E_SECRET_ARN=$(aws cloudformation describe-stacks --stack-name GeDe-Prod-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='E2eUserSecretArn'].OutputValue" --output text)
npm run e2e:install                       # once
npm run e2e:live                          # one worker, serial, 60 s per test
npm run e2e:live -- --ui                  # Playwright's UI mode
```

Your profile needs `cognito-idp:AdminInitiateAuth` on the pool and `GetSecretValue` on the
secret (an administrator has both). The pipeline's step runs as `gede-pipeline-playwright-live`,
which has exactly those two grants (`GeDe-Prod-Auth` attaches them by role name). Outputs
land in `apps/web/test-results-live/` and `apps/web/playwright-report-live/` (gitignored).
The suite runs against production: keep it to what it is — one account, one document,
deleted before sign-out.

## CI

CodeBuild runs `npm ci` → `npx playwright install --only-shell chromium` (after installing
Chromium's shared libraries with dnf) → `npm run verify` → `npm run db:parity -w packages/db`
(every migration against a throwaway postgres:17 in Docker) → `npm run e2e` → web build →
synth. Any red step stops the pipeline before assets are published. Why the suite runs on the AL2023
arm64 image rather than a Playwright container is in `infra/CLAUDE.md`, "Playwright on
CodeBuild"; `infra/test/stage.test.ts` pins the command order. After the Prod stage and Smoke,
the `Playwright-Live` project (same image and Chromium install, its own role) runs
`npm run e2e:live` against the deployment.
