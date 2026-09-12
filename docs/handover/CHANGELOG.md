# Changelog — handover package

## 2026-09-12

Two features added to the prototype since the last package. Both are now
specified in PRD §24 as the ONB and LIB-D requirement blocks — read the PRD,
not this file, for the binding wording. The summary below is orientation only.

### First-run guided tour (ONB)

Five-step coachmark tour over the real UI. Starts automatically the first time
a user reaches the library after sign-in, including users arriving from a
shared link. Direction 1a of the options explored in
`specs/GeDe First Run.dc.html`.

Steps, in order — each advances only when the user performs the action, never
on a Next button:

1. Open the sample workscape (`Q3 Delivery — Guided sample`)
2. Reference a cell in another table (any `=` formula or `=@` entity ref)
3. Add a context graph (toolbar)
4. Find across every table (`⌘F`)
5. Invite someone by email (Share)

| ID | Requirement |
|---|---|
| ONB-1 | A workscape named `Q3 Delivery — Guided sample` is present in every library, pinned first, flagged `Sample`. It cannot be deleted or archived. |
| ONB-2 | The tour starts on first arrival at the library and only if `gede.tour.done` is unset. |
| ONB-3 | Completion, or Skip, sets `gede.tour.done`. Server-side per-user flag in production; localStorage in the prototype. |
| ONB-4 | Each step spotlights its target element by live bounding box, re-measured on scroll, resize and layout change. Step 2 has no single target and centres its card. |
| ONB-5 | A step advances only on the user completing the action. There is no Next control. |
| ONB-6 | Skip is available on every step and ends the tour permanently. |
| ONB-7 | Replay is available from the `?` control in the library header and clears the flag. |
| ONB-8 | Each card carries: step counter, progress dots, title, instruction body, a Numbers-comparison note, and the pending action in amber. |
| ONB-9 | Copy names the iCloud Numbers equivalent then the difference. Nothing Numbers already teaches is taught. |
| ONB-10 | All tour strings are localisable and sit in the same catalogue as the rest of the UI. |
| ONB-11 | The scrim is non-interactive; the spotlit element remains fully operable. |
| ONB-12 | The tour does not run below 768 px, where documents are read-only. |

### Library delete and archive (LIB-D)

Deletion is conditional on whether the workscape has ever been shared.

| ID | Requirement |
|---|---|
| LIB-D1 | An unshared workscape can be deleted. The toolbar action reads `Delete`. |
| LIB-D2 | A shared workscape cannot be deleted. The same toolbar slot becomes `Archive`, with a tooltip stating why. |
| LIB-D3 | Archiving preserves participants' access and all share links. It removes the workscape from the owner's active views only. |
| LIB-D4 | Deleting moves the workscape to `Recently Deleted`, from which it is recoverable. |
| LIB-D5 | The sidebar has an `Archived` view listing archived workscapes, each unarchivable. |
| LIB-D6 | `Recently Deleted` offers per-item Recover, Recover All, and Delete All. |
| LIB-D7 | `Delete All` is permanent and irreversible. Its confirmation says so. |
| LIB-D8 | Every delete, archive, restore and unarchive raises a toast. Reversible actions carry Undo; permanent ones state that they cannot be undone. |
| LIB-D9 | The guided sample is exempt from both delete and archive. |
| LIB-D10 | Server side: retention on `Recently Deleted` is 30 days, after which purge is automatic. Archive has no expiry. |

### Open items for the build team

- ONB-3 and LIB-D10 need server-side state; the prototype fakes both in memory.
- Archive and trash need to be modelled as document states, not library-local
  flags — a second client must see the same state.
- Sharing a workscape must flip its deletability at the moment the first
  invitation is accepted, not when it is sent.
