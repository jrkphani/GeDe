/**
 * The message catalogue, en-US — the reference locale: every other locale
 * must carry exactly these keys (`catalogue.test.ts`). Placeholders are
 * `{name}` and are substituted by `format()`.
 *
 * Tour copy (ONB-10, ONB-12) is the prototype's, verbatim
 * (`docs/PROTOTYPE-CHANGES-2026-09-12.md` §1.4), with three departures where
 * the PRD wins: step 1's "— it resets" is held back (it names a Reset control
 * no PRD row specifies, and the handover says not to ship the sentence without
 * the control); the Find step's operator example is `is:date`, not the
 * prototype's `is:blocked` — FIND-04 defines `is:` over resolved formats
 * (`currency | date | number | text`), so `is:blocked` would match nothing;
 * and the invite step's difference is "a permission you set per person" —
 * SHARE-01 is a permission per participant, and no PRD row gives a table its
 * own, so the prototype's "per table" named a feature that does not exist
 * (ONB-10 asks for the real difference).
 *
 * The keys are numbered by the step as the tour counts it today (ADR-055
 * made the set operators step 3, so the graph is `tour.step4.*`, Find
 * `tour.step5.*` and the invitation `tour.step6.*`). The sub-cards of steps
 * 2, 3 and 4 (`tour.step2.concat.*`, `tour.step3.result.*`,
 * `tour.step4.point.*`, `tour.step4.dimensions.*`) are new copy: the
 * prototype had one card per step. Step 2b names Numbers' CONCATENATE / `&`
 * then the difference (FX-01; the example evaluates against the sample,
 * `packages/core/src/ref/concat.test.ts`); step 3's two cards share a note
 * that claims no Numbers analogue, as the graph's does — set algebra over a
 * cell's text has none (FX-09; both examples evaluate against the sample,
 * `packages/core/src/ref/set-call.test.ts`); step 4's sub-cards keep its
 * note — a graph has no Numbers analogue.
 */
