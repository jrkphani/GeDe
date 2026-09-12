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

  'tour.step3.title': 'Add a context graph',
  'tour.step3.body':
    'A graph is an object on the canvas bound to columns. Click a node and it writes that value back into the rows.',
  'tour.step3.note': 'No Numbers equivalent — it is not a chart. It reads and writes the table.',
  'tour.step3.action': 'Click Add graph in the toolbar',

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

  'library.help.label': 'Help',
  'library.help.replay': 'Replay guided tour',
  'library.help.shortcuts': 'Keyboard shortcuts',
} as const;
