# GeDe PRD §24 — Detailed Functional Requirements (verbatim)

Source: `handover/specs/Text-Oriented Spreadsheet PRD.dc.html`, section 24. Text is verbatim; inline `code` in the source is rendered as backticks.

> Every interaction in the product, stated as a testable requirement. Each carries an ID for traceability from design through implementation to QA. Must is binding; should is a default that may be overridden with a recorded reason.

> Prefixes: AUTH identity · LIB library · DOC document shell · GRID table and cells · FMT formats · FX formulas · REF references · HIER hierarchy · FIND search · KEYS shortcuts · SORT sort, filter, group · MENU context menus · INSP inspector · GRAPH context graphs · SHARE sharing and collaboration · LOAD loading and sync · I18N language · A11Y accessibility · RESP responsive · ONB first-run onboarding · LIB-D delete and archive.

## AUTH — Identity and access (10)

_Cognito user pool; passwordless by contract. No password is ever stored or accepted._

- **AUTH-01** — Entry: Unauthenticated visit to any URL must render the sign-in screen and retain the requested path for post-authentication redirect.
- **AUTH-02** — Mode switch: Sign in / Create account is a segmented control; switching must preserve a typed email and reset the flow to the email step.
- **AUTH-03** — Email step: Continue is disabled until the field contains a syntactically valid address. Enter submits. Sign-up additionally collects a display name.
- **AUTH-04** — Method step: For a known email, offer passkey first, then “Email me a one-time code”. The address is shown with a Change action returning to the email step.
- **AUTH-05** — Passkey: Invoke WebAuthn. On success, sign in. On cancel, remain on the method step with no error. On unsupported device, hide the passkey option entirely rather than failing.
- **AUTH-06** — Code step: Six digits, numeric input mode, autocomplete `one-time-code`. Non-digits are stripped. Verify is disabled below six digits. State the 10-minute expiry and offer Resend. _Amended by ADR-050: the length is the code's, not the step's fixed six — Cognito's passwordless sign-in code (EMAIL_OTP) is eight digits and lives for the 10-minute auth session; its sign-up verification code is six and lives 24 hours. The step takes the length from the auth step, Verify is disabled below that length, the field accepts up to eight digits and never truncates a code, and the expiry stated is the code's own._
- **AUTH-07** — Passkey offer: After a code sign-in, offer to create a passkey on this device. Declining must not repeat within 30 days.
- **AUTH-08** — Apple: Sign in with Apple is available at both the sign-in and sign-up steps and federates into the same user record by verified email.
- **AUTH-09** — Session: Tokens held in memory only, refreshed silently. Expiry returns to sign-in with the document path retained. Sign out clears local state and revokes the refresh token.
- **AUTH-10** — First run: A new account lands in the library with an empty state and a single primary action to create the first workscape.

## LIB — Workscape library (10)

_The document chooser. Four views over one collection._

- **LIB-01** — Views: Recents (grouped by recency), Browse (flat, sortable), Shared (grouped by owner, then Shared by Me), Recently Deleted. The active view is highlighted in the sidebar.
- **LIB-02** — Row: Each row shows the document icon, name, kind, size, modified date and sharer. A single click selects; a double click opens; Enter opens the selection.
- **LIB-03** — Selection: Exactly one row selects at a time in v1. Selection enables the toolbar actions and reveals the row overflow control.
- **LIB-04** — Search: Filters the active view by name, case-insensitive, as typed. An empty result shows “No workscapes match”, never a blank page.
- **LIB-05** — Sort: Browse and Shared offer by Name and by Date; the choice persists per user. Recents is always reverse-chronological.
- **LIB-06** — Create: The + control creates an untitled workscape, opens it immediately, and places the caret in the title.
- **LIB-07** — Participants: Share on a selected row, or the row overflow, opens the participants sheet listing everyone with their permission; the owner is labelled and cannot be removed.
- **LIB-08** — Deleted: Recently Deleted holds items for 30 days with Recover All and Delete All; both are disabled when empty. Empty state reads “No items”.
- **LIB-09** — Storage: No per-user quota is shown or enforced — storage is an operator concern (Architecture §6).
- **LIB-10** — Responsive: Below 900 px the sidebar hides behind a control, Kind and Shared columns drop, and the date shortens to its numeric form.