export const messages = {
  'tour.counter': 'STEP {step} OF {total}',
  'tour.progress': 'Step {step} of {total}',
  'tour.skip': 'Skip',
  'tour.pending': 'Pending action',

  'tour.step1.title': 'Open the sample workscape',
  'tour.step1.body': 'Q3 Delivery sits in every library permanently. Nothing in it is precious.',
  'tour.step1.action': 'Double-click “Q3 Delivery — Guided sample”',

  'tour.step2.title': 'Reference a cell in another table',
  'tour.step2.body':
    'Double-click any cell, type = then @, and pick an entity. The cell stays live — change the source and it follows.',
  'tour.step2.note':
    'Numbers: People::B2, tied to a position. GeDe: =@Entity.Path, tied to the row itself.',
  'tour.step2.action': 'Type a formula into any cell',

  'tour.step2.concat.title': 'Join text with =Concat()',
  'tour.step2.concat.body':
    'Concat joins its arguments end to end: cells, @ paths and quoted text, in any mix. In an empty cell, type =Concat(C5, " — ", @Team.Priya.Role) and press Enter; it reads Priya — Product engineer.',
  'tour.step2.concat.note':
    'Numbers: CONCATENATE or &, over plain strings. GeDe: =Concat(a, b, …) keeps each argument’s marks and references live, so the joined text follows its sources.',
  'tour.step2.concat.action': 'Commit a Concat over two or more arguments',

  'tour.step3.title': 'Compute over the text in cells',
  'tour.step3.body':
    'A cell’s commas make a set, and five forms compare sets. Double-click an empty cell in Deliverables, type = to open the forms menu and pick Union(a, b, …). Name two ranges inside the parentheses: =Union(C5:C12, I5:I8) is everyone named as an owner or on the team, once each — Priya, Marcus, Aditi, Sanjay.',
  'tour.step3.note':
    'No Numbers equivalent — a cell’s commas make a set, and a set formula’s result is one cell that reads like its sources.',
  'tour.step3.action': 'Type = in a cell and pick Union',

  'tour.step3.result.title': 'Compare two sets',
  'tour.step3.result.body':
    'Diff keeps what the first set has and the second does not. Who else on the team could take Billing export? In another empty cell, type =Diff(I5:I8, C6) and press Enter: the team less that row’s owner — Priya, Aditi, Sanjay. Inter keeps what both have, Comp what the universe has and a set lacks, Cross every pair.',
  'tour.step3.result.action': 'Commit a Diff, Inter, Comp or Cross over two cells or ranges',

  'tour.step4.title': 'Add a context graph',
  'tour.step4.body':
    'A graph is an object on the canvas bound to columns. Click a node and it writes that value back into the rows.',
  'tour.step4.note': 'No Numbers equivalent — it is not a chart. It reads and writes the table.',
  'tour.step4.action': 'Click Add graph in the toolbar',

  'tour.step4.point.title': 'Point it at a table',
  'tour.step4.point.body':
    'A graph draws its rows and columns from one table. The sample’s two tables, Deliverables and Team, are outlined as targets; either will do. Escape starts over.',
  'tour.step4.point.offCanvas': 'A table sits off the canvas; the one on screen is enough.',
  'tour.step4.point.action': 'Click a table to bind the graph',

  'tour.step4.dimensions.title': 'Pick the dimensions',
  'tour.step4.dimensions.body':
    'A dimension is a column whose values define a context, so every combination of values is a node. The graph starts with the first three entered columns; the Graph tab lists each column with its distinct values. Change the set — untick one of the three, or tick another — to see the graph redraw.',
  'tour.step4.dimensions.action': 'Untick or tick a dimension, keeping at least two',

  'tour.step5.title': 'Find across every table',
  'tour.step5.body':
    'One search covers the whole workscape. Operators narrow it: col:Owner, is:date.',
  'tour.step5.note': 'Numbers searches one sheet at a time. ⌘F here spans every table and graph.',
  'tour.step5.action': 'Open Find and type anything',

  'tour.step6.title': 'Invite someone by email',
  'tour.step6.body': 'People you invite get this same pass the first time they open a workscape.',
  'tour.step6.note': 'Like iCloud sharing, with a permission you set per person.',
  'tour.step6.action': 'Open Share and invite an email',

  'tour.done.message': 'All six done. Replay any time from the ? in your library.',
  'tour.done.replay': 'Replay',

  // ADR-047: what the live region says of a deleted, collapsed or expanded object, and the
  // chevron's name. `{name}` is one of the `object.name.*` phrases (or a table's title, or the
  // object's accessible name); `{undo}` is the chord's glyph.
  'object.name.ring': 'the ring of {table}',
  'object.name.coverage': 'the coverage of {table}',
  'object.name.pair': 'the graph of {table}',
  'object.name.ringUnbound': 'the ring',
  'object.name.coverageUnbound': 'the coverage',
  'object.name.pairUnbound': 'the graph',
  'object.name.tableGraph': '{table} and its graph',
  'object.name.tableGraphs': '{table} and its {count} graphs',
  'object.deleted': 'Deleted {name} — press {undo} to undo',
  'object.deleted.ref':
    'Deleted {name} — 1 cell elsewhere now reads “reference removed”; press {undo} to undo',
  'object.deleted.refs':
    'Deleted {name} — {count} cells elsewhere now read “reference removed”; press {undo} to undo',
  'object.collapsed': 'Collapsed {name}',
  'object.expanded': 'Expanded {name}',
  'object.collapse': 'Collapse {name}',
  'object.expand': 'Expand {name}',

  // ADR-048 (#165): the sheet strip's commands — what the live region says of a renamed,
  // deleted or restored sheet, and the name field's refusal. A deleted sheet is announced
  // through `object.deleted*` with `sheet.name.*` as its `{name}`; `{sheet}` is a label.
  'sheet.name.tables': '{sheet} with {tables}',
  'sheet.name.graphs': '{sheet} with {graphs}',
  'sheet.name.both': '{sheet} with {tables} and {graphs}',
  'sheet.count.table': '1 table',
  'sheet.count.tables': '{count} tables',
  'sheet.count.graph': '1 graph',
  'sheet.count.graphs': '{count} graphs',
  'sheet.deleted': 'Deleted {name}',
  'sheet.nowOn': '{deleted}. Now on {sheet}',
  'sheet.removedRemotely': '{sheet} was deleted — now on {nowOn}',
  'sheet.renamed': 'Renamed {from} to {to}',
  'sheet.restored': 'Restored {sheet}',
  'sheet.lastKept': 'A workscape keeps at least one sheet',
  'sheet.needsName': 'A sheet needs a name',

  'library.help.label': 'Help',
  'library.help.replay': 'Replay guided tour',
  'library.help.shortcuts': 'Keyboard shortcuts',

  // AUTH-06: the code step's copy follows the code the auth step expects. Cognito's sign-in
  // code (the EMAIL_OTP first factor) is eight digits and lives ten minutes; its sign-up
  // verification code is six and lives 24 hours (`auth/codes.ts`, `CODE_LENGTH`).
  'auth.code.label.six': 'Six-digit code',
  'auth.code.label.eight': 'Eight-digit code',
  'auth.code.sent.six': 'We sent a six-digit code to your email',
  'auth.code.sent.eight': 'We sent an eight-digit code to your email',
  'auth.code.expires.signIn': 'Codes expire in 10 minutes',
  'auth.code.expires.signUp': 'Codes expire in 24 hours',

  // FX-10: the forms-menu hint beside Power(a); `a` is the typed argument name.
  'forms.power.hint': 'every subset of a',

  // SET-12: beside a computed row whose element left the result; `{sets}` is the formula's
  // operands as `computedOperandsLabel` reads them ("E × C").
  'set.lost': 'no longer in {sets}',
  // SET-08: the read-only reason of a computed column's cells.
  'set.readOnly.computed': 'the column is computed',
  // SET-08 ruling (c): why Delete row is disabled on a computed row.
  'set.rowComputed': 'the row is computed',
  // A read-only cell's accessible name; `{reason}` is one of the readOnly.* reasons below
  // or set.readOnly.computed.
  'cell.readOnly': 'Read-only: {reason}',
  // The live-region sentence when a read-only cell or column refuses an edit.
  'cell.readOnly.announce': '{cell} is read-only: {reason}',
  'cell.readOnly.announceUnaddressed': 'The cell is read-only: {reason}',
  'column.readOnly.announce': 'Column {column} is read-only: {reason}',
  // SET-10: Fill column refused after a merge, because another person typed into the column.
  'set.fillRefused': 'Column {column} is not filled: the column is not empty',
  'set.fillSuperseded': 'Column {column} is not filled: the table follows another formula',
  'readOnly.derived': 'derived column',
  'readOnly.linked': 'linked column',
  'readOnly.pulled': 'pulled from another table',
  'readOnly.group': 'category band',
  'readOnly.splitChild': 'split child row',
  // SET-01, DOC-02 (ADR-056): Add table asks the table's kind; Plain table is preselected.
  'addTable.title': 'What kind of table is this?',
  'addTable.kinds': 'Table kind',
  'addTable.kind.plain': 'Plain table',
  'addTable.kind.plain.hint': 'A plain GeDe table. No set rules, no summary entry.',
  'addTable.kind.simple': 'Simple set',
  'addTable.kind.simple.hint': 'The most basic set: a range of elements, each with a note.',
  'addTable.kind.family': 'Family of sets',
  'addTable.kind.family.hint':
    'Sets nested inside sets. A row holds an element, a simple set or another family.',
  'addTable.kind.computed': 'Computed by formula',
  'addTable.kind.computed.hint':
    'Union, intersection or difference of sets already on this sheet. Stays in step with them.',
  'addTable.kind.product': 'Cartesian product',
  'addTable.kind.product.hint':
    'Every ordered tuple from two or more sets. Rows count |A| × |B| × …',
  'addTable.add': 'Add table',
  'addTable.pickSets': 'Pick sets',
  'addTable.cancel': 'Cancel',
  'addTable.back': 'Back',
  'addTable.added': 'Added {table}',
  // SET-08, SET-09: the operand picker, the second step of a computed kind and Fill column's body.
  'pick.title': 'Add a computed table',
  'pick.description': 'From sets already on this sheet. The result recomputes when they change.',
  'pick.operation': 'Operation',
  'pick.op.Union': 'elements in any of the sets',
  'pick.op.Inter': 'elements in every set',
  'pick.op.Diff': 'elements of a that are not in b',
  'pick.op.Cross': 'every ordered tuple (a, b, …)',
  'pick.sets': 'Sets, in order',
  'pick.firstSet': 'First set',
  'pick.secondSet': 'Second set',
  'pick.set': 'Set',
  'pick.factor': 'Set {n} of the product',
  'pick.removeFactor': 'Delete set {n}',
  'pick.addFactor': 'Add another set',
  'pick.order': 'Order matters: each row is an ordered tuple. A set may appear twice, as in E × E.',
  'pick.shape': 'Each tuple goes in',
  'pick.shape.column': 'One column',
  'pick.shape.column.hint':
    'Each cell holds a tuple, (a, b, x). Use it as one column of a larger table.',
  'pick.shape.spread': 'One column per set',
  'pick.shape.spread.hint':
    'x1, x2, x3 sit in adjacent cells of the row. Add your own columns beside them.',
  'pick.formula': 'Formula',
  'pick.noSets': 'There are no sets on this sheet yet. Add a Simple set first.',
  // SET-10, MENU-03: the column menu's Fill column with formula….
  'fill.menu': 'Fill column with formula…',
  'fill.title': 'Fill {column} with a formula',
  'fill.description':
    'The column fills one row per element of the result and recomputes when its sets change.',
  'fill.confirm': 'Fill column',
  'fill.notEmpty': 'the column is not empty',
  'fill.filled': 'Filled {column} with {formula}',
  'fill.hasFormula': 'the table already has a formula',
  'fill.derived': 'the column is derived',
  'fill.pulled': 'the column is pulled',
  'fill.linked': 'the column is a mapping',
  // SET-01: the kind changes in the Table tab while the table holds no typed value.
  'kind.typed': 'the table holds typed values',
  'kind.needsFormula': 'Fill a column with a formula first',
  'kind.changed': '{table} is now a {kind}',
  'kind.needsCross': 'the formula is not a Cross',
  'kind.isCross': 'the formula is a Cross',
  'kind.computedColumns': 'its columns fill from a formula',
  'kind.section': 'kind',
  'kind.section.hint': 'Changes while no cell holds a typed value.',
  // SET-01: the headings a set table starts with.
  'set.column.range': 'range',
  'set.column.description': 'description',
  'set.column.note': 'note',
  // SET-03: the meta row above a set table's header; every value computed, “—” when GeDe
  // cannot determine it. The field names are the chips' accessible names.
  'set.meta.label': 'Set facts',
  'set.meta.id': 'set id',
  'set.meta.finiteness': 'finite or infinite',
  'set.meta.variable': 'bound or free variable',
  'set.meta.quantifier': 'quantifier',
  'set.meta.status': 'special status',
  'set.meta.undetermined': 'not determined from the definition',
  'set.meta.none': 'none',
  'set.meta.finite': 'finite',
  'set.meta.bound': 'bound',
  'set.meta.universal': 'universal ∀',
  'set.meta.existential': 'existential ∃',
  'set.meta.null': 'null',
  'set.meta.singleton': 'singleton',
  // SET-04: the title row names the caption as the set's definition.
  'set.title.definition': 'definition',
  // SET-05: the footer count strip; `{set}` is the table's title, counts via Intl.NumberFormat.
  'set.count.cardinality': '|{set}| = {count}',
  'set.count.bag': 'bag {count}',
  'set.count.label': '{set}: cardinality {cardinality}, bag {bag}',
  // SET-02: a repeated element's flag (`{degree}` is the first occurrence's, e.g. +2°), and
  // Split into rows, offered when a comma value lands in a range cell.
  'set.repeat': 'repeat of {degree}',
  'set.split.offer': '{cell} holds {count} elements',
  'set.split.action': 'Split into rows',
  'set.split.alt': 'Split {cell} into one row per element',
  'set.split.done': 'Split {cell} into {count} rows',
  // SET-06: a family row's kind, in words.
  'set.rowKind.element': 'element',
  'set.rowKind.set': 'set',
  'set.rowKind.family': 'family',
  'set.split.single': 'the cell holds one element',
  'set.split.formula': 'the cell holds a formula, not typed elements',
  'set.ref.hint': 'the whole set',
  // SET-04 / INSP-04: the definition and caption fields say what they hold on blur.
  'set.definition.cleared': '{set}: definition cleared',
  'set.definition.changed': '{set}: definition is “{definition}”',
  'caption.cleared': '{table}: caption cleared',
  'caption.changed': '{table}: caption is “{caption}”',
  'set.kind.header': 'kind',
  'set.kind.label': 'kind: {kind}',
  'set.definition.field': 'Definition',
  'set.definition.placeholder': '{ x | x is a letter }',
  'set.definition.hint':
    'Shown in the title row as typed. Set-builder notation, ∀ and ∃ fill the meta row.',
  'set.id.field': 'Set id',
  'set.meta.universalShort': '∀',
  'set.meta.existentialShort': '∃',
  // SET-13..18: sections, lock, the universal set, the super set array and the summaries.
  'section.defaultName': 'Section {n}',
  'section.label': 'Section {n}: {name}',
  'section.add': 'Add section',
  'section.added': 'Added {name}',
  'section.rename': 'Rename section…',
  'section.rename.field': 'Section name',
  'section.rename.empty': 'A section needs a name',
  'section.renamed': 'Renamed section to {name}',
  'section.menu': 'Section menu: {name}',
  'lock.section': 'Lock section',
  'lock.sectionOff': 'Unlock section',
  'lock.sheet': 'Lock sheet',
  'lock.sheetOff': 'Unlock sheet',
  'lock.status': 'Locked {name}',
  'lock.unlocked': 'Unlocked {name}',
  'lock.state.locked': 'locked',
  'lock.state.unlocked': 'unlocked',
  'readOnly.sectionLocked': 'the section is locked',
  'readOnly.sheetLocked': 'the sheet is locked',
  'summary.section.kind': 'section summary',
  'summary.section.label': 'Section summary: {section}',
  'summary.setCount': 'Sets: {count}',
  'summary.elementCount': 'Elements: {count}',
  'summary.col.id': 'set id',
  'summary.col.name': 'name',
  'summary.col.definition': 'definition',
  'summary.col.cardinality': 'cardinality · bag',
  'summary.col.status': 'special status',
  'summary.col.equal': 'similar definition',
  'summary.col.improper': 'improper subset of ⊆',
  'summary.col.proper': 'proper subset of ⊂',
  'summary.col.elementOf': 'element of ∈',
  'summary.col.intersection': 'same as intersection',
  'summary.col.union': 'same as union',
  'summary.col.difference': 'same as difference',
  'summary.bag': 'bag {count}',
  'summary.none': 'none found',
  'summary.tooMany': 'more than {limit} sets in this section',
  'summary.note': '“—” means GeDe checked and found none, not that the cell is empty.',
  'summary.sheet.kind': 'sheet summary',
  'summary.sheet.section': 'section',
  'summary.sheet.sets': 'sets',
  'summary.sheet.elements': 'elements',
  'summary.universe.kind': 'universal set',
  'summary.universe.count': '|U| = {count}',
  'summary.universe.hint':
    'Every distinct element on this sheet, once. Write @U to use it in a formula.',
  'summary.super.kind': 'super set array',
  'summary.super.count': 'Elements: {elements} · Sets: {sets}',
  'summary.super.element': 'element',
  'summary.super.set': 'set',
  'summary.indexes': 'Sheet indexes, updated automatically',
  'footer.rowsFiltered': '{shown} of {total} rows',
  // SET-19: menu, table-menu and toolbar labels.
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.copySnapshot': 'Copy snapshot',
  'menu.paste': 'Paste',
  'menu.pasteAndMatchStyle': 'Paste and match style',
  'menu.clearAll': 'Clear all',
  'menu.cutColumn': 'Cut column',
  'menu.copyColumn': 'Copy column',
  'menu.copyColumnSnapshot': 'Copy column snapshot',
  'menu.pasteIntoColumn': 'Paste into column',
  'menu.pasteIntoColumnAndMatchStyle': 'Paste into column and match style',
  'menu.clearColumn': 'Clear column',
  'menu.sortAscending': 'Sort ascending',
  'menu.sortDescending': 'Sort descending',
  'menu.showSortOptions': 'Show sort options',
  'menu.quickFilter': 'Quick filter…',
  'menu.showFilterOptions': 'Show filter options',
  'menu.showCategoryOptions': 'Show category options',
  'menu.graphThisTable': 'Graph this table',
  'menu.fitWidthToContent': 'Fit width to content',
  'menu.fitColumnWidthToContent': 'Fit column width to content',
  'menu.freezeHeaderRow': 'Freeze header row',
  'menu.addRowAbove': 'Add row above',
  'menu.addRowBelow': 'Add row below',
  'menu.addColumnBefore': 'Add column before',
  'menu.addColumnAfter': 'Add column after',
  'menu.deleteRow': 'Delete row',
  'menu.deleteColumn': 'Delete column',
  'menu.mergeWithCellToTheRight': 'Merge with cell to the right',
  'menu.mergeWithCellBelow': 'Merge with cell below',
  'menu.unmergeCells': 'Unmerge cells',
  'menu.selectTheTable': 'Select the table',
  'menu.wrapText': 'Wrap text',
  'menu.fitRowHeightToContent': 'Fit row height to content',
  'menu.useAsOutlineColumn': 'Use as outline column',
  'menu.renameColumn': 'Rename column…',
  'menu.hideColumn': 'Hide column',
  'menu.deleteGraphPair': 'Delete graph pair',
  'menu.fitToCanvas': 'Fit to canvas',
  'menu.actualSize': 'Actual size',
  'menu.addRow': 'Add row',
  'menu.addColumn': 'Add column',
  'menu.renameTable': 'Rename table…',
  'menu.deleteTable': 'Delete table',
  'menu.addTableHere': 'Add table here',
  'menu.addShapedTableHere': 'Add shaped table here',
  'menu.addGraphHere': 'Add graph here',
  'menu.addSheet': 'Add sheet',
  'menu.renameSheet': 'Rename sheet',
  'menu.deleteSheet': 'Delete sheet',
  'menu.expand': 'Expand',
  'menu.collapse': 'Collapse',
  'menu.deleteRing': 'Delete ring',
  'menu.deleteCoverage': 'Delete coverage',
  'menu.addCategoryForLabel': 'Add category for {label}',
  'menu.removeLabelCategory': 'Remove {label} category',
  'menu.freezeColumnsThroughLabel': 'Freeze columns through {label}',
  'menu.table': 'Table',
  'menu.tableMenu': 'Table menu',
  'menu.unhideColumns': 'Unhide columns',
  'menu.unhideCountColumn': 'Unhide {count} column',
  'menu.unhideCountColumns': 'Unhide {count} columns',
  'menu.widenColumn': 'Widen column',
  'menu.narrowColumn': 'Narrow column',
  'menu.documentTools': 'Document tools',
  'menu.add': 'Add',
  'menu.menus': 'Menus',
  'menu.arrange': 'Arrange',
  'menu.data': 'Data',
  'menu.find': 'Find',
  'menu.view': 'View',
  'menu.help': 'Help',
  'menu.inspectors': 'Inspectors',
  'menu.addGraph': 'Add graph',
  'menu.pinToViewport': 'Pin to viewport',
  'menu.dagEdges': 'DAG edges',
  'menu.gridlines': 'Gridlines',
  'menu.filter': 'Filter',
  'menu.sort': 'Sort',
  'menu.zoomOut': 'Zoom out',
  'menu.zoom': 'Zoom',
  'menu.zoomIn': 'Zoom in',
  'menu.zoomZoom': 'Zoom {zoom}',
  'menu.keyboardShortcuts': 'Keyboard shortcuts',
  'menu.format': 'Format',
  'menu.organize': 'Organize',
  'menu.labelInspector': '{label} inspector',
} as const;
