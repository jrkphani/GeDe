# Testing

Three layers, one rule for all of them: a test's name starts with the requirement id it
proves (`GRID-03 single click arms a cell`). `docs/TRACEABILITY.md` is generated from those
names by `npm run traceability`; regenerate it in every PR that adds or renames a test.

| Layer                    | Tool                                                   | Where                            | Runs in CI as                            |
| ------------------------ | ------------------------------------------------------ | -------------------------------- | ---------------------------------------- |
| Unit and component       | Vitest (+ React Testing Library, jsdom for `apps/web`) | `**/*.test.ts(x)` next to source | `npm run verify`                         |
| Infrastructure           | Vitest on synthesized CloudFormation templates         | `infra/test/`                    | `npm run verify`                         |
| Journeys + accessibility | Playwright (Chromium) + `@axe-core/playwright`         | `apps/web/e2e/`                  | `npm run e2e` (Synth step, after verify) |

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
and serves the result with `vite preview` (port: see Running locally). Nothing in the suite signs in: OTP
needs a mailbox and passkeys only work on the production RP id.

| Spec                 | Journeys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.spec.ts`       | AUTH-01 `/` and `/d/:id` land on `/sign-in`, the path is retained · AUTH-02 segmented mode switch keeps the email · AUTH-03 Continue disabled until valid, Enter submits · AUTH-04/05 passkey first, hidden without `PublicKeyCredential`, no password field anywhere · AUTH-08 with Apple configured: Passkey → Apple → Email me a code on the method step (option 1c, by position and by Tab), Apple at the email step too, Apple's wording, ≥ 44 px at every step · A11Y-01 Tab order, Enter, arrows + Space · A11Y-02 the painted focus ring is the `--focus-ring` token, 2 px solid at 2 px offset                                                                                                                                                                                                                                                                                                                                      |
| `responsive.spec.ts` | A11Y-06 sign-in at 480, 768, 1024, 1440 px and at 200 % zoom at each: no clipping, no horizontal scroll, no truncated label, passkey above code · RESP-05 every sign-in target is at least 44 × 44 px at 480 and 768 px                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `errors.spec.ts`     | Every catalogue page (400/401/403/404/429/500/503/504): copy from ARCHITECTURE-DIGEST §3, amber for 4xx and red for 5xx on the card's top rule, copyable ref announced through the live region (A11Y-04/05) · 503 polls `/api/health` every 15 s and continues on a 2xx · Check now shortcuts the poll · 400 validates a pasted link · the real router's 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `document.spec.ts`   | DOC-01..07 shell, rulers, pan/zoom/fit, RESP-01/02 at 480 and 768, 200 % zoom, SHARE-03 read-only notice, A11Y-05 live region · **Grid editing** at 1024 and 1440 px, mouse unplugged: GRID-03 amber inset ring from `--selection-ring`, GRID-04 type-to-overwrite / Enter / Escape / Delete, GRID-05 traversal with row-end wrap and append past the last row, GRID-06 Enter and Tab commit, KEYS-06 ⌥⌘↓ · ⌥⌘→ by `event.code`, GRID-08 divider and corner handle by keyboard and pointer (snapped, ruler letters agree with the data), GRID-09 wrap = 44 px rows with exact addresses, GRID-10 frozen shading, 2 px rule and the pinned panel once panned under, GRID-11 header 0 / footer 1, axe on the edited grid · RESP-02 / A11Y-04 at 480 px: no editor, strip, stub, divider, corner or Table menu; a locked cell keeps its lock glyph and text reason. Screens land in `test-results/screens/document-grid-*.png` (light and dark) |
| `find.spec.ts`       | FIND-01/02/05/06/07/09 at 1024 and 1440 px: ⌘F (by `event.code`, with the suite's Windows UA `mod` is Ctrl) and the magnifier open the bar and focus the field; the bar floats over the canvas; fuzzy on by default; amber highlights with the current ring; Enter / ⌘G / ⇧⌘G step across sheets and pan the viewport; Esc closes, clears, keeps the query; "No matches" keeps the bar open · FIND-03/08 workscape names as their own group; Replace and All write through the real y-websocket room; read-only matches are never rewritten · A11Y-05 counter announcements · axe on the open bar                                                                                                                                                                                                                                                                                                                                            |

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
   1024, 1440 and `test.use(zoomed200(width))` for 200 % zoom (see below). Do not invent
   other widths.
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

## CI

CodeBuild runs `npm ci` → `npx playwright install --only-shell chromium` (after installing
Chromium's shared libraries with dnf) → `npm run verify` → `npm run db:parity -w packages/db`
(every migration against a throwaway postgres:17 in Docker) → `npm run e2e` → web build →
synth. Any red step stops the pipeline before assets are published. Why the suite runs on the AL2023
arm64 image rather than a Playwright container is in `infra/CLAUDE.md`, "Playwright on
CodeBuild"; `infra/test/stage.test.ts` pins the command order.
