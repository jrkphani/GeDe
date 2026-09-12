# GeDe — Text-Oriented Spreadsheet PRD: Narrative Digest (§1–§23)

Source: `handover/specs/Text-Oriented Spreadsheet PRD.dc.html` (package 2026-09-12; header reads "Specification · sections 1–24 · 135 requirements · v1 scope" — the "135" is a stale figure, the table holds 172). §24 (172 numbered requirements) is captured separately in `REQUIREMENTS.md`. Items struck through in the source are marked **[removed in v1]** below. The 2026-09-12 package added two §24 blocks with no §1–23 prose behind them; they are digested at the end of this file.

## What the product is

GeDe is a spreadsheet whose primary datum is *text*, not numbers. Cells hold rich-text values; string operations (Split, Extract, Replace, Concat…) are first-class, expressed through an object-oriented dot-notation (`@Column.Method(args)`) rather than classic formulas. Tables float on an infinite, zoomable canvas that is *also* the cell grid, so spatial position and A1 address are the same fact. Derived data keeps its lineage visible (nested child rows, derived-column pipelines, DAG edges), and a "graph" feature renders any table as an N-dimensional context matrix. Target platform is a collaborative web app on AWS (ARM-only), with Cognito passwordless identity, iCloud-Numbers-style sharing, and first-class support for English (US/UK/India), Tamil, Hindi and Telugu.

## §1 System Architecture & Data Model

- **State engine:** a Directed Acyclic Graph (DAG) replaces the 2D grid. Each cell is a node; string operations are edges, so downstream updates flow when parent data changes.
- **Frontend:** React + TypeScript.
- **Data structure:** cells store rich-text JSON objects (Quill-Delta / Slate-node style), not plain strings, so formatting survives text transformations.
- **AI Translation Layer** (LLM endpoints such as Amazon Bedrock translating natural language to regex/classification rules) — **[removed in v1]**.

## §2 UI & IDE-Style Autocomplete

- Typing `@` opens an autocomplete dropdown of available columns / parent cells (e.g. `@RawNotes`).
- Typing `.` after a reference cascades a hierarchical menu of string methods (`@RawNotes.Extract`).
- Selecting a method opens an inline declarative **Property Panel** to define arguments without syntax (e.g. `.Replace()` asks for "Target" and "Replacement").

## §3 Rich Text & Styling Engine

- Inline marks: bold, italic, underline, strikethrough, superscript, subscript.
- Font family, font size, text colour (hex/RGB), highlight/background colour.
- Semantic presets: **Title** (primary header scale/weight), **Heading** (secondary), **Body** (default).
- **Format-aware operations:** formatting is query logic — `@Column.Extract(Style="Highlight:Yellow")` pulls only highlighted terms into a new column.

## §4 Hierarchical Data Structures

- **Nested row hierarchies:** when a cell is divided (`@Paragraph.Split(". ")`) the resulting array renders as collapsible child rows beneath the parent cell.
- **Column lineage (pipelines):** derived columns group visually under their parent column (A → B → C share a horizontal audit trail rather than being independent silos).

## §5 Abstracted Pattern Matching

- **Smart Chips:** pre-built drag-and-drop regex rules for corporate data types — Email, Date, Currency, Company Entity. (Per §20/§21 these ship as static, pre-validated RE2-compatible patterns run in a Web Worker with a timeout.)
- **Flash Fill (inference):** extraction rules generated from output examples the user types in adjacent columns.
- **Natural Language → Regex** GenAI text box — **[removed in v1]**.

## §6 Canvas & Rendering Engine

- **Infinite virtual workspace:** coordinate-based infinite plane (Figma/Miro-like), not a fixed page.
- **Viewport virtualisation:** target 60 fps across thousands of text nodes; only cells within the viewport are rendered. Original text proposes HTML5 Canvas/WebGL (PixiJS, React Flow) with spatial hashing/quadtrees — both **revised in §20** (see below).
- **Semantic zooming:** *micro* (zoomed in) shows full rich text, inline styling and cell action menus; *macro* (zoomed out) fades cell text and surfaces block titles, pipelines, table structure.

## §7 Grid & Border Logic

Visual structure is decoupled from data relationships and fully customisable:

