# Prototype changes — handover package 2026-09-12

Diff of `docs/handover/prototype/Work Scape Canvas.dc.html` between the previous package and the 2026-09-12 package (4,848 → 5,069 lines; 24 hunks, all additive except the library toolbar and nav rewrites). `support.js` is byte-identical. Everything below is what the prototype does; where it falls short of the PRD, the PRD row is named and **the PRD wins**.

Two features: the first-run guided tour (ONB-01..14) and library delete / archive (LIB-D1..11). Requirement text is in `docs/REQUIREMENTS.md`; the build resolutions for the changelog's open items are in `docs/PRD-DIGEST.md` (§24 addenda).

## 1. Guided tour

### 1.1 Anchors added to existing elements

Four elements gained a `data-tour` attribute so the tour can measure them. The build should expose the same hooks (a `data-tour` attribute or equivalent ref registry), because the tour targets them by bounding box, not by DOM position.

| `data-tour` value | Element                                            | Step |
| ----------------- | -------------------------------------------------- | ---- |
| `sample`          | Library row for `Q3 Delivery — Guided sample`      | 1    |
| `graph`           | Document toolbar button "Add graph"                | 3    |
| `find`            | Document toolbar button "Find · ⌘F"                | 4    |
| `share`           | Document title-bar "Shared" / share button         | 5    |
| (none)            | Step 2 has no target; card centres in the viewport | 2    |

### 1.2 Library header

A new icon button was inserted before the + control in the library header:

- Glyph `?`, 30 × 30 px, ghost (transparent, radius 6), tooltip **"Guided tour"**.
- Click: clears the completion flag and starts the tour at step 1 (`tourReplay`). Works whether or not a tour is already running.
- Note: inside a document, `?` still opens the shortcut sheet; this button exists only in the library.

### 1.3 State and lifecycle (prototype behaviour)

- Flag: `localStorage['gede.tour.done'] = '1'`. **PRD ONB-03 requires a per-account server-side flag; the prototype's localStorage is a stand-in.**
- Start: when `S.user` transitions from unset to set (sign-in or restored session) and the flag is unset, `startTour()` runs. It snapshots baselines (`fx` = count of formulas + refs, `graphs` = graph count, `people` = share-list length) so later steps detect "one more than before".
- Measure loop: `setInterval(measureTour, 350)` from `componentDidMount`. Each tick re-reads the target's `getBoundingClientRect()` and, if the step's `check(S, base)` passes, advances. **PRD ONB-04 requires re-measurement on scroll, resize, zoom and layout change; the build should use ResizeObserver / scroll and resize listeners / rAF, not polling.**
- Advance: only by `check` passing. There is no Next control (ONB-05). Completing step 5 calls `endTour(true)`.
- Skip: `endTour(true)` — sets the flag and closes (ONB-07).
- End: `endTour(done)` clears `tour`; when `done` it shows the completion toast for 8 s.
- **Not gated by viewport width.** The prototype will start the tour below 768 px. PRD ONB-13 says it must not, and the flag must stay unset.
- No locale handling: strings are literals in the `TOUR` array. PRD ONB-12 puts them in the message catalogue.

### 1.4 Steps and copy (verbatim)

`TOUR` is an ordered array. Counter text is `STEP n OF 5`.

| Step | Target   | Title                             | Body                                                                                                              | Comparison note                                                                       | Pending action (amber)                     | Advance check                    |
| ---- | -------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------- |
| 1    | `sample` | Open the sample workscape         | Q3 Delivery sits in every library permanently. Nothing in it is precious — it resets.                             | _(none — note row hidden)_                                                            | Double-click “Q3 Delivery — Guided sample” | `docOpen.id === 'sample'`        |
| 2    | —        | Reference a cell in another table | Double-click any cell, type = then @, and pick an entity. The cell stays live — change the source and it follows. | Numbers: People::B2, tied to a position. GeDe: =@Entity.Path, tied to the row itself. | Type a formula into any cell               | formulas + refs count > baseline |
| 3    | `graph`  | Add a context graph               | A graph is an object on the canvas bound to columns. Click a node and it writes that value back into the rows.    | No Numbers equivalent — it is not a chart. It reads and writes the table.             | Click Add graph in the toolbar             | graph count > baseline           |
| 4    | `find`   | Find across every table           | One search covers the whole workscape. Operators narrow it: col:Owner, is:blocked.                                | Numbers searches one sheet at a time. ⌘F here spans every table and graph.            | Open Find and type anything                | find query non-empty             |
| 5    | `share`  | Invite someone by email           | People you invite get this same pass the first time they open a workscape.                                        | Like iCloud sharing, with permissions you can set per table.                          | Open Share and invite an email             | share people count > baseline    |

