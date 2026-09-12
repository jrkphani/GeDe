# GeDe — project directives

GeDe is a text-oriented spreadsheet on an infinite lattice: tables, rich text, formulas,
cross-table references, context graphs, real-time sharing. This repository is the v2
rebuild (2026-09). v1 is archived on branch `archive/v1` (tag `v1-final`) and is **not** a
reference for anything here.

## Source of truth

| Question                                 | Where                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| What must the product do?                | `docs/REQUIREMENTS.md` — 147 numbered requirements (PRD §24). Verbatim.                                                              |
| Why / narrative                          | `docs/PRD-DIGEST.md`; full PRD at `docs/handover/specs/Text-Oriented Spreadsheet PRD.dc.html`                                        |
| Architecture, data model, capacity       | `docs/ARCHITECTURE-DIGEST.md`; C4 at `docs/handover/specs/GeDe Architecture C4.dc.html`                                              |
| Design system, tokens, components        | `docs/DESIGN-SYSTEM-DIGEST.md`; `packages/tokens/` is the only place a colour, radius or duration may be written                     |
| Sign-in (option 1c shipped), error pages | `docs/ARCHITECTURE-DIGEST.md` §2–3                                                                                                   |
| Keyboard map                             | `docs/handover/reference/shortcuts.md`                                                                                               |
| Behaviour when prose is ambiguous        | `docs/handover/prototype/Work Scape Canvas.dc.html` (open in a browser). **PRD wins over prototype**; file the difference in the PR. |

## Layout (npm workspaces, Node 22, TypeScript strict)

```
apps/web/         React 19 + Vite SPA. Radix primitives. Reads /config.json at runtime.
services/sync/    Fastify + ws (y-websocket protocol) + REST. Verifies Cognito JWTs. Persists to Postgres + S3.
packages/core/    Framework-free domain: lattice index, A1 addressing, dependency graph, formula grammar, text algebra.
packages/tokens/  tokens.css + theme.ts (verbatim from handover) + lint check.
packages/ui/      Design-system components on Radix. Icon sprite.
packages/db/      Drizzle schema, SQL migrations, migration runner.
infra/            One CDK app: PipelineStack + GedeStage (Network, Data, Auth, Edge, Service, Web, Dns, Ops).
docs/             Requirements, digests, the handover package.
```

Each package with its own conventions has a `CLAUDE.md`; read it before editing that package.

## Commands

```bash
npm ci                    # once
npm run verify            # typecheck + lint + format:check + unit tests — must be green before any PR
npm run build             # all workspaces
npm run dev               # web dev server
npm run e2e               # Playwright (needs a built web + running sync, see apps/web/CLAUDE.md)
npm run synth             # cdk synth (infra)
```

`npm run verify` is exactly what CodeBuild runs. If it is red locally it is red in the pipeline.

## Delivery model

- `main` **is production**. Every merge to `main` runs CodePipeline `GeDe` (ap-southeast-1):
  Synth (verify + build) → self-mutate → assets (arm64 image) → Prod stage → smoke test.
  Failures roll back (ECS circuit breaker + CloudFormation). Nobody runs `cdk deploy` from a laptop.
- Work on branches, open a PR using the template, get it reviewed, squash-merge.
- Every PR names the requirement IDs it closes and adds tests tagged with those IDs
  (`test('GRID-03 single click arms a cell', …)`). `docs/TRACEABILITY.md` is regenerated from those tags.

## Non-negotiables (from the handover — a PR violating any of these is rejected)

1. **Tokens.** No literal hex, radius or duration in a component file. Use `packages/tokens`.
2. **WCAG 2.1 AA.** Keyboard-complete; 2 px amber focus ring at 2 px offset, never removed; body contrast ≥ 4.5:1; no state carried by hue alone.
3. **Addressing.** Presentation never changes a cell's A1 address. Indentation, wrapping and grouping are visual; position is data. Tables never reflow at a breakpoint.
4. **Optimistic editing.** A local edit renders immediately; typing is never blocked by sync. Only a failed sync surfaces anything.
5. **Phone is read-only** below 768 px, by contract. No edit affordance renders there.
6. **Apple's sign-in button is Apple's.** Black variant, their glyph, 44 pt minimum, approved wording, never subordinate to another provider. Passkey sits above it; there is no password field anywhere.
7. **Headless primitives.** Menus, dialogs, tabs, selects, switches are built on Radix. A hand-rolled dropdown is a defect.
8. **No invented data.** No mocked APIs, no placeholder functions, no fabricated fixtures presented as real. Clearly marked stubs only.

## Definition of done, per component

1. No literal colour, radius or duration in source.
2. All interactive states (default / hover / focus-visible / active / disabled) specified and keyboard-reachable.
3. Renders at 480, 768, 1024, 1440 and at 200 % zoom.
4. Light and dark checked; contrast ratio recorded in the PR.
5. Built on the headless primitive, not a `div` with handlers.

## Engineering rules

- Four phases for anything non-trivial: explore → plan → implement → PR. Do not collapse them.
- Shortcuts resolve from `event.code`, never `event.key` (Tamil99 / InScript / Remington layouts).
- The editor ignores Enter / Tab / arrows while `isComposing` (IME).
- Numbers, dates, collation go through `Intl` for the active locale (en-US/GB/IN, ta-IN, hi-IN, te-IN).
- `packages/core` imports nothing from React or the DOM. Formula evaluation runs outside React.
- Regex and fuzzy matching run in Web Workers.
- Ids are ULIDs generated client-side. A1 addresses are computed, never stored.
- Migrations only (`packages/db/migrations`); never edit the schema directly. Migrations run on service boot under an advisory lock.
- Voice: plain, specific, sentence case. No "Oops", no "!", no emoji. Buttons are verbs.

## Verification before "done"

`npm run verify` green, plus for visual work a screenshot at the breakpoints above. State explicitly when something could not be verified.