| Element | Visibility | Styling |
|---|---|---|
| Global gridlines | Contextual / on-demand | Lightweight canvas background pattern; toggle Off / Light / High Contrast, or show only while dragging/resizing a table |
| Table boundaries | Explicit / object-level | Tables are independent floating containers; CSS-equivalent stroke borders (solid, dashed, weight, colour) |
| Cell borders | Inherited / custom | Cells or row hierarchies may override the table's border to separate parent data from extracted child output |
| Connecting edges | Algorithmic | Bezier or orthogonal lines toggled on to show DAG flow from parent to derived table |

## §8 Conditional Formatting

Triggers: **Lexical** (contains / does not contain), **Metrics** (character or word count thresholds), **Pattern-based** (matches / fails a Smart Chip, e.g. flag rows red that fail "Is Valid Email"), **Semantic (AI-driven)** — **[removed in v1]**. Outputs: override background colour, borders, or apply rich-text presets (e.g. strikethrough + grey for "Archived").

## §9 Advanced Filtering & Lexical Sorting

- Sort modes: Standard A–Z / Z–A; **By Volume** (character or word count); **By Frequency** (how often the string appears in the dataset).
- **Faceted filtering:** rows containing specific extracted entities (e.g. where `@Row.Extract.Date()` is present).
- **Fuzzy filtering:** tolerates typos/variations ("Singapore" also returns "Sngapore").

## §10 Viewport Anchoring (Freeze Panes)

Freezing = pinning to the viewport. Any table, column or parent cell can toggle **Pin to Viewport**; pinned elements detach from canvas coordinates and anchor to the screen edge (sticky header / floating widget). A semi-transparent **ghost** outline remains at the original canvas position to preserve DAG context.

## §11 Workbook & Sheet Model

- A document is a workbook of sheets; each sheet is an independent infinite canvas holding any number of tables.
- **Sheet tabs:** persistent strip below the toolbar listing ordinal, name and table count; selecting swaps canvas contents and resets viewport to the sheet's origin; trailing `+` appends an empty sheet.
- **Empty sheets** still show the coordinate plane with an explicit "place first table" affordance.
- **Child sheets:** opening a graph context creates a sheet named after its symbol containing a shaped table for that context's children (§19).
- **Cross-sheet lineage:** DAG edges whose ends live on different sheets are reported numerically in the inspector rather than drawn.

## §12 Coordinate Grid & Cell Addressing

- **Lattice:** uniform lattice of fixed column width and row height underlies the plane (§24 fixes it at **160 × 22 px**). Cell **A1** is the top-left origin; the canvas extends right and down only and cannot be panned above or left of A1.
- **Rulers:** column letters along the top, row numbers down the left, rendered in canvas space so they track pan and zoom exactly; each table column header also displays its grid letter.
- **Snapping:** table origins, column widths and row heights snap to whole lattice units — a table is always addressable and resizing never desynchronises ruler from data.
- **Frozen header columns:** per-table count of leading frozen columns; shaded, separated by a heavier rule at the freeze boundary, and carried into the pinned-viewport panel (§10).
- **Address resolution:** every cell has a computed A1 address surfaced in the formatting bar with its column name; addresses recompute on row/column insert, delete, hide, and when wrapped rows occupy two lattice rows.

## §13 Formula Layer

Typing `=` opens formula entry with a menu of forms. Spatial and semantic references are interchangeable in one expression.

| Form | Behaviour |
|---|---|
| `=Concat(a, b, …)` | Joins arguments end to end; each may be a cell address, an `@` entity path, or a quoted literal |
| `=A2, D5` | Lists the values at the grid addresses, comma separated |
| `=Sum(B2:B14)` | Adds numeric values in a range, address list or `@` paths; only available when referenced cells carry Number or Currency format (§22); text-formatted cells make the formula an **error**, never a silent zero |
| `=@Group.Entity, @Group.Entity` | Resolves entity paths anywhere in the workbook, separated by whatever literal text is typed between them |

- **Entity autocomplete:** `@` inside a formula opens a dropdown of every addressable entity in the workbook as a dotted path qualified by parent row; selecting inserts at the cursor and keeps the editor open.
- **Live evaluation:** results track sources; formulas may reference formulas; a depth guard reports circular references (`⚠ circular`).
- **Presentation:** resolved value with a reference badge, expression on a secondary line; reopening restores the expression.
- **Reference highlighting:** while selected/edited, every cell read is outlined in the colour of its operand position (first, second…); ranges draw as one block; outlines follow pan/zoom and clear on deselect.