Copy notes for the build:

- Step 1's body says the sample "resets". No §24 row specifies a reset control; the First Run spec mentions "Reset restores it". Treat reset as unspecified until the PRD says otherwise; do not ship the sentence without the control.
- Step 2's note uses `People::B2` — that is Numbers' cross-sheet syntax, quoted deliberately (ONB-10).
- Step 5's body promises the tour to invitees; ONB-02 covers that ("Users arriving from a shared invitation get the same tour").

### 1.5 Scrim and spotlight

One fixed element, rendered above everything (z 9000), `pointer-events: none`:

- With a target: positioned at the target rect inset by −5 px on every side (`left: x−5, top: y−5, width: w+10, height: h+10`), `border-radius: 10px`, `border: 2px solid #b45309` (amber-700), `box-shadow: 0 0 0 9999px oklch(0.22 0.03 150 / 0.46)`. The shadow spread is what dims the page.
- Without a target (step 2, or the target not found): full-viewport `background: oklch(0.22 0.03 150 / 0.34)`.
- Nothing is inert: clicks pass through to the page (ONB-04, ONB-11).

### 1.6 Coachmark card

Fixed element, z 9001, `width: 286px`, `padding: 15px 16px 14px`, white, `border: 1px solid oklch(0.86 0.004 262)`, `border-radius: 11px`, `box-shadow: 0 22px 52px oklch(0.2 0.03 150 / 0.34)`.

Placement (`TCARD`):

- Below the target: `left = clamp(target.x, 12, vw − 298)`, `top = target.y + target.h + 14` — when `target.y + target.h + 226 < innerHeight`.
- Otherwise above: same `left`, `top = max(12, target.y − 212)` (ONB-09 "flip above").
- No target: `left: 50%; top: 50%; transform: translate(−50%, −50%)`.

Anatomy, top to bottom:

1. Header row: counter `{{ tourLabel }}` in IBM Plex Mono 9.5 px, letter-spacing 0.07 em, amber `#b45309` — text `STEP 1 OF 5` … `STEP 5 OF 5`; spacer; five progress dots (5 × 5 px, radius 5, gap 8 px inherited from the row) — dot _i_ is `accent` (forest) when `i < step`, else `oklch(0.88 0.004 262)`.
2. Title: 14 px / 600, `#15181a`.
3. Body: 12.5 px, line-height 1.55, `oklch(0.38 0.008 265)`.
4. Comparison note (only when non-empty — step 1 has none): 11.5 px, `oklch(0.5 0.008 265)`, `border-left: 2px solid oklch(0.89 0.004 262)`, `padding-left: 9px`.
5. Footer row: pending action (11.5 px, amber `#b45309`, flex 1) and a text-only **Skip** button (11.5 px, `oklch(0.55 0.008 265)`, underlined, no border or background).

There is no close ×, no Back, no Next. Tokens: the build maps `#b45309` → amber-700, `accent` → forest-700, neutrals → slate ramp; the oklch values are prototype-only (see the DS digest note on prototype chrome).

### 1.7 Completion toast

Shown for 8 s after step 5 (`tourDone`), z 9002, fixed bottom-centre 22 px up, `background: #14532d` (forest-700), white, radius 9, 12 px text:

> All five done. Replay any time from the ? in your library.

with an outlined **Replay** button (white border at 40 % alpha, radius 6, `padding: 4px 10px`). Replay calls `tourReplay` (ONB-14, ONB-08).

## 2. Library delete and archive

### 2.1 Sidebar

`libNav` gains **Archived** (glyph ▣) between Shared and Recently Deleted. Final order: Recents ◷ · Browse ▭ · Shared ⇪ · Archived ▣ · Recently Deleted ⌫. The header icon/title (`libIcon` / `libTitle`) follow the active view ("Archived").

Empty-state text (`libEmptyText`), 26 px / 600, centred:

| View             | Text                  |
| ---------------- | --------------------- |
| Recently Deleted | `No items`            |
| Archived         | `Nothing archived`    |
| every other view | `No workscapes match` |

### 2.2 Row visibility (`libVisible`)

Per-document state lives in three maps on `S.lib`, keyed by document id: `trashed[id] = timestamp`, `archived[id] = timestamp`, `purged[id] = true`.

- Purged → never shown.
- Recently Deleted view → only trashed.
- Archived view → only archived.
- Recents / Browse / Shared → neither trashed nor archived.

**PRD LIB-D11 requires these to be document states visible to a second client, not per-tab memory; and LIB-D5 requires a 30-day purge that the prototype does not model.**

### 2.3 Toolbar (fourth slot)

