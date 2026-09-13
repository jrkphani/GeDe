/**
 * The message catalogue, en-US — the reference locale: every other locale
 * must carry exactly these keys (`catalogue.test.ts`). Placeholders are
 * `{name}` and are substituted by `format()`.
 *
 * Tour copy (ONB-10, ONB-12) is the prototype's, verbatim
 * (`docs/PROTOTYPE-CHANGES-2026-09-12.md` §1.4), with three departures where
 * the PRD wins: step 1's "— it resets" is held back (it names a Reset control
 * no PRD row specifies, and the handover says not to ship the sentence without
 * the control); step 4's operator example is `is:date`, not the prototype's
 * `is:blocked` — FIND-04 defines `is:` over resolved formats
 * (`currency | date | number | text`), so `is:blocked` would match nothing;
 * and step 5's difference is "a permission you set per person" — SHARE-01 is
 * a permission per participant, and no PRD row gives a table its own, so the
 * prototype's "per table" named a feature that does not exist (ONB-10 asks
 * for the real difference).
 *
 * The sub-cards of steps 2 and 3 (`tour.step2.concat.*`, `tour.step3.point.*`,
 * `tour.step3.dimensions.*`) are new copy: the prototype had one card per
 * step. Step 2b names Numbers' CONCATENATE / `&` then the difference (FX-01;
 * the example evaluates against the sample, `packages/core/src/ref/concat.test.ts`);
 * step 3's sub-cards keep its note — a graph has no Numbers analogue.
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

  'tour.step3.title': 'Add a context graph',
  'tour.step3.body':
    'A graph is an object on the canvas bound to columns. Click a node and it writes that value back into the rows.',
  'tour.step3.note': 'No Numbers equivalent — it is not a chart. It reads and writes the table.',
  'tour.step3.action': 'Click Add graph in the toolbar',

  'tour.step3.point.title': 'Point it at a table',
  'tour.step3.point.body':
    'A graph draws its rows and columns from one table. The sample’s two tables, Deliverables and Team, are outlined as targets; either will do. Escape starts over.',
  'tour.step3.point.offCanvas': 'A table sits off the canvas; the one on screen is enough.',
  'tour.step3.point.action': 'Click a table to bind the graph',

  'tour.step3.dimensions.title': 'Choose the dimensions',
  'tour.step3.dimensions.body':
    'A dimension is a column whose values define a context, so every combination of values is a node. The graph starts with the first three entered columns; the Graph tab lists each column with its distinct values. Change the set — untick one of the three, or tick another — to see the graph redraw.',
  'tour.step3.dimensions.action': 'Untick or tick a dimension, keeping at least two',

  'tour.step4.title': 'Find across every table',
  'tour.step4.body':
    'One search covers the whole workscape. Operators narrow it: col:Owner, is:date.',
  'tour.step4.note': 'Numbers searches one sheet at a time. ⌘F here spans every table and graph.',
  'tour.step4.action': 'Open Find and type anything',

  'tour.step5.title': 'Invite someone by email',
  'tour.step5.body': 'People you invite get this same pass the first time they open a workscape.',
  'tour.step5.note': 'Like iCloud sharing, with a permission you set per person.',
  'tour.step5.action': 'Open Share and invite an email',

  'tour.done.message': 'All five done. Replay any time from the ? in your library.',
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
} as const;