## §14 Cross-Table Relationships

- **Row pulls:** a table mirrors rows from any table on any sheet, filtered by a contains-expression; the receiving column renames itself after its source; values stay live.
- **Mapping columns:** a column bound to a target column elsewhere; its cells become one-click pickers over the target's distinct values (governed many-to-one mapping).
- **Reference cells:** any cell can become a direct reference to another table's cell via the `@` entity index, without a formula.

## §15 Row Grouping (Categories)

- **Group by column:** rows sharing a value collapse into category bands stating value and row count; bands are collapsible.
- Grouping applies **after** sort and filter, so order and predicate are preserved within bands.
- **Manual hierarchy:** independently, any row can be promoted or nested one level relative to the row above (the §4 outline).

## §16 Direct Manipulation & Keyboard Model

- Single click arms a cell; double click or **Enter** opens editing; typing any character overwrites; **Escape** cancels; **Delete** clears.
- **Tab** and arrows move selection, wrapping at row ends; moving past the final row appends a new row and places the cursor in it.
- Modifier shortcuts apply inline formatting and adjust hierarchy depth.
- **Structural affordances:** add-row strip beneath the last row of the selected table and add-column stub at its right edge, each exactly one lattice unit.
- **Resizing:** column dividers resize columns; a corner handle scales the whole table; both snap to the lattice.

## §17 Contextual Menus

Right-click on column header or cell opens a desktop-spreadsheet-style menu: checkmarked toggles, separated groups, unavailable commands **disabled rather than hidden**.

- **Column header:** freeze header columns; sort asc/desc/options; quick filter/filter options; add/remove/configure category; add column before/after; delete; hide; fit width to content; clipboard group; wrap text.
- **Cell:** freeze header rows and columns; add row above/below; add column before/after; delete row/column; sort/filter/category options; merge controls; cut, copy, copy snapshot, paste, paste and match style, clear all; wrap text.

## §18 Inspector Panels

Collapsible right-hand inspector with two modes selected from the window chrome. The chrome bar carries document identity, grouped tool clusters (icons + tooltips), zoom with fit-to-canvas, and inspector toggles. **Each command has exactly one home** (no toolbar/inspector duplication); unimplemented controls render disabled.

- **Format — Table:** table styles; title/caption visibility; header row, header column, footer row counts (each adds/removes a band); row/column counts that insert/delete structure; outline; gridline density; alternating row colour; row/column sizing with fit-to-content.
- **Format — Cell:** data format, fill, positional border matrix (all edges, any single edge, outline, paired edges, none) at hairline / strong / accent weight; conditional highlighting rules evaluated against cell text.
- **Format — Text:** font family; four-step weight scale; size; inline marks; semantic character styles; text colour; horizontal and vertical alignment; wrapping.
- **Format — Arrange:** stacking order, canvas layout alignment, size, position in pixels **and** grid address, viewport pinning, DAG edge visibility.
- **Format — Derive:** cross-table relation, derived-column composition, hierarchy controls, pipeline audit list.
- **Organize:** Categories, Sort, Filter — each with an enable toggle, add-control, and the §9 lexical/semantic modes.

## §19 Graphs — the N-Dimensional Context Matrix

A graph renders a table as an N-dimensional matrix: chosen columns are **dimensions**, each column's distinct values are that dimension's **parameters**, each row is a **context** (one coordinate per dimension). The graph is **read-only**; all authoring happens in cells.