## DOC — Document shell and sheets (7)

- **DOC-01** — Chrome: The GeDe mark returns to the library. The title row shows the document name, Shared with participant avatars, and — on phone — the read-only note.
- **DOC-02** — Toolbar: Grouped tool clusters with tooltips: add table, row, column; pin and DAG edges; gridlines, filter, sort; zoom with fit; Format and Organize inspectors. A command must appear in exactly one place.
- **DOC-03** — Sheet tabs: Ordinal, name and object count per sheet. Selecting a sheet swaps canvas contents, clears cell and graph selection, and resets the viewport to A1. A trailing + appends a sheet at the end.
- **DOC-04** — Canvas: Drag pans; ⌥scroll and the zoom pill zoom. Pan clamps so A1 remains the top-left; the plane extends right and down without bound.
- **DOC-05** — Semantic zoom: Micro (≥ 0.48) full rich text; meso structure; macro (< 0.30) block titles only, cell text not laid out at all.
- **DOC-06** — Rulers: Column letters along the top and row numbers down the left, in canvas space so they track pan and zoom exactly; each column header also shows its grid letter.
- **DOC-07** — Fit: Fit computes the bounds of all tables and graphs on the sheet and frames them together.

## GRID — Tables, cells and structure (11)

_The lattice is 160 × 22 px. Geometry and addressing are one fact._

