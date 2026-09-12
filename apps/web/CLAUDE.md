# apps/web — conventions

React 19 + Vite + react-router 7 SPA. Served from S3 through CloudFront at `https://gede.work`.
Read the root `CLAUDE.md` first; everything there applies here.

## Dependencies and boundaries

- UI primitives come from `@gede/ui` only. Never import `@radix-ui/*` in this app; if a primitive is missing, add it to `packages/ui`.
- Colour, radius, duration, space and type come from `@gede/tokens`. No literals in component files.
- Domain logic (lattice index, A1 addressing, dependency graph, formula grammar, text algebra) lives in `@gede/core`. This app renders; it does not reimplement.

## Runtime config

- The app reads `/config.json` at startup. Keys, as written by `infra/lib/stacks/web-stack.ts`: `region`, `userPoolId`, `userPoolClientId`, `apiUrl` (`https://gede.work/api`), `wsUrl` (`wss://ws.gede.work/ws`), `appleSignIn` (`false`, or `{ domain }` with the Cognito hosted-UI host — `parseConfig` rejects anything else, #61). Change both sides in one PR; `infra/test/stage.test.ts` parses the rendered file with `parseConfig`. Nothing environment-specific is baked into the bundle; `import.meta.env` carries no Cognito ids.
- CDK writes the production `config.json` next to the bundle. Locally, copy `public/config.example.json` to `public/config.json`.

## Auth

- Amplify v6 `signIn` with `authFlowType: 'USER_AUTH'`; first factors `EMAIL_OTP` and `WEB_AUTHN`. No password field exists anywhere (AUTH-01..10).
- Tokens live in memory only. Never write them to `localStorage`, `sessionStorage` or cookies.
- Passkeys only work on `https://gede.work` (RP id). Do not test them on any other host.
- A 401 keeps the requested document path and returns to it after sign-in.

## State

- The Yjs document is the document state. React renders it; it never owns a copy. No document data in `useState`, `useReducer` or Context. Subscribe with `observeDeep` and re-render by cell id.
- Formula evaluation, regex and fuzzy matching run in Web Workers. The main thread never evaluates a formula (`packages/core` exposes a message-shaped API for this).
- Rendering is DOM-first: one CSS-transformed layer for tables and graphs, virtualised. Canvas is only for gridlines, ruler backgrounds and DAG edges "once they number in the hundreds" (PRD §20); until then edges are an SVG in the layer (`style/DagEdges.tsx`, ADR-033).
- Below 768 px the document is read-only: no edit affordance renders, the inspector and toolbar are absent (RESP-02).

## Input

- Shortcuts resolve from `event.code`, never `event.key` (KEYS, I18N-02).
- While `event.isComposing` (or `keyCode === 229`) the editor ignores Enter, Tab and arrows (I18N-01, GRID-06).
- All numbers, dates and collation go through `Intl` for the active locale (en-US, en-GB, en-IN, ta-IN, hi-IN, te-IN).

## Errors

Placement, from `docs/ARCHITECTURE-DIGEST.md` §3:

| Situation                                     | Surface                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| The document cannot render at all             | Full page (400, 401, 403, 404, 503, 500 before first render) |
| One table or sheet fails to load              | Placed card on the canvas                                    |
| Document works, a background operation failed | Banner (429, 504, 500 after render)                          |
| Transient and retried automatically           | Toast                                                        |

Retry: 5xx and 429 retry four times with jittered exponential backoff, then become an explicit error with a manual Retry. 4xx never auto-retries. 503 polls every 15 s. Edits stay in the local replica (IndexedDB) through every error.

## Tests

- Unit: Vitest + React Testing Library, jsdom. Test names start with the requirement id: `test('GRID-03 single click arms a cell', …)`. `docs/TRACEABILITY.md` is generated from these names.
- E2E: Playwright journeys in `e2e/`, run at 480, 768, 1024 and 1440 px and at 200 % zoom, with axe on every screen. No backend, no session: the suite builds `e2e/dist/` with `e2e/vite.config.ts` (config from `e2e/fixtures/config.json`, error pages via the `e2e/harness` entry) and fails on `serious`/`critical` axe violations. Phone journeys assert the absence of edit affordances. See `docs/TESTING.md`.
- No mocked API responses presented as real. Fakes are labelled fakes.

## Running locally

```bash
cp apps/web/public/config.example.json apps/web/public/config.json   # once, then edit
npm run dev -w services/sync    # sync + REST on :3000 (needs a local Postgres, see services/sync/CLAUDE.md)
npm run dev                     # Vite on :5173, proxies /api and /ws to :3000
npm run e2e:install             # once: Chrome Headless Shell
npm run e2e                     # builds e2e/dist, serves it, runs the journeys + axe (no sync needed)
```