- **Adding:** `+ Graph` in the toolbar (beside `+ Table`), "Graph this table" in a table's context menu, or the empty-sheet menu (Table / Shaped table / Graph). Every add produces a **linked pair** — a **ring** and a **coverage grid** — side by side below the sheet's tables, sharing table, dimensions and slice; position and size are per object.
- **Pointing mode:** an unbound graph outlines every table in dashed accent with an instruction banner; clicking a table binds; **Esc** cancels. "Add shaped table" creates a pre-shaped table (Dimension A · B · C · Notes) and binds in one step.
- **Binding panel (Graph inspector tab):** source table with Re-point; checklist of source columns as dimensions with distinct-value counts; Add dimension column; coverage axis chips and pinned values; context count; Remove graph. Derived, linked and pulled columns are **not** offered — a context must be typeable back into its table.
- **Live derivation:** recomputed on every change; symbols (α β γ …) generated by row order; a row bound on every dimension is **complete** (filled node); partially bound is a **draft** (hollow, dashed). No separate "documented" state.
- **Ring:** one arc per dimension from a fixed palette, a dot per parameter; contexts on concentric orbits (1, 6, 12, 18 …); header states distinct covered tuples over total tuple space.
- **Coverage:** one 2-D slice — two dimensions on axes chosen by chips, all others pinned; pins default to the selected context's bindings.
- **Emphasis:** hover mutes non-adjacent items across the whole pair, draws spokes from context to parameters, and lights the source row; selection dims softly.
- **Write-back:** click a node → select its row; click an empty coverage cell → append a row pre-filled with that tuple; double-click a node → new sheet named after the symbol with a shaped child table.
- **Geometry:** canvas objects on the lattice; drag header to move, corner handle to resize, both snapping; ring scales to fit its box; default size **6 × 28 units**; Fit-to-canvas frames tables and graphs together.

## §20 Technical Architecture Review

Each §1/§6 stack choice is stress-tested against §11–§19 with a verdict of keep / narrow / change:

| Choice | Verdict | Recommendation |
|---|---|---|
| DAG state engine | **narrow** | Incremental reactive graph: nodes keyed by **stable cell ids, never A1**; pull-based lazy evaluation with dirty marking; topological batching per input event; explicit cycle detector surfacing `⚠ circular`. Candidates: Preact Signals, Jotai, or a HyperFormula-style dependency graph. Address→id resolution is a separate index rebuilt on structural edits. |
| React + TypeScript | **keep** | For chrome/inspector/menus. Grid body renders through a virtualised layer (viewport rows/cols + one margin) with memoised row components keyed by cell id; formula evaluation runs outside React. |
| Rich-text JSON (Quill/Slate) | **change** | Adopt a **ProseMirror-family schema (ProseMirror or Tiptap)**: typed marks, stable transform algebra, mature contenteditable. Specify a small text-transform library on marked strings that preserves marks through slicing/concatenation; every §13 method is defined on that type. |
| Amazon Bedrock NL→regex | **removed** | Latency, non-determinism, hallucinated patterns, catastrophic backtracking DoS. Smart Chips remain as pre-validated RE2-compatible patterns in a Web Worker with timeout. If it returns: model returns pattern + test cases, client validates, compiled rules stored and versioned. |
| Canvas/WebGL (PixiJS, React Flow) | **change** | **DOM-first**: one CSS-transformed layer for tables and graphs, virtualised. Canvas reserved for gridlines, ruler backgrounds, and DAG edges once they number in the hundreds (separate non-interactive layer). WebGL only if profiling shows the DOM layer missing budget. |
| Spatial hashing / quadtrees | **change** | **Sparse lattice index**: two ordered maps (column→objects, row→objects) plus per-object grid bounds; visible set = objects intersecting viewport row/column ranges; same index serves A1 resolution, hit-testing and pointing mode. |
| Semantic zooming | **keep** | Three tiers (micro, meso, macro) as scale bands; skip cell text layout below the macro band; quantise scale into buckets so re-render happens on band crossings, not every wheel tick. |

**Choices the original spec did not make:**
- **Collaboration/persistence:** a CRDT document (**Yjs or Automerge**) holding tables, cells, formats, graphs, sheet order; gives offline edits, undo, presence. The DAG evaluates over CRDT state and is not itself persisted.
- **Stable identity:** rows, columns, tables, sheets, graphs need position-independent ids; every §13/§14 reference stores ids; A1 is a presentation projection.
- **Formula language:** write a grammar (arguments, quoting, escaping of `@` paths containing spaces/dots, function names) and a reference parser with error positions.
- **Workers:** regex execution, fuzzy matching, bulk re-evaluation off the main thread; engine API message-shaped from the start.
- **Testing:** property-based tests for the text-transform algebra (marks survive every op) and the dependency graph (evaluation order = topological order; no stale reads after structural edits); golden-file tests for ring and coverage layouts.
- **Performance budgets:** **16 ms** keystroke→visible update at 1,000 visible cells; pan/zoom at **60 fps with 10,000 cells** on the sheet; formula recompute **< 50 ms** for a 500-row dependent chain.