The library toolbar is Share ⇪ · Download a copy ⤓ · Send a copy ✉ · **[slot 4]** · More …. Each is a 26 × 26 icon button whose `title` is the tooltip; disabled buttons render in `oklch(0.8 0.006 262)` with `cursor: default` and a no-op handler (shown, never hidden). Slot 4 is chosen per view and selection:

| Condition (in priority order)       | Glyph | Tooltip (`title`, verbatim)                     | Enabled      | Action                          |
| ----------------------------------- | ----- | ----------------------------------------------- | ------------ | ------------------------------- |
| View is Recently Deleted            | ⤺     | `Recover`                                       | row selected | `libRestore(id, 'trashed')`     |
| View is Archived                    | ⤺     | `Unarchive`                                     | row selected | `libRestore(id, 'archived')`    |
| Selected row is the guided sample   | ⌫     | `The guided sample cannot be deleted`           | **never**    | none (LIB-D10)                  |
| Selected row is shared (`d.shared`) | ▣     | `Archive — shared workscapes cannot be deleted` | row selected | `libArchive(id, name)` (LIB-D2) |
| Otherwise                           | ⌫     | `Delete`                                        | row selected | `libTrash(id, name)` (LIB-D1)   |

Prototype shortfalls against the PRD:

- "Shared" is the static fixture flag `d.shared`. LIB-D4 requires the flip to happen at the first **accepted** invitation and to revert when all access is revoked; the prototype has no invitation model.
- The sample's disabled action is the ⌫ glyph with an explanatory tooltip; LIB-D10 asks exactly that, but note the same row is also exempt from Archive (the archive branch is never reached for it).

### 2.4 Recently Deleted footer

The two footer buttons now have handlers and a live enabled state (previously always disabled):

- **Recover All** → `libRecoverAll()` — clears `trashed`. No toast in the prototype (LIB-D9 requires one).
- **Delete All** → `libPurge(allTrashedIds)` — marks every trashed id purged. **No confirmation dialog in the prototype; LIB-D8 requires one that states the action is permanent before proceeding.**
- Enabled when the trash is non-empty: text `oklch(0.52 0.17 25)` (red-ish), `cursor: pointer`; disabled: `oklch(0.8 0.04 25)`, `cursor: default`, `disabled` attribute.

There is no per-item permanent delete; the only permanent action is Delete All.

### 2.5 Toasts (`libToast`)

One toast at a time, fixed bottom-centre 22 px up, z 8999, `background: oklch(0.2 0.01 265)` (slate-900), white 12 px text, radius 9, `padding: 11px 15px`, gap 14 px; auto-dismisses after 7 s; a new toast replaces the current one. When the toast carries an undo, an outlined **Undo** button (white border at 35 % alpha, radius 6, `padding: 4px 10px`) appears; clicking it runs the undo and clears the toast.

| Trigger               | Message (verbatim, `“name”` is the document name in curly quotes) | Undo                                 |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| Delete (to trash)     | `“<name>” moved to Recently Deleted`                              | yes — removes the id from `trashed`  |
| Archive               | `“<name>” archived — participants keep their access`              | yes — removes the id from `archived` |
| Delete All, > 1 item  | `Deleted permanently`                                             | no                                   |
| Delete All, exactly 1 | `Deleted permanently — this one cannot be undone`                 | no                                   |
| Recover / Unarchive   | _(no toast in the prototype)_                                     | —                                    |
| Recover All           | _(no toast in the prototype)_                                     | —                                    |

LIB-D9: "Every delete, archive, recover and unarchive must raise a confirmation. Reversible actions must carry Undo; permanent ones must state that they cannot be undone." The build adds toasts for Recover, Unarchive and Recover All, and the plural Delete All message must also state it cannot be undone.

Selection is cleared (`sel: null`) after every delete, archive, restore, purge and recover-all.

### 2.6 Sample workscape fixture

`LIBDOCS` gains a first entry:

```js
{ id: 'sample', name: 'Q3 Delivery — Guided sample', size: '42 KB', ts: now − 60 s,
  by: 'Me', shared: false, mine: true, when: 'Today', sample: true }
```

- Row's shared column shows `Sample` (where other rows show `By Me` / `By <name>`); the row carries `data-tour="sample"`.
- It is first in Recents only because its timestamp is newest; in Browse sorted by name it sorts alphabetically. **ONB-01 requires it pinned above all other rows in every view.**
- Opening it opens the same fixture document as every other row (`sheet: 'sh3'`). **ONB-01 requires it seeded with the tables, formulas and dates the tour refers to; the build creates it server-side per user.**

## 3. Unchanged

No change to sign-in, the document canvas, inspectors, graphs, find, share sheet, shortcuts, locales, or `support.js`. The tour overlays these without modifying them.
