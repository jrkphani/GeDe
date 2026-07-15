# 059: Interim honest-UX guard — Share UI stops implying success while cloud sharing is unbuilt

- **Status**: CLOSED — superseded, never implemented, now archived. This was an interim "sharing not available yet" guard for the case where the real fix (056→057→058) was *deferred*. Since 056, 057, and 058 all landed (commits `5b20079`, `966db95`, `1630af1`) and make cloud sharing actually work, shipping a banner that says sharing is unavailable would be self-contradictory. Its one narrow re-open escape hatch — "if the live 058 read-path is later found not to stream" — is also now spent: **078 fixed exactly that stale-shape streaming failure and the full sharing chain (055/#8) is verified live end-to-end** (see `done/055`, `done/078`, `done/080`). There is no remaining condition under which this guard would be honest to ship. Retained only as a record; its Test-first plan and UX copy stay on file should a future, unrelated "feature not yet available" honesty note ever want a precedent.
- **Milestone**: M9 (Identity & tenancy) — a UX mitigation, not part of the 056→057→058 architecture chain
- **Blocked by**: none — independent of 056/057/058, can ship before, during, or after them

## Slice

This is part of the 055 sharing fix (056 → 057 → 058 is the real architecture fix; **059 is an immediate, independent mitigation** that can ship today without waiting on any of it). Until 056-058 land, `WorkspaceMembers.tsx`'s "Share" flow silently succeeds locally while doing nothing observable for the invited user (055's whole bug report). This issue makes the UI **honest** about that gap — it does not fix the gap.

## Problem / Goal

055's "Interim UX guard" section:

> Until the above lands, the Share UI is misleading — it implies success. Consider gating/labelling the Share action (or surfacing "sharing is not yet available in the cloud build") so testers/users aren't told a share happened when nothing leaves the device.

Concretely, today: `WorkspaceMembersPanel.onInvite()` (`src/components/WorkspaceMembers.tsx:76-86`) calls `invite(trimmed, inviteRole)`, clears the email field, and shows **no** error — from the user's point of view the invite "worked." The only failure path shown (`error` state, line 70/177-181) is a thrown exception from `invite()` itself (e.g. "Sign in to invite collaborators," `workspace.ts:82`), never a "this didn't actually reach anyone" signal, because today it genuinely doesn't (055 Cause 1).

**Goal**: add a calm, STYLE_GUIDE §9-consistent note near the invite form (or gating the action outright, if that reads better once implemented) that tells the sharer their invitation stays local-only for now — not a toast, not a blocking error, matching this codebase's existing "quiet chrome" / inline-note conventions (e.g. `ProjectsList`'s `.import-error`, `WorkspaceMembersPanel`'s own `.ws-invite-error`).

## Design brief

- **Read-only truth-telling, not a feature removal.** Do NOT disable the invite form or hide Share entirely — a sharer may still want to record intent, and disabling it outright would be a bigger behavior change than 055 asks for. Prefer a persistent, calm inline note (STYLE_GUIDE §9's "read-only reads as calm, not broken" posture, borrowed from 035's own viewer-affordance work) near the invite form, e.g. under the email input: *"Invitations aren't delivered yet in this build — your collaborator won't be notified."*
- **Gate the note on whether it's actually true**, not hardcode it forever: once 056 (client wiring) ships, the invitation DOES leave the browser, even before 057/058 make it visible to the recipient — so the exact wording should probably evolve issue-by-issue (056 landing changes "local-only" to "sent, but they can't see the project yet" once 057/058 are also in). Simplest correct implementation for 059 alone: a single feature-readiness flag/constant (e.g. `SHARING_DELIVERS_TO_RECIPIENT = false` in a small config module, or inline in `WorkspaceMembers.tsx`) that 058's own issue flips — avoids leaving a stale, confusing message live after the real fix ships. Note this explicitly in the 058 issue's acceptance criteria as a followup (already reflected there is not required — this issue is self-contained; a human/agent picking up 058 should grep for this flag).
- **Don't block on auth/session state** — the note applies whenever Share is visible at all (which is already gated to signed-in Cognito sessions only, `WorkspaceMembers.tsx:194`), independent of `isSyncEnabled()`/`VITE_SYNC_ENABLED` — it is not solely a sync-flag question, since even with sync enabled today (048/050 shipped, cloud writes ARE live for other tables) sharing specifically still doesn't reach anyone (055's whole point).

## Files / layers touched

- `src/components/WorkspaceMembers.tsx` — add the inline note (new JSX + a class, e.g. `ws-invite-caveat`, following the existing `ws-invite-error`/`ws-members` naming); a small readiness constant/flag as described above.
- A stylesheet wherever `.ws-invite-error`/`.ws-members` are styled (locate via `grep -rn ws-invite-error src` — likely a CSS module or the shared stylesheet the STYLE_GUIDE governs) — add matching calm styling for the new note (not an error color; STYLE_GUIDE §9's neutral/informational tone, distinct from the red `.ws-invite-error`).

## Test-first plan

1. **Component test** (locate/extend the nearest existing `WorkspaceMembers`-adjacent test, or add `src/components/WorkspaceMembers.test.tsx` if none exists — confirm via `find src/components -iname "*WorkspaceMembers*"` before writing): render `WorkspaceMembersPanel` for a signed-in owner and assert the caveat note text is present in the DOM whenever the invite form itself renders. Currently red — no such note exists today.
2. **Accessibility**: assert the note is NOT `role="alert"` (it's informational, not an error — distinct from the existing `.ws-invite-error`'s `role="alert"`) so it doesn't interrupt screen-reader flow on every render.
3. **No regression on the real invite flow**: an existing test (or a new one) confirms `onInvite()` still calls `invite()` and clears the email field exactly as before — this issue changes messaging only, never behavior.

## Acceptance criteria

- [ ] A calm, non-blocking note near the invite form tells the sharer that invitations are not yet delivered to the recipient.
- [ ] The note does not use `role="alert"` / does not read as an error.
- [ ] The existing invite flow (`invite()` call, local PGlite write, email-field clear) is unchanged.
- [ ] Test-first plan items pass; `npm run verify` green.

## Dependencies / ordering

None — ships independently, before or in parallel with 056/057/058. Recommend shipping this FIRST (lowest risk, smallest surface, addresses the "silently misleading" severity flag from 055 immediately) while 056-058 proceed on their own schedule.

## Risks

- **Low risk overall** — this is copy + a small conditional, not an architecture change. The only real risk is scope creep (turning this into a bigger redesign of the Share panel) or leaving the caveat stale after 056/057/058 ship (addressed above via the readiness-flag suggestion).
- **Wording precision matters more than usual here** — 055's severity rating is "High (a shipped, user-visible feature silently does nothing)"; a vague or easily-missed note doesn't actually fix the honesty problem. Keep it visible without being alarming (STYLE_GUIDE §9).

**References**: 055 (this bug, "Interim UX guard" section — the section this issue directly implements), 035 (`done/035-sharing-roles-invitations.md` — `WorkspaceMembers.tsx`'s existing conventions, viewer read-only "calm, not broken" precedent), STYLE_GUIDE §9 (read-only/error tone), `ProjectsList`'s `.import-error` and `WorkspaceMembersPanel`'s own `.ws-invite-error` (the existing inline-message pattern this issue's new note should visually cohere with, not duplicate as a second error style).