## §21 Platform, Delivery & Access

- **Compute — ARM throughout:** every runtime targets AArch64: app servers/API on Graviton (Fargate ARM or EC2 c7g/m7g), Graviton RDS/Aurora, Graviton ElastiCache. Images built `linux/arm64` only, no multi-arch manifests. Any native dependency without an ARM build is disqualifying.
- **No LLM services:** §1 AI layer, §5 NL→regex, §8 semantic triggers are out of v1; no Bedrock or model endpoints provisioned.
- **CI/CD on AWS CodeBuild:** repo may stay on GitHub but **no GitHub Actions**; CodeBuild via CodeStar/GitHub App connection on push and PR webhooks. Fleet: `ARM_CONTAINER`, `aws/codebuild/amazonlinux-aarch64-standard`. Stages: (1) **Verify** on every PR — install, type-check, unit + property tests, lint, bundle-size budget; (2) **Build** on main — arm64 image to ECR, content-hashed web bundle to S3; (3) **Deploy** — CodePipeline promotes the same artefacts staging → production with a manual approval gate; (4) **Post-deploy** smoke tests; failure rolls the ECS service back. IaC in **CDK (TypeScript)** including the CodeBuild projects. Cost controls: S3 dependency cache, ECR layer cache, PR builds limited to Verify, small ARM instances, no always-on runners.
- **Responsive behaviour:** Desktop **≥ 1200 px** — chrome bar, toolbar, sheet tabs, canvas, inspector rail open by default; full editing. Tablet **768–1199 px** — inspector collapses to strip / opens as overlay, tool clusters icon-only; full editing, context menus by long-press. Phone **< 768 px** — single column, sheet switcher as bottom bar, full-bleed canvas with pinch zoom, no inspector/toolbar; **read-only** (pan, zoom, select to view value/formula, follow references, expand groups, switch sheets); chrome shows "View only on phone". (§24 RESP later restates breakpoints as 480/768/1024/1440, with desktop from 1024.)
- **Identity:** Amazon Cognito user pool with email + password and passkeys; optional Sign in with Apple and Google federation; short-lived tokens refreshed silently; app opens to the document list. (§24 AUTH tightens this to **passwordless by contract** — no password ever stored or accepted.)
- **Sharing (Numbers-on-iCloud style):** a Share button opens one sheet — Who can access (invited only / anyone with link), Permission (can make changes / view only), invite field for emails, participant list with per-person permission and remove, copy link, Stop sharing. Title row shows "Shared" with avatars while any collaborator exists.
- **Presence:** collaborators' selections as coloured outlines with name tags, carried by the CRDT.
- **Enforcement:** permissions checked **server-side on every sync message**; view-only participants receive the stream but edits are rejected and the client never enters edit mode.

## §22 Column Data Formats & Numeric Formulas

The Cell inspector's Data Format is a real per-column type system with cell-level override.

| Format | Options | Behaviour |
|---|---|---|
| Automatic | Infers Number, Currency, Date or Text | Default; inference never rewrites stored text, only picks display and numeric parse |
| Text | Case presets: Title Case, UPPERCASE, lowercase, Trimmed | Never numeric; excluded from `=Sum()` |
| Number | Decimal places 0–6, thousands separator, negative style (− / parentheses / red), percentage | Right-aligned; stored value is the parsed number; display re-renders on format change |
| Currency | Code (**SGD default**, then MYR, PHP, IDR, USD, INR), symbol position, decimals, accounting style | Right-aligned; `=Sum()` across mixed currencies is an **error**, not a conversion |
| Date | Pattern (**D MMM YYYY default**, DD/MM/YYYY, YYYY-MM-DD, MMM YYYY), optional time | Sorts chronologically regardless of pattern; Date Smart Chip populates this format |