- **GRID-01** — Snapping: Table origins, column widths and row heights snap to whole lattice units. Resizing must never desynchronise the ruler from the data.
- **GRID-02** — Addressing: Every cell carries a computed A1 address, shown in the inspector. Addresses recompute on insert, delete, hide and wrap.
- **GRID-03** — Selection: Single click arms a cell with an inset selection ring in live amber. Escape clears.
- **GRID-04** — Editing: Double click or Enter opens the editor; typing any printable character overwrites; Escape cancels; Delete clears. Derived, linked, pulled and group cells are not editable.
- **GRID-05** — Traversal: Tab / Shift-Tab and arrows move, wrapping at row ends. Moving past the final row appends a row and places the cursor in it.
- **GRID-06** — Commit: Enter commits and moves down; Tab commits and moves right; blur commits. Committing must never occur during IME composition.
- **GRID-07** — Add row · column: A dashed add-row strip sits beneath the last row of the selected table; an add-column stub sits at its right edge. Each occupies exactly one lattice unit.
- **GRID-08** — Resize: A divider at each column header resizes that column; a corner handle scales the whole table. Both snap. _Amended by ADR-049 (#167): a divider under each row's handle resizes that row; a divider on a selected band of rows or columns resizes every member proportionally; a double-click (or Enter on the focused divider) fits the column or row to its content; the corner scales widths and heights alike. Everything snaps to whole lattice units; the minimum is one unit each way._ _Amended by ADR-051: with the header row hidden (GRID-11) the column dividers sit in a one-row strip over the first body row, so a column resizes by pointer and keyboard either way; while the table is selected every column boundary shows its divider at rest._
- **GRID-09** — Wrap: Wrapped rows occupy two lattice rows so addressing stays exact. _Amended by ADR-049 (#167): a wrapped row occupies as many whole lattice rows as its content needs (n ≥ 1), measured and stored by the replica that edits it, so addressing stays exact on every replica; wrap is a setting at cell, row, column and table scope; off, text clips at the cell._
- **GRID-10** — Frozen columns: A per-table count shades the leading columns, draws a heavier rule at the boundary, and determines which columns the pinned panel carries.
- **GRID-11** — Header rows · footer: Counts of 0 or 1 show or hide the column-header row and the footer count strip.

## FMT — Column data formats (6)

_Set on the column, overridable per cell._

- **FMT-01** — Kinds: Automatic, Text, Number, Currency, Date. Automatic infers from the typed value and never rewrites the stored text.
- **FMT-02** — Number: Decimal places 0–6, locale grouping, right-aligned. The stored value is the parsed number; changing the format re-renders without re-typing.
- **FMT-03** — Currency: SGD default, then MYR, PHP, IDR, USD, INR. Negative values render in accounting parentheses. Summing mixed currencies is an error, never a conversion.
- **FMT-04** — Date: Parses `D/M/Y` and `Y-M-D`; renders per locale. Sorts chronologically regardless of display pattern.
- **FMT-05** — Invalid: A value that cannot be parsed under an explicit format tints the cell and is excluded from aggregation; it is never silently coerced to zero.
- **FMT-06** — Inheritance: Appended rows inherit the column format. The inspector states the scope of the change before it is applied.

## FX — Formulas (9)

_Typing `=` opens formula entry with a menu of available forms._

- **FX-01** — Concat: `=Concat(a, b, …)` joins arguments end to end. Arguments may be cell addresses, `@` entity paths, or quoted literals.
- **FX-02** — Sum: `=Sum(B2:B14)` accepts a range, a list of addresses, `@` paths or a whole column. Offered only when the column is Number or Currency. Blanks count as zero; a text cell in range yields `⚠ text in range` naming the offender.
- **FX-03** — Lists: `=A2, D5` lists addressed values comma-separated; `=@Path, @Path` does the same for entities with any typed separator.
- **FX-04** — Autocomplete: Typing `@` anywhere in a formula opens the workbook entity index and inserts the dotted path at the cursor, leaving the editor open. _Amended by ADR-054: the index holds every cell of every titled table, listed by its value with the path beneath; a query matches values as well as paths; a row is labelled by its outline column, falling back to its first cell with text; a blank column label is spelled by the column’s grid letter._
- **FX-05** — Click to insert: While editing a formula, clicking another cell inserts its address at the cursor with an appropriate separator.
- **FX-06** — Evaluation: Results track their sources; editing a referenced cell updates every dependent. Formulas may reference formulas; a depth guard reports `⚠ circular`.
- **FX-07** — Presentation: A formula cell renders its value with a reference badge and the expression on a secondary line. Re-opening restores the expression, not the result.
- **FX-08** — Highlighting: While a formula cell is selected or edited, every cell it reads is outlined in the colour of its operand index; ranges draw as one block. Outlines follow pan and zoom and clear on deselect.
- **FX-09** — Set operators: `=Union(a, b, …)`, `=Inter(a, b, …)`, `=Diff(a, b, …)`, `=Comp(a, u)` and `=Cross(a, b, …)` read every argument as a set of the strings in its cells: the text split on commas, semicolons and newlines, each element trimmed and NFC-normalised, empties dropped, duplicates collapsed on first occurrence; equality is exact and case-sensitive. Arguments may be cell addresses, ranges, columns, `@` paths, quoted literals or nested calls, separated by `,` or `;`; a blank cell is the empty set; an Automatic cell splits its stored text as typed; under an explicit format a number, amount or date is one element, spelled locale-independently, so every replica computes the same set, and a cell the format could not parse (FMT-05) contributes its stored text; a list (a `Split` or another set) contributes its items as they are. Union is the elements in any set, Inter the elements in every set, Diff the first set less the union of the rest, Comp the elements of the universe `u` (the second argument; there is no implicit universe) not in `a`, Cross every ordered tuple first-operand-major rendered `(a, b)`. Results keep first-seen order, render comma-separated, feed another set function unchanged (a separator inside parentheses does not split) and an empty result is an empty cell. Union, Inter, Diff and Cross take two or more arguments, Comp exactly two; anything else yields `⚠ Comp takes 2 arguments` in the error family. A Cross past 10,000 tuples is refused from the operand sizes as `⚠ too many tuples` before any tuple is built. Names parse case-insensitively with the aliases Intersect, Intsec, Minus, Compl, Prod, Cart, Product and commit in canonical spelling; the `=` forms menu offers the five wherever Concat is. _Added by ADR-053 (owner-directed, 2026-09-19)._

## REF — References and cross-table relations (5)

- **REF-01** — Entity reference: Selecting an entity from the `@` index turns the cell into a live reference rendered in accent mono with a badge and the path beneath. _Amended by ADR-054: an entity is a cell — a row or any cell of it — listed by its value; the reference binds to that cell’s id._
- **REF-02** — Pull: A table may mirror rows from any table on any sheet, filtered by a contains expression; the receiving column renames itself to name its source.
- **REF-03** — Mapping column: A column may be bound to a target column elsewhere; its cells become pickers over that column’s distinct values.
- **REF-04** — Derived column: Composed as `@Column.Method(args)` through the inspector, shown under a lineage header, recomputing on every upstream change.
- **REF-05** — Guard: Derived, linked and pulled columns are read-only and are not offered as graph dimensions — a context must be typeable back into its table.

## HIER — Row hierarchy (10)

_Manual outline structure, independent of category grouping._

- **HIER-01** — Controls: With a cell selected, the inspector shows the row, its current parent and depth, with Promote (⇤) and Nest (⇥). `⌘]` and `⌘[` do the same from the keyboard.
- **HIER-02** — Validity: A row may nest at most one level deeper than the row immediately above it; deeper nesting is refused and the control renders disabled. Promote stops at depth 0.
- **HIER-03** — Parent resolution: A row’s parent is the nearest row above it at a shallower depth. The inspector states it as “↳ under <parent>”, or “top level — no parent” at depth 0.
- **HIER-04** — Indentation: Depth indents the table’s designated outline column by 15 px per level and prefixes child rows with ↳. _Amended by ADR-052: the outline is drawn in the row’s outline column — the column of the cell that was selected when the row was nested, else the table’s designated outline column, else the first visible column. Presentation only; stored per row; a promote to the top level clears it._
- **HIER-05** — Chevron: Any row with descendants shows a disclosure chevron in the outline column; rotation indicates state. _Amended by ADR-052: in the row’s own outline column._
- **HIER-06** — Collapse: Collapsing a parent hides its entire subtree, not only its immediate children. Collapse all / Expand all act on the whole table.
- **HIER-07** — Split children: Rows produced by `Split()` render as nested child rows beneath their parent and are read-only; they collapse with the parent.
- **HIER-08** — Interaction with grouping: When a table is grouped by a column, group bands take over the outline column and manual depth is preserved but not displayed; removing the grouping restores the outline.
- **HIER-09** — Addressing: Depth changes must not alter A1 addresses — indentation is presentation, not position.
- **HIER-10** — Persistence: Depth and collapse state persist per row in the document and sync to collaborators.

## FIND — Search and replace (10)

_A find bar pinned to the foot of the canvas, in the manner of iCloud Numbers. Scope is the whole workbook plus document names in the library._

- **FIND-01** — Open: `⌘F` or the toolbar magnifier opens the bar, focuses the field and selects any existing query. `⌥⌘F` opens it with the replace field already shown.
- **FIND-02** — Bar: A settings gear, the Find field, a match counter reading “n of m”, previous and next chevrons, and Done. It floats over the canvas and never displaces content.
- **FIND-03** — Scope: Every table on every sheet, cell values, formula expressions and reference paths, graph dimension values, and document names in the library.
- **FIND-04** — Operators: `col:Group` restricts to matching columns; `is:currency`, `is:date`, `is:number`, `is:text` restrict by resolved format. Bare terms match anywhere.
- **FIND-05** — Fuzzy: On by default, tolerating an edit distance of two so “Sngapore” finds “Singapore”. Toggled in the gear menu.
- **FIND-06** — Results: Matches highlight in place on the canvas in amber, the current match more strongly, and the result list in the inspector stays synchronised with the bar.
- **FIND-07** — Navigation: `⌘G` and `⇧⌘G` — or the chevrons, or Enter and Shift-Enter in the field — step through matches, switching sheet and moving the viewport as needed.
- **FIND-08** — Replace: Replace acts on the current match; All acts on every match in scope. Derived, linked, pulled and graph matches are never rewritten and are skipped with a count.
- **FIND-09** — Close: Done or `Esc` closes the bar and clears highlighting; the last query is retained for the session.
- **FIND-10** — Empty: With no match the counter reads “No matches”; the bar never closes itself.

## KEYS — Keyboard shortcuts (8)

_The set matches iCloud Numbers so existing users carry their habits across. All modifier shortcuts resolve from the physical key._

- **KEYS-01** — Reference sheet: `?` opens an in-app shortcuts sheet grouped by Document, Edit, Find, Format, Table and cells, and View. `Esc` or the close control dismisses it.
- **KEYS-02** — Document: `⌘N` new, `⌘O` open, `⌘P` print, `⌘W` close.
- **KEYS-03** — Edit: `⌘Z` / `⇧⌘Z`, `⌘X`, `⌘C`, `⌘V`, `⌥⇧⌘V` paste and match style, `⌘A`, `⌫` clear.
- **KEYS-04** — Find: `⌘F`, `⌘G`, `⇧⌘G`, `⌥⌘F`.
- **KEYS-05** — Format: `⌘B`, `⌘I`, `⌘U`, `⇧⌘X` strikethrough, `⌃⌘+` / `⌃⌘−` super and subscript, `⌥⌘1` format inspector, `⌥⌘2` organize inspector.
- **KEYS-06** — Table: Tab, Shift-Tab and arrows traverse; Enter edits and commits down; Tab commits right; Esc cancels; `⌥⌘↓` adds a row; `⌥⌘→` adds a column; `⌘]` and `⌘[` nest and promote.
- **KEYS-07** — View: `⌘+`, `⌘−`, `⌘0` actual size, `⇧⌘0` fit, `⌥⌘I` inspector, `⌃⇥` and `⌃⇧⇥` between sheets.
- **KEYS-08** — Discoverability: Every shortcut also appears beside its command in menus and tooltips; no shortcut exists that has no other route.

## SORT — Sort, filter, group (6)

- **SORT-01** — Header menu: Each column header carries a ▼ opening sort modes (None, A–Z, Z–A, Chars, Words, Freq), a per-column contains filter, and the group toggle. Active state tints the header with ↑ ↓ or ⌕.
- **SORT-02** — Collation: A–Z uses `Intl.Collator` for the active locale so Indic scripts order by script rules, not code points.
- **SORT-03** — Fuzzy: Fuzzy filter tolerates an edit distance of two and operates on grapheme clusters.
- **SORT-04** — Facets: Entity facets (Country, Company, Email, Date, Currency) filter rows to those containing a Smart Chip match.
- **SORT-05** — Grouping: Grouping by a column collapses rows into bands stating the value and count on the grouped column, each collapsible. Grouping applies after sort and filter.
- **SORT-06** — Clear: Clear resets sort, filter and grouping for that table in one action.

## MENU — Context menus (5)

_Right-click on a column header or a cell._

- **MENU-01** — Parity: Menus follow desktop spreadsheet order and grouping, with separators between kinds.
- **MENU-02** — Disabled: Unavailable commands render disabled with their reason available on hover — never hidden. Absence is more confusing than a greyed item.
- **MENU-03** — Column menu: Graph this table; freeze; sort and sort options; quick filter and filter options; add, remove and configure a category; add column before/after; delete; hide; fit width; clipboard; wrap text. _Amended by ADR-051: Rename column… (F2) between Add column after and Delete column, disabled with the reason on a derived, pulled or mapping column; the header's ▼ carries it too._
- **MENU-04** — Cell menu: Freeze; add row above/below; add column before/after; delete row/column; sort, filter, category options; merge controls; cut, copy, copy snapshot, paste, paste and match style, clear all; wrap text. _Amended by ADR-051: Fit column width to content beside Fit row height to content, so a column fits with the header row hidden; the table's context menu (on the title) carries Rename table… (F2); the toolbar's Table menu does not (one home, ADR-041)._
- **MENU-05** — Dismissal: Escape or a click outside closes; focus returns to the trigger element.

## INSP — Inspector (12)

_A 322 px rail with two modes, selected from the chrome._

- **INSP-01** — Modes: Format (Table, Cell, Text, Arrange, and Graph when a graph is selected) and Organize (Categories, Sort, Filter). The chrome toggles carry the active state.
- **INSP-02** — Collapse: The rail collapses to a 38 px strip and back; below 1200 px it starts collapsed, and below 768 px it does not render.
- **INSP-03** — Selected node: The head of the rail always states the selected object, its address when a cell is selected, row and column counts, derived count and grouping.
- **INSP-04** — Table tab: Table styles; title and caption visibility; header row, header column and footer row counts; row and column counts that insert or delete structure; outline; gridline density; alternating row colour; row and column size with fit-to-content. _Amended by ADR-049 (#167): Height and Width act on the selected rows and columns, each with Fit to content beside it; Distribute rows / columns evenly; the table's default wrap._ _Amended by ADR-051: Title text beside the Title switch (as Caption text sits beside Caption) and a Name field for the selected column — the homes of Rename table and Rename column; the title bar and the column headers rename inline by double-click, F2 or Enter, and the context menus carry the routes; a name is unique — a column's in its table, a table's in the workbook — and every lineage label follows a rename._
- **INSP-05** — Cell tab: Data format with its options, fill, a positional border matrix (all, any single edge, outline, paired, none) with hairline/strong/accent weight, and conditional highlighting rules.
- **INSP-06** — Text tab: Font family, four-step weight, size, inline marks, character styles, text colour, horizontal and vertical alignment, wrap.
- **INSP-07** — Arrange tab: Stacking order, canvas layout, size, position in both pixels and grid address, pin to viewport, DAG edges.
- **INSP-08** — Graph tab: Appears only when a graph is selected: source with Re-point, dimension checklist, add dimension column, coverage axes and pins, context counts, remove.
- **INSP-09** — Derive tab: Cross-table relation, derived-column composition, hierarchy controls and the pipeline audit list.
- **INSP-10** — Scope: Each control states whether it acts on the cell or the whole column before it is applied; format changes are column-scoped by default with cell override.
- **INSP-11** — Unimplemented: A control whose effect is not implemented renders disabled with its reason, never styled as operable — the convention set by the context menus.
- **INSP-12** — Live: Changing any control updates the canvas immediately; no Apply step exists.

## GRAPH — Context graphs (11)

_A graph renders a table as an N-dimensional matrix. Rows are contexts; marked columns are dimensions._

- **GRAPH-01** — Creation: + Graph in the toolbar, “Graph this table” in a table’s context menu, or the empty-sheet menu. Each add creates a linked ring and coverage pair placed side by side below the sheet’s tables.
- **GRAPH-02** — Pairing: A pair shares table, dimensions and slice; position and size are per object.
- **GRAPH-03** — Pointing: An unbound graph enters pointing mode: tables outline in accent, a banner states the instruction, clicking binds, Escape cancels.
- **GRAPH-04** — Shaped table: “Add shaped table” creates a pre-shaped table and binds it in one step.
- **GRAPH-05** — Binding panel: The Graph inspector tab offers the source with Re-point, a checklist of eligible columns with distinct-value counts, add dimension column, coverage axes and pins, context counts, and remove.
- **GRAPH-06** — Derivation: Dimensions, parameters and contexts recompute live from the table. Symbols are generated in row order. A fully bound row is complete; a partially bound row renders hollow and dashed.
- **GRAPH-07** — Ring: One arc per dimension with a dot per parameter; contexts sit on concentric orbits. The header states distinct covered tuples over the total tuple space.
- **GRAPH-08** — Coverage: One 2-D slice: two dimensions on the axes, every other dimension pinned. Pins default to the selected context’s bindings so the slice contains the selection.
- **GRAPH-09** — Emphasis: Hovering a node, dot or coverage cell mutes everything not adjacent across the whole pair, draws spokes, and lights the source row in the table.
- **GRAPH-10** — Write-back: Clicking a node selects its row; clicking an empty coverage cell appends a pre-filled row; double-clicking a node opens a new sheet named after the symbol containing a shaped child table.
- **GRAPH-11** — Geometry: Drag the header to move, the corner to resize; both snap to the lattice. The ring scales to fit its box.

## SHARE — Sharing and collaboration (5)

- **SHARE-01** — Sheet: Share opens one sheet: who can access, permission, an invite field, the participant list with per-person permission and remove, copy link, and stop sharing.
- **SHARE-02** — Invite: An address without an account receives an invitation valid 14 days that converts to a share on first sign-in.
- **SHARE-03** — Enforcement: Permissions are checked server-side on every sync message. A view-only participant receives the document stream; their edits are rejected and the client never enters edit mode.
- **SHARE-04** — Presence: Collaborator selections render as coloured outlines with a name tag, assigned on join from a fixed palette that excludes the brand colour.
- **SHARE-05** — Indicator: While any participant exists the title row shows Shared with stacked avatars.

## LOAD — Loading, saving and sync (7)

_Three tiers by expected wait; optimistic by default._

- **LOAD-01** — Threshold: Under 200 ms show nothing. 200 ms–1 s a skeleton shaped like the content. Over 1 s a skeleton plus a status line naming the object.
- **LOAD-02** — Hold: Once shown, a skeleton holds for at least 400 ms so it cannot flash.
- **LOAD-03** — Geometry: Skeletons reserve the final geometry; table skeletons keep the 22 px lattice row so nothing shifts on arrival.
- **LOAD-04** — Inline: An action in flight keeps its button width and switches the label to the present participle, with `aria-busy` and a `role="status"` spinner.
- **LOAD-05** — Optimistic: A local edit renders immediately and syncs behind it. Typing is never blocked by sync. Only a failed sync surfaces anything, and it offers retry.
- **LOAD-06** — Offline: Edits continue against the local replica and merge on reconnect; the banner states that work is saved locally.
- **LOAD-07** — Reduced motion: Skeletons render as a flat tint with no shimmer under `prefers-reduced-motion`.

## I18N — Language, keyboards and locale (5)

_English (US, UK, India), Tamil, Hindi, Telugu._

- **I18N-01** — Composition: The editor ignores Enter, Tab and arrows while an IME is composing, so a conjunct is never split or committed half-formed.
- **I18N-02** — Shortcuts: Modifier shortcuts resolve from `event.code`, so they work unchanged on Tamil99, InScript and Remington layouts.
- **I18N-03** — Rendering: Noto Sans Tamil, Devanagari and Telugu are in the font stack; `lang` is set on the root; Indic line-height is 1.7 minimum.
- **I18N-04** — Formatting: Numbers and dates render through `Intl` for the active locale; Indian locales group as lakh and crore.
- **I18N-05** — Persistence: The locale choice persists per user and applies to collation, formatting and shaping at once.

## A11Y — Accessibility — WCAG 2.1 AA (6)

_Binding on every screen. Full criteria table in the Design System._

- **A11Y-01** — Keyboard: Every action is reachable without a pointer; the core task must be completable with the mouse unplugged.
- **A11Y-02** — Focus: A 2 px focus ring in live amber at 2 px offset on every focusable element, never removed.
- **A11Y-03** — Contrast: Body text ≥ 4.5:1, large text and UI boundaries ≥ 3:1. New colour pairs record their ratio in the pull request.
- **A11Y-04** — Colour independence: No state is carried by hue alone: drafts are dashed, errors carry an icon and text, references show an operand index.
- **A11Y-05** — Announcements: Selection, sync status and loading progress announce through a polite live region.
- **A11Y-06** — Zoom: Layout holds at 200 % browser zoom at every breakpoint with no loss of content.

## RESP — Responsive behaviour (5)

_Breakpoints 480 / 768 / 1024 / 1440._

- **RESP-01** — Document geometry: A table never reflows at a breakpoint — addresses would change. The viewport pans over fixed geometry.
- **RESP-02** — Phone: Below 768 px the product is read-only: no edit affordances render, the inspector and toolbar are hidden, the sheet switcher becomes a bottom bar, and the chrome states “View only on phone”.
- **RESP-03** — Tablet: 768–1023 px restores full editing; the inspector opens as an overlay and context menus are available on long-press.
- **RESP-04** — Desktop: From 1024 px the inspector docks at 322 px and collapses to a 38 px strip; toolbars wrap rather than clip.
- **RESP-05** — Targets: Below 1024 px every interactive target is at least 44 × 44 px.

## ONB — First-run guided tour (14)

_Five steps over the live interface. Written for users fluent in iCloud Numbers, so it teaches only what Numbers does not. Direction 1a of the explored options._

- **ONB-01** — Sample workscape: A workscape named `Q3 Delivery — Guided sample` must be present in every library, pinned above all other rows and flagged Sample in the shared column. It must be seeded with the tables, formulas and dates the tour refers to.
- **ONB-02** — Trigger: The tour must start on the user’s first arrival at the library after authentication, and only when the per-user completion flag is unset. Users arriving from a shared invitation get the same tour.
- **ONB-03** — Completion state: Completing the final step, or skipping at any step, must set a per-user server-side flag. The flag is per account, not per device or browser.
- **ONB-04** — Spotlight: Each step must spotlight its target element by live bounding box, re-measured on scroll, resize, zoom and any layout change, with the surrounding page dimmed. The dim layer must not intercept pointer events.
- **ONB-05** — Advance condition: A step must advance only when the user performs its action. No Next control is provided. Step order: open the sample, write a cross-table reference, add a context graph, open Find and search, invite by email.
- **ONB-06** — Step 2 targeting: The cross-table reference step has no single target element, because formulas are typed in the cell. Its card must centre in the viewport with no spotlight.
- **ONB-07** — Skip: Skip must be present on every step and must end the tour permanently, setting the flag as in ONB-03.
- **ONB-08** — Replay: Replay must be available from the help control in the library header at any time, and must clear the flag and restart at step 1.
- **ONB-09** — Card anatomy: Each card must carry a step counter, progress dots, a title, an instruction body, a comparison note, and the pending action rendered in amber. The card must flip above its target when there is insufficient room below.
- **ONB-10** — Comparison copy: Guidance must name the iCloud Numbers equivalent and then state the difference. Behaviour that Numbers already teaches must not be taught. Context graphs, having no Numbers analogue, are introduced on their own terms.
- **ONB-11** — Interactivity: The spotlit element must remain fully operable while the tour is active. The tour must never block an edit.
- **ONB-12** — Localisation: All tour strings must live in the same message catalogue as the rest of the interface and must render in all six supported locales.
- **ONB-13** — Responsive: The tour must not run below 768 px, where documents are read-only. The flag must remain unset so the user receives it on a larger viewport.
- **ONB-14** — Completion: On completing step 5 the product must confirm completion and state where the tour can be replayed.

## LIB-D — Library: delete and archive (11)

_Deletion is conditional on sharing history. A workscape that has ever had a participant can only be archived, so that no one loses access to a document they were given._

- **LIB-D1** — Delete, unshared: A workscape with no participants and no active share link must be deletable. The toolbar action reads Delete.
- **LIB-D2** — Archive, shared: A workscape that has ever been shared must not be deletable. The same toolbar slot must become Archive, with a tooltip stating that shared workscapes cannot be deleted.
- **LIB-D3** — Archive semantics: Archiving must preserve every participant’s access and all share links. It removes the workscape from the owner’s Recents, Browse and Shared views only. Participants see no change.
- **LIB-D4** — Deletability transition: A workscape must become non-deletable at the moment the first invitation is accepted, not when it is sent. Revoking all access must restore deletability.
- **LIB-D5** — Recently Deleted: Deleting must move the workscape to Recently Deleted, where it remains recoverable. Retention is 30 days, after which purge is automatic.
- **LIB-D6** — Archived view: The sidebar must carry an Archived view listing archived workscapes, each with an Unarchive action. Archive has no expiry.
- **LIB-D7** — Bulk actions: Recently Deleted must offer per-item Recover, Recover All and Delete All.
- **LIB-D8** — Permanence: Delete All must be permanent and irreversible, and must say so before proceeding.
- **LIB-D9** — Feedback: Every delete, archive, recover and unarchive must raise a confirmation. Reversible actions must carry Undo; permanent ones must state that they cannot be undone.
- **LIB-D10** — Sample exemption: The guided sample workscape must be exempt from both delete and archive. Its toolbar action is disabled with an explanatory tooltip.
- **LIB-D11** — Shared state: Archive and trash are document states, not library-local flags. A second client signed in to the same account must observe the same state without a reload.

## Count

| Area | Count |
|---|---|
| AUTH | 10 |
| LIB | 10 |
| DOC | 7 |
| GRID | 11 |
| FMT | 6 |
| FX | 9 |
| REF | 5 |
| HIER | 10 |
| FIND | 10 |
| KEYS | 8 |
| SORT | 6 |
| MENU | 5 |
| INSP | 12 |
| GRAPH | 11 |
| SHARE | 5 |
| LOAD | 7 |
| I18N | 5 |
| A11Y | 6 |
| RESP | 5 |
| ONB | 14 |
| LIB-D | 11 |
| **Total** | **173** |
