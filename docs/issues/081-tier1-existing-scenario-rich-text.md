# 081: Tier 1 Foundation — "Existing Scenario" rich-text field

- **Status**: OPEN
- **Milestone**: M6 (Foundation UI polish, same track as 013/021/024) — no sync/infra blocker; independent of 077/078/080
- **Blocked by**: none (013 shipped; tier1_purpose is a stable synced table). Sized to land after 078/080 close, only so `verify:fast`'s live-sync fixtures aren't fighting an unrelated red build — not a hard dependency.

## User story

As a designer filling in the 1st Tier — Foundation, I want to describe the **existing scenario** (the situation before this design intervenes) as **formatted prose** — paragraphs, indents, bold, italic, underline, bulleted and numbered lists — the same way I'd write it in a real document, not as a flat text blob. Today Foundation only has a plain-text purpose statement (`tier1_purpose.body`, `MultilineEdit`) and the ranked value-propositions table; there is nowhere to record the existing scenario at all, formatted or not.

## Investigation summary (grounds the design below)

- **SPEC.md:40** already names Purpose "1st Tier: single **rich-text** statement" in the glossary — the *intent* for rich text on Foundation predates this issue; 013 shipped `body` as plain text (`MultilineEdit`, `src/components/ui/multiline-editor.tsx`) as a deliberate v1 simplification (013's Slice section: "purpose text block — in-place, multiline"). This issue is the first Foundation field to actually need rich formatting, so it's the right place to introduce the editor primitive Purpose itself could adopt later (out of scope here — no change to `body`/Purpose in this slice).
- **SPEC.md:69** (data model): `tier1_purpose id · project_id · body` — one row per project, enforced by `tier1_purpose_project_idx` unique index (`src/db/schema.ts:119`). This is the natural home for "existing scenario": same cardinality (one per project), same document-like nature, same table already gets a full row rewrite through `getTier1Purpose`/`setTier1Purpose` (`src/db/mutations.ts:882-905`).
- **SITEMAP.md:14,60**: Foundation is `/p/:projectId/foundation`; its context bar is empty and stays hidden (no new chrome to add there). The field mounts on the existing Foundation surface only.
- **STYLE_GUIDE.md** tokens this field must use: §1 principle 2 (in-place editing, no modal), §2.1 (`--panel`/`--hairline` for the editor's paper-panel chrome), §2.2 (toolbar buttons are the `command` variant — always-visible, not row-scoped), §3 (Inter for body prose — this is prose, not mono data notation), §4 (0-radius panel, `--accent` focus ring), §5 (Lucide 16px/1.5px icons for Bold/Italic/Underline/List glyphs, sparse — no icon beside a label that already says it, so toolbar buttons are icon-only with `aria-label`), §10 (keyboard operability + labeled controls is a per-issue acceptance criterion, not polish), §11 (raw `<button>`/third-party UI primitives forbidden outside `src/components/ui/` — enforced by `eslint.config.js:100-145`; color/fill/background must be `var(--…)` tokens — enforced by `.stylelintrc`'s `scale-unlimited/declaration-strict-value` rule).
- **013's shipped notes** (`docs/issues/done/013-tier1-foundation.md`): purpose is edited via `MultilineEdit` (click-to-edit, ghost placeholder, autosave through the mutation layer, one command-log undo step per commit). This field follows the same interaction contract — click to edit, autosave on commit, one undo step per commit gesture — but needs a different editor primitive since `MultilineEdit` is a plain `<textarea>` with no formatting model.
- **The synced-column ripple** (078 step 2, commit `6f618c7`, and 075's refresh-signal pattern) is the load-bearing precedent for adding a column to an Electric-synced table — six registries, enumerated below with file:line, each verified against the actual current code (not assumed from the task brief's guessed file names).

## Design brief

- **Information hierarchy (canonical Foundation reading order, top → bottom)** — the load-bearing UX decision for this route: **(1) "What is the system for?"** — the Purpose statement (`tier1_purpose.body`); **(2) "Existing scenario"** — this new rich-text field; **(3) the value architecture table** — ranked value propositions (`tier1_props`). This is a deliberate problem-framing sequence: *purpose* (why this system exists) → *current reality* (the scenario as it is today, before the design intervenes) → *proposed value architecture* (what we build in response). Existing Scenario sits strictly **between** Purpose and the value table — never above Purpose, never below the table. Any implementation that reorders these three elements is a spec deviation to discuss, not a layout choice.
- **Placement**: a new "Existing scenario" paper panel directly below the existing purpose panel (`src/components/FoundationSurface.tsx:158-174`) and above the value-propositions table (`:176`), same 32px section spacing (013's design brief) as the purpose→table gap. Header: small label above the panel reading "Existing scenario" (Inter, `--text-label`/`--leading-label` per STYLE_GUIDE §11 table), mirroring how the value-propositions table has an implicit header via its column heads — Purpose itself has no visible label today (its ghost text does the job), but a second document-like field on the same page needs one so the two panels are distinguishable at a glance.
- **Editor chrome**: `--panel` background, `--hairline` 1px border, 0 radius (STYLE_GUIDE §4) — reads as the same "paper panel" instrument as the purpose block, not a foreign widget bolted on.
- **Toolbar**: a single row of icon-only `command`-variant buttons (Bold, Italic, Underline, Bulleted list, Numbered list, Indent, Outdent) — Lucide 16px glyphs, `aria-label` per button, `aria-pressed` reflecting the active mark/block state at the cursor. Sits inside the panel, above the editable region, separated by a `--hairline` rule (mirrors the composer bar's "hairline top border" pattern, STYLE_GUIDE §7). Only appears when not read-only (013/035 precedent: a viewer sees rendered content, no toolbar, no click-to-edit).
- **Empty state**: ghost text "Describe the existing scenario…" (mirrors Purpose's `PURPOSE_GHOST` pattern, `FoundationSurface.tsx:19`), CSS `::before` or a display-mode ghost span exactly like Purpose's `tier1-purpose__ghost` class.
- **Commit granularity**: commits **on blur** (matches `MultilineEdit`'s blur-commit contract, `multiline-editor.tsx:97-104`), not per-keystroke — a rich-text `onChange` fires on every keystroke/format toggle, and enqueuing a sync mutation or pushing a command-log entry per keystroke would flood both the queue and undo history. One user gesture (open → format/type → click away) = one commit = one undo step, same contract as Purpose.

## Data-model decision

**Add a nullable `existing_scenario` column to the existing `tier1_purpose` table** (not a new table, not a new row-per-scenario model).

Why not a new table: `tier1_purpose` is already the project's "one row of document-like content" table (SPEC.md:69, unique `project_id` index at `schema.ts:119`). Existing Scenario has the exact same cardinality (0 or 1 per project) and the exact same lifecycle (created/updated with the project, never listed/paginated/reordered like `tier1_props`). A second table would need its own six-registry wiring (schema/migration/envelope/protocol/mutations/write-store) for zero cardinality benefit over a second column on the row that already has all of that wiring. A new column is also the smaller migration: no NOT NULL/backfill sequence is needed (unlike 078 step 2's `workspace_id`, which had to be nullable→backfilled→NOT NULL because every existing row needed a real value) — `existing_scenario` is a genuinely new, optional field; `NULL` legitimately means "not written yet," so it ships nullable from the start, one `ALTER TABLE ... ADD COLUMN` statement.

**Storage format decision — Lexical `EditorState` JSON, not HTML.** See "Rich-text library" below for the full justification; the schema consequence is: `existing_scenario` is `text`, nullable, holding a JSON-stringified Lexical editor state (or `NULL`), not an HTML string.

### Migration sketch — `src/db/migrations/0016_tier1_existing_scenario.sql`

```sql
-- Issue 081 — adds the Foundation "Existing Scenario" rich-text field onto the
-- existing tier1_purpose row (SPEC.md:69's single-row-per-project document
-- table; see schema.ts's tier1Purpose comment). Nullable, no backfill: this is
-- a genuinely new optional field (unlike 078 step 2's workspace_id, which
-- needed nullable -> backfill -> NOT NULL because every existing row needed a
-- real value). NULL means "not written yet" and is a legitimate terminal
-- state, not a migration waypoint.
--
-- Storage format: a JSON-stringified Lexical EditorState (see
-- src/domain/projectEnvelope.ts's existingScenario comment for why this is
-- opaque JSON, not HTML). This migration only adds a text column; the shape
-- of what's inside it is enforced at the editor layer, not by Postgres.
--
-- tier1_purpose already has REPLICA IDENTITY FULL (migration 0012, table-
-- level setting) -- ALTER TABLE ADD COLUMN does not reset it, and Postgres
-- re-derives the full-row WAL image automatically; no replica-identity
-- migration needed here (confirmed against 0012_electric_replica_identity.sql:24).
ALTER TABLE "tier1_purpose" ADD COLUMN "existing_scenario" text;
```

Run `npm run db:generate` for the drizzle-kit meta snapshot/journal entry (`src/db/migrations/meta/0016_snapshot.json` + `_journal.json` idx 16), matching 0015's own generated-then-hand-annotated pattern.

## The synced-column ripple — full checklist (078-step-2 template, verified file:line)

`tier1_purpose` is Electric-synced (`src/domain/syncScope.ts:41`, `SYNCED_TABLES`) with `REPLICA IDENTITY FULL` already set (`0012_electric_replica_identity.sql:24`, unaffected by a new column). Every one of the six registries below either needs an edit or an explicit confirmation that it inherits the change for free — both are listed, since a silently-inherited registry is still a thing a reviewer must verify, not assume.

1. **`src/db/schema.ts:104-120`** — the `tier1Purpose` pgTable. Add `existingScenario: text('existing_scenario'),` after `body: text('body').notNull(),` at line 114 (nullable — no `.notNull()`, matching the migration).

2. **New migration `src/db/migrations/0016_tier1_existing_scenario.sql`** (+ `meta/0016_snapshot.json` + `meta/_journal.json` idx 16) — sketch above. `REPLICA IDENTITY FULL` is already set table-wide by `0012_electric_replica_identity.sql:24`; **confirmed no new replica-identity statement is needed** (unlike a brand-new table, which would need one).

3. **`src/domain/projectEnvelope.ts`**:
   - `tier1PurposeRow` zod schema (`:66-74`) — add `existingScenario: z.string().nullable(),` after `body: z.string(),` at line 70.
   - `FORMAT_VERSION` (`:34`, currently `3`) bumps to `4`.
   - New `upgradeV3ToV4(raw)` function, mirroring `upgradeV2ToV3` (`:365-376`) exactly but scoped to one field on one table: for every `tier1_purpose` row missing `existingScenario`, set it to `null`. No new "scoped tables" array needed (078 step 2's `V2_WORKSPACE_SCOPED_TABLES` pattern was for 3 tables gaining the *same* column; here it's 1 table gaining 1 field — a single `if (isRecord(row) && !('existingScenario' in row)) row.existingScenario = null` loop over `tables.tier1_purpose` is enough, no new constant array required).
   - `parseEnvelope`'s version dispatch (`:391-397`) gains the `upgradeV3ToV4` call in the same chained-upgrade shape: `formatVersion === 1` → v1→v2→v3→v4 chain; `formatVersion === 2` → v2→v3→v4; add `formatVersion === 3` → `upgradeV3ToV4(raw)` alone.
   - `tableColumns()`/`fieldOrder()` (`:462-474`) need **no edit** — they read `Object.keys(rowSchemas[name].shape)`, so adding `existingScenario` to `tier1PurposeRow`'s zod shape at step 1 flows through automatically. This is also what `syncDelta.ts`'s allow-list (next item) inherits.

4. **`src/sync/electricProtocol.ts:61-69`** — `SQL_TO_JS_COLUMNS.tier1_purpose`. Add `existing_scenario: 'existingScenario',` after `body: 'body',` at line 65. **Required**, not optional: an unmapped SQL column is silently dropped by `toCamelRow` (confirmed by the existing comment at `electricProtocol.ts:124-127` on the `parameters` entry) — omitting this means every remote-created/updated `tier1_purpose` row loses its `existingScenario` value the moment it round-trips through Electric, even though the local write worked fine (exactly 078 step 2's own stated risk for `workspace_id`).

5. **`src/domain/syncDelta.ts`** — **no edit needed, verify only.** `tableColumns()` (`:65-67`) delegates to `projectEnvelope.tableColumns()` (confirmed: `import { tableColumns as envelopeTableColumns, ... } from './projectEnvelope'` at `:21`) for every envelope table, `tier1_purpose` included. Step 3's zod-shape addition is sufficient; `assertBaseColumnsOnly` (`:96-101`) automatically allows `existingScenario` in a `tier1_purpose` delta once it's a schema field. A red test should still assert this (Test-first plan below) rather than trusting the inheritance blind.

6. **`src/db/mutations.ts:882-905`** — `getTier1Purpose` needs no change (already `select()`s the whole row). Add a new `setTier1ExistingScenario(db, projectId, existingScenario)` mirroring `setTier1Purpose` (`:894-905`), **not** a parameter added to `setTier1Purpose` itself — Purpose and Existing Scenario are edited independently (separate editors, separate commit gestures per the design brief), so they need separate setters the way `setDescription`/`renameProp` are separate from each other on `tier1Props` (`:951-976`). **Correctness subtlety, must be a red test**: `tier1Purpose`'s `body` column is `NOT NULL` (`schema.ts:114`). A naive `setTier1ExistingScenario` that inserts `{id, projectId, workspaceId, existingScenario}` on first-ever save (no purpose row exists yet) violates that NOT NULL constraint. The setter must read the current row first and carry its `body` (or `''`) into the insert values, e.g.:
   ```ts
   export async function setTier1ExistingScenario(
     db: Database, projectId: string, existingScenario: string | null,
   ): Promise<Tier1PurposeRow | null> {
     const workspaceId = await projectWorkspaceId(db, projectId)
     const current = await getTier1Purpose(db, projectId)
     await db.insert(tier1Purpose)
       .values({ id: uuidv7(), projectId, workspaceId, body: current?.body ?? '', existingScenario })
       .onConflictDoUpdate({ target: tier1Purpose.projectId, set: { existingScenario, updatedAt: now() } })
     return getTier1Purpose(db, projectId)
   }
   ```
   `src/server/writeApi/store.ts:290-292` (`SQL_TABLE_NAMES.tier1Purpose → 'tier1_purpose'`) needs **no edit** — confirmed by reading the generic apply path (`store.ts:502-536`): only `id`/`updated_at`/`deleted_at`/`workspace_id` are in `SERVER_STAMPED` (`:524`, closed by 078 step 2's own fix); every other payload column (including `body` today, `existingScenario` after this issue) flows through the generic camelCase→snake_case `entries`/`columns`/`values` mapping unconditionally. This is the one registry that genuinely needs **zero code changes** — verify with a contract test (Test-first plan), don't just assert it from reading the code.

## Rich-text library decision

**Lexical** (`lexical` + `@lexical/react` + `@lexical/list` + `@lexical/history`; `@lexical/selection`/`@lexical/utils` as needed by list commands), storing the editor's **own serialized JSON** (`JSON.stringify(editorState.toJSON())`) in `existing_scenario`, not an HTML string.

Why, against the alternatives:

| Concern | Lexical | TipTap/ProseMirror | Minimal `contentEditable` |
| --- | --- | --- | --- |
| Bundle size | Core ~22kb gz + `@lexical/react` ~5kb + `@lexical/list` ~3kb ≈ 30-35kb gz for exactly this formatting set | Core+view+model+StarterKit typically 100kb+ gz — most of it (tables, code blocks, images, headings) is formatting this issue doesn't ask for | ~0kb, but see below |
| React 19 | Built and maintained by Meta specifically for React; used inside React itself; no known React 19 incompatibilities | Generally works but ProseMirror's view layer predates React's concurrent-rendering model and has had friction reports under React 18/19 strict mode | N/A |
| Requested formatting set (paragraph, indent, bold, italic, underline, bullets, numbering) | All native/first-class: `INDENT_CONTENT_COMMAND`/`OUTDENT_CONTENT_COMMAND` are core `ElementNode` commands (no extension needed); bold/italic/underline are `TextNode` format bit-flags (not markup); `@lexical/list` ships `INSERT_UNORDERED_LIST_COMMAND`/`INSERT_ORDERED_LIST_COMMAND` | Bold/italic/bullets/numbering ship in `StarterKit`; **indent is not** — needs a third-party community extension (extra dependency, extra trust surface) | Everything hand-built: `document.execCommand` is deprecated/inconsistent across browsers; no real security boundary (see below) |
| Security (XSS) | **Editor-enforced node schema** — only registering `ParagraphNode`/`TextNode`(default)/`ListNode`/`ListItemNode` means nothing capable of holding a `<script>`/`href`/`style`/event-handler attribute is *representable in the state at all*. This is a whitelist by construction, not a blocklist applied after the fact. | Same idea is possible (a minimal ProseMirror schema), but StarterKit's convenience pulls in more node types than needed by default, widening the surface unless explicitly pruned | None — raw `contentEditable` + `innerHTML` is exactly the XSS shape this issue's security requirement exists to prevent |
| Accessibility | contentEditable-based like every rich-text editor (Lexical, TipTap, Slate); toolbar/keyboard wiring is on us either way — no library difference here | Same caveat | Worse — no built-in ARIA/keyboard command scaffolding at all |

**Serialization format — Lexical JSON, not HTML, and why that matters for the security requirement**: storing the editor's structured state (a typed node tree) rather than an HTML string means the render path never needs `dangerouslySetInnerHTML` — a read-only surface reconstructs the DOM by feeding the same JSON into a Lexical instance configured with the exact same restricted node whitelist used for editing, so the whitelist protects **both** the write and the read path with one enforcement point, not two. This is a stronger default than "store HTML, sanitize on render," though DOMPurify is still required as defense-in-depth (below) for any future path that does emit HTML (print/export). New dependencies: `lexical`, `@lexical/react`, `@lexical/list`, `@lexical/history`, `dompurify` + `@types/dompurify` — none currently in `package.json` (confirmed by grep).

## Security — sanitization requirement (must address)

This repo's own multi-user/local-first framing makes this non-optional, not a nice-to-have: `existing_scenario` streams through Electric to every workspace member's browser (`src/domain/syncScope.ts`'s `SYNCED_TABLES` already includes `tier1_purpose`), so **content authored by one user renders inside another user's DOM** without that second user having reviewed it. A malicious or buggy client (compromised device, tampered write, a future bug in the write-path) is a realistic threat model here, not a hypothetical.

1. **Primary defense — editor-enforced schema.** The Lexical editor instance (both the editable one in `FoundationSurface` and any future read-only render) registers exactly `ParagraphNode` (built-in), `TextNode` (built-in, formats are bit-flags not markup), `ListNode`, `ListItemNode` — nothing else. No `LinkNode` (no `href`), no `HeadingNode`, no `CodeNode`, no custom `DecoratorNode` (Lexical's escape hatch for arbitrary embedded React/HTML — must never be registered here). This makes "inject a `<script>`/`<style>`/`onerror=` attribute" structurally impossible: those aren't node types this editor knows how to construct, so they cannot exist in the state, synced or not.
2. **Parse guard on load.** Hydrating a synced `existingScenario` JSON blob (`editor.parseEditorState(json)`) must be wrapped in try/catch with a fail-closed fallback: an unparseable payload, or one containing a node type outside the registered whitelist, renders as empty/plain-text (never partially applied, never thrown further into the DOM), and is logged as a diagnosable event — mirroring this repo's existing "fail closed on the untrusted boundary" convention (`src/domain/syncScope.ts:161`'s comment: "input is pre-sanitized (CLAUDE.md: no unchecked trust boundaries)").
3. **DOMPurify as defense-in-depth**, required by this issue even though it's not on the critical path today: any future code path that converts this field to an HTML string (e.g. `$generateHtmlFromNodes` for a print/export view) must run the result through `DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p','strong','b','em','i','u','ul','ol','li'], ALLOWED_ATTR: [] })` — the exact requested formatting set, nothing else, no `style`/`class`/`on*` attributes — before it ever reaches `dangerouslySetInnerHTML` or an equivalent. Add the dependency now so this guard rail exists before the first HTML-rendering caller, not retrofitted after one ships without it.
4. **Never `dangerouslySetInnerHTML` a raw `existingScenario` string directly** — this is the one hard rule this issue must not violate anywhere in `FoundationSurface.tsx` or a future read-only surface.

## Export/import, undo/redo, accessibility

- **Export/import**: covered by the `projectEnvelope.ts` ripple item above (§3) — `FORMAT_VERSION` 3→4, `upgradeV3ToV4`. A v3 (or older, chain-upgraded) export imports cleanly with `existingScenario: null` on every `tier1_purpose` row; a v4 export round-trips the Lexical JSON string byte-for-byte (`projectEnvelope.ts`'s serialization is already deterministic — "rows sorted by id, fields in schema order," `:459-464` — no new work needed there beyond the schema field itself).
- **Undo/redo**: `src/store/tier1.ts` gains `existingScenario: string | null` state (loaded alongside `purpose` in `load()`, `:55-85`, refreshed on the same `tier1AppliedAt` sync signal — no new signal needed, `tier1_purpose` is already one combined signal per 075's implementation notes) and a `setExistingScenario` action mirroring `setPurpose` (`:87-113`) — one command-log entry per commit (blur), snapshotting the previous serialized JSON string. **Same Subtlety-A-class nuance as 073 flagged for `setPurpose`** (`tier1.ts:95-101`'s comment): the `enqueueIfSyncing('tier1_purpose', row.id, op, row)` op must be `'upsert'` only on the very first `tier1_purpose` row ever created for this project, and `'update'` on every subsequent edit — determined by whether **any** `tier1_purpose` row already existed (`get().purpose !== '' || get().existingScenario !== null` before this edit), not by whether *this specific field* was previously empty, since Purpose and Existing Scenario share one row.
- **Accessibility**: toolbar is a `role="toolbar"` group of the shared `Button` primitive (`command` variant, STYLE_GUIDE §2.2) with roving-tabindex arrow-key navigation (WAI-ARIA toolbar pattern) and `aria-pressed` per toggle button reflecting the format/block state at the cursor; each button carries an `aria-label` (Bold/Italic/Underline/Bulleted list/Numbered list/Indent/Outdent) since STYLE_GUIDE §5 keeps icons unlabeled-by-text ("sparse... never beside a label that already says it" — the icon *is* the label, so `aria-label` carries the accessible name). The editable region itself carries `aria-label="Existing scenario"` (mirrors `MultilineEdit`'s `ariaLabel="System purpose"` at `FoundationSurface.tsx:171`). Cmd/Ctrl+B/I/U keyboard shortcuts ship via Lexical's default `RichTextPlugin` bindings — must not collide with SITEMAP §4's global keymap (⌘K, ⌘1/2/3, ⌘Z/⇧⌘Z, `c`, `v`, `Esc`) since those all live outside a focused text field, but must be verified with a focus-scope test regardless. Focus ring `2px solid --accent` (STYLE_GUIDE §4) on both the editable region and every toolbar button. A viewer (035's `readOnly`) sees the rendered content with no toolbar and no click-to-edit, exactly like Purpose (`FoundationSurface.tsx:172`).

## Test-first plan (red first)

1. **`src/db/schema.ts` / migration round-trip** — `src/db/tier1.test.ts`: after migration 0016, inserting a `tier1_purpose` row without `existingScenario` succeeds (nullable) and a row with it round-trips through `getTier1Purpose`. Red today (column doesn't exist).
2. **`setTier1ExistingScenario` NOT NULL subtlety** — `src/db/mutations.test.ts`: calling `setTier1ExistingScenario` on a project with **no** existing `tier1_purpose` row succeeds and leaves `body` as `''` (not a Postgres NOT NULL violation); calling it after a purpose already exists preserves `body` unchanged. Red today (function doesn't exist; the NOT NULL trap is exactly what this test is for).
3. **Envelope round-trip** — `src/domain/projectEnvelope.test.ts`: a v3-format export (no `existingScenario` field) imports cleanly via `upgradeV3ToV4`, landing `existingScenario: null`; a v4 export/import round-trip preserves a non-null Lexical JSON string byte-for-byte; `FORMAT_VERSION` assertion bumps to `4`. Red today (field/version don't exist).
4. **Sync delta allow-list** — `src/domain/syncDelta.test.ts`: a `RowDelta` for `tier1_purpose` carrying `existingScenario` passes `assertBaseColumnsOnly` (proves item 5 of the ripple checklist is genuinely inherited, not just assumed). Red today (field not in the schema yet, so it would currently throw `DerivedColumnInDeltaError`).
5. **Electric protocol column mapping** — `src/sync/electricProtocol.test.ts`: `SQL_TO_JS_COLUMNS.tier1_purpose` maps `existing_scenario` → `existingScenario` — a raw SQL-shaped row survives `toCamelRow` with the field intact (proves item 4; catches the "silently dropped" failure mode 078 step 2 flagged). Red today.
6. **Write-path pass-through contract** — `src/server/writeApi/store.test.ts` (or the existing `pgWriteStore.contract.test.ts`): an `update` mutation on `tier1Purpose` carrying `existingScenario` in its payload reaches the SQL `UPDATE` statement's column list unmodified (proves item 6's "no code change needed" claim with a real assertion, not a read-the-code inference). Red today (field doesn't exist on the payload type yet).
7. **Sanitization rejects a malicious payload** — a new `src/domain/richText.test.ts` (or colocated with the editor component): parsing a JSON payload containing a node type outside the registered whitelist (simulate a `LinkNode`/`DecoratorNode`/raw-HTML-shaped node) fails closed — no throw escapes to crash the app, no unwhitelisted markup reaches the rendered DOM, editor falls back to empty/plain text. Also assert `DOMPurify.sanitize` strips a `<script>`/`onerror=` payload from any HTML-emitting path, with only `p/strong/em/u/ul/ol/li` surviving.
8. **Editor formatting commands** — a new `src/components/ui/rich-text-editor.test.tsx`: each toolbar command (Bold, Italic, Underline, Bulleted list, Numbered list, Indent, Outdent) applied to a selection produces the expected node/format state; `aria-pressed` toggles correctly; keyboard shortcuts (Cmd/Ctrl+B/I/U) apply the same commands as their toolbar buttons.
9. **FoundationSurface integration** — `src/components/FoundationSurface.test.tsx`: the Existing Scenario panel renders below Purpose and above the props table; typing + committing (blur) calls `setExistingScenario` exactly once per gesture (not per keystroke); a `readOnly` viewer sees rendered content with no toolbar and no click-to-edit affordance (mirrors the existing Purpose readOnly assertions in this file).
10. **e2e** — extend `e2e/foundation.spec.ts`: enter existing-scenario prose with a mix of bold/italic/underline/a bulleted list/indent, reload, formatting persists; export the project, import into a fresh project, formatting is preserved.

Standing gate: `npm run verify:fast` green (`npx tsc --noEmit`, `npx eslint . --quiet`, `npx stylelint`, vitest) plus `npm run e2e` for item 10.

## Acceptance criteria

- [ ] Tests 1–9 above pass; e2e (10) passes.
- [ ] `npm run verify:fast` green — no new `tsc`/`eslint`/`stylelint` errors (STYLE_GUIDE §11 token enforcement and `eslint.config.js:100-145`'s "wrap third-party primitives in `ui/`" rule both apply to the new editor component).
- [ ] All six ripple registries touched or explicitly verified with a passing test (not just read and assumed) — schema, migration, envelope (+ FORMAT_VERSION bump), electricProtocol, syncDelta (inherited, verified), mutations/write-store (write-store verified as a no-op).
- [ ] No `dangerouslySetInnerHTML` of a raw `existingScenario` string anywhere in the diff.
- [ ] A viewer (035 `readOnly`) sees rendered formatting with no toolbar and cannot edit.
- [ ] Undo/redo: one command-log step per commit gesture (not per keystroke); redo restores formatting exactly.

## References

`docs/SPEC.md:40` (Purpose named "rich-text" in the glossary — prior intent), `:69` (tier1_purpose data model) · `docs/SITEMAP.md:14,60` (Foundation route, empty context bar) · `docs/STYLE_GUIDE.md` §1 (in-place editing), §2.1–2.2 (panel/hairline chrome, command-button variant), §3 (Inter body prose), §4 (0-radius, focus ring), §5 (sparse Lucide icons), §10 (a11y baseline), §11 (token/component enforcement) · `docs/issues/done/013-tier1-foundation.md` (Foundation slice, Purpose's `MultilineEdit` precedent) · `docs/issues/done/075-design-tier-inbound-deltas-not-materialized.md` (per-table `*AppliedAt` refresh-signal pattern, reused as-is here — no new signal needed) · **ripple precedent**: commit `6f618c7` "fix(078) step 2: denormalize workspace_id onto parameters/bindings/tier2_entries" and `docs/issues/078-electric-serves-stale-empty-shapes.md` (the six-registry template this issue's checklist follows) · code: `src/db/schema.ts:104-120`, `src/db/migrations/0012_electric_replica_identity.sql:24`, `src/domain/projectEnvelope.ts:34,66-74,346-397,462-474`, `src/sync/electricProtocol.ts:61-69`, `src/domain/syncDelta.ts:21,65-67,96-101`, `src/db/mutations.ts:882-905`, `src/server/writeApi/store.ts:290-292,502-536`, `src/store/tier1.ts` (whole file), `src/components/FoundationSurface.tsx:55-198`, `src/components/ui/multiline-editor.tsx` (interaction-contract precedent, not reused directly), `eslint.config.js:100-145`, `.stylelintrc`.