- **Column scope:** set on the column header (inspector or header menu), inherited by every cell; cell may override; appended rows inherit.
- **`=Sum()`:** accepts a range (`B2:B14`), address list, `@` paths, or a whole column (`B:B`); offered in the `=` dropdown only when the selected cell's column is Number or Currency; result takes the operands' format; blanks count as zero; a Text cell in range produces `⚠ text in range` on the result and highlights the offender.
- **Reference highlighting:** as §13 — range as one outlined block, discrete addresses individually, colour-keyed; during editing the outline updates live and clicking canvas cells inserts their addresses at the cursor.
- **Footer totals:** a Number/Currency column may show `=Sum()` of visible rows in the table footer, respecting the active filter.

## §23 Languages, Keyboards & Locale

Input from English (US, UK, India), Tamil, Hindi and Telugu keyboards; cell text is Unicode throughout.

| Locale | Keyboards | Number · currency | Date (short · long) |
|---|---|---|---|
| en-US | US QWERTY | 1,234,567.89 · $ leads | 9/12/2026 · 12 Sep 2026 |
| en-GB | UK QWERTY (£, ", @ swapped) | 1,234,567.89 · £ leads | 12/09/2026 · 12 Sep 2026 |
| en-IN | India QWERTY (₹ on AltGr-4) | 12,34,567.89 lakh/crore · ₹ leads | 12/09/2026 · 12 Sep 2026 |
| ta-IN | Tamil99, InScript, phonetic (Google/Apple) | Indian grouping · ₹ | 12/09/2026 · 12 செப். 2026 |
| hi-IN | InScript, Remington, phonetic | Indian grouping · ₹ | 12/09/2026 · 12 सित॰ 2026 |
| te-IN | InScript, Apple Telugu, phonetic | Indian grouping · ₹ | 12/09/2026 · 12 సెప్టెం 2026 |

- **Composition:** editor listens to `compositionstart`/`compositionend` and ignores Enter, Tab and arrows while composing (also `keyCode 229` and `isComposing`) so a half-formed conjunct is never committed or split.
- **Shortcuts by physical key:** ⌘B/⌘I/⌘U and hierarchy keys resolve from `event.code` (`KeyB`), not the produced character.
- **Typing to edit:** any printable `\p{L}\p{N}\p{P}` begins overwriting; `Process`/`Dead` keys open the editor and hand composition to the IME.
- **Rendering:** font stack falls back to Noto Sans Tamil, Devanagari, Telugu; root element carries `lang` for the active locale.
- **Sorting/search:** `Intl.Collator` for the active locale (numeric, base sensitivity); fuzzy filter operates on grapheme clusters, not UTF-16 units.
- **Number/date:** `Intl.NumberFormat` / `Intl.DateTimeFormat`; Indian locales group lakh/crore; localised month names in long form.
- **Chrome and formulas:** function names (`Concat`, `Sum`) and A1 addresses stay ASCII in every locale; `@` entity paths may contain any script; menu/inspector copy ships in English for v1 with string tables ready for translation.
- **Picker:** a locale control in the chrome switches language, keyboard expectations and formats together and persists per user.

## §24 addenda (package 2026-09-12): first-run tour and delete / archive

Two blocks were appended to §24 in the 2026-09-12 handover. Neither has narrative prose in §1–23; the binding wording is the 25 rows in `REQUIREMENTS.md` (ONB-01..14, LIB-D1..11). The direction exploration behind the tour is `handover/specs/GeDe First Run.dc.html` (two options, 1a coachmarks and 1b checklist rail; **1a is the one shipped**). Where that spec and the PRD differ — the spec says four steps and "Help ▸ Guided tour", the PRD says five steps and the help control in the library header — the PRD wins.

### First-run guided tour (ONB)

"Five steps over the live interface. Written for users fluent in iCloud Numbers, so it teaches only what Numbers does not."

- **Sample workscape.** Every library holds `Q3 Delivery — Guided sample`, pinned above all other rows, flagged Sample in the shared column, and seeded with the tables, formulas and dates the tour refers to (ONB-01). It cannot be deleted or archived; its toolbar action is disabled with an explanatory tooltip (LIB-D10).
- **Trigger and state.** The tour starts on the user's first arrival at the library after authentication, only while the per-user completion flag is unset; users arriving from a shared invitation get it too (ONB-02). Completing step 5 or skipping at any step sets a **per-account, server-side** flag — not per device or browser (ONB-03, ONB-07). Replay from the help control in the library header clears the flag and restarts at step 1 (ONB-08). Below 768 px the tour does not run and the flag stays unset so a larger viewport still receives it (ONB-13).
- **Steps, in order, each advancing only when the user performs the action — there is no Next control** (ONB-05): open the sample; write a cross-table reference; add a context graph; open Find and search; invite by email. Step 2 has no single target (formulas are typed in a cell) so its card centres in the viewport with no spotlight (ONB-06).
- **Spotlight.** Each other step spotlights its target by live bounding box, re-measured on scroll, resize, zoom and any layout change, with the rest of the page dimmed. The dim layer never intercepts pointer events; the spotlit element stays fully operable and the tour never blocks an edit (ONB-04, ONB-11).
- **Card.** Step counter, progress dots, title, instruction body, a comparison note, and the pending action rendered in amber; the card flips above its target when there is no room below (ONB-09). Copy names the iCloud Numbers equivalent, then the difference; nothing Numbers already teaches is taught; context graphs, having no Numbers analogue, are introduced on their own terms (ONB-10). All strings live in the same message catalogue as the rest of the UI and render in all six locales (ONB-12).
- **Completion.** Finishing step 5 confirms completion and states where the tour can be replayed (ONB-14).

### Library: delete and archive (LIB-D)

"Deletion is conditional on sharing history. A workscape that has ever had a participant can only be archived, so that no one loses access to a document they were given."

- **Delete vs archive.** A workscape with no participants and no active share link is deletable; the toolbar action reads Delete (LIB-D1). One that has ever been shared is not: the same toolbar slot becomes Archive with a tooltip saying shared workscapes cannot be deleted (LIB-D2). The switch happens the moment the **first invitation is accepted**, not when it is sent; revoking all access restores deletability (LIB-D4).
- **Archive semantics.** Archiving preserves every participant's access and all share links; it removes the workscape from the owner's Recents, Browse and Shared views only, and participants see no change (LIB-D3). The sidebar gains an Archived view, each row with Unarchive; archive has no expiry (LIB-D6).
- **Recently Deleted.** Deleting moves the workscape there, recoverable, with 30-day retention and automatic purge (LIB-D5). The view offers per-item Recover, Recover All and Delete All (LIB-D7); Delete All is permanent and says so before proceeding (LIB-D8).
- **Feedback.** Every delete, archive, recover and unarchive raises a confirmation; reversible ones carry Undo, permanent ones state they cannot be undone (LIB-D9).
- **Shared state.** Archive and trash are document states, not library-local flags; a second client on the same account sees the same state without a reload (LIB-D11).

### Open items from the changelog, and how the build resolves them

The package `CHANGELOG.md` lists three items the prototype fakes in memory. The PRD rows above already settle each one; this is the implementation the build must take.

| Open item (changelog) | Binding rows | Resolution |
|---|---|---|
| ONB-3 and LIB-D10 need server-side state; the prototype fakes both in memory (`localStorage['gede.tour.done']`, in-memory `lib.trashed` / `lib.archived`). | ONB-02, ONB-03, ONB-07, ONB-08, ONB-01 | A per-user `tour_done` flag on the server (account-scoped, readable at library load, cleared by Replay). The sample workscape is created server-side per user at account creation, not seeded by the client, so it is present in every library including one first reached from a shared link. |
| Archive and trash must be document states, not library-local flags — a second client must see the same state. | LIB-D3, LIB-D5, LIB-D6, LIB-D11 | `archived_at` and `deleted_at` are nullable timestamps on the document record (migration; never both set). Library views filter on them; a 30-day purge job keys off `deleted_at`; state changes propagate to other clients through the same channel as any other document change. |
| Deletability flips when the first invitation is **accepted**, not when it is sent. | LIB-D1, LIB-D2, LIB-D4 | An `ever_shared` flag on the document, set server-side when the first invitation is accepted (or a share link is first used), never by sending. Delete is offered only while `ever_shared` is false and there is no active share link. |

One wording tension to record: LIB-D2 says a workscape that has *ever* been shared must not be deletable, while LIB-D4 says revoking all access must *restore* deletability. The build follows LIB-D4 as the specific transition rule — `ever_shared` is cleared when the last participant is removed and no share link remains — and the PR that implements it must state so.
