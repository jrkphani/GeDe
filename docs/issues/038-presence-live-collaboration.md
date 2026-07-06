# 038: Presence + live collaboration affordances

- **Status**: OPEN (speculative — validate demand before building)
- **Milestone**: M10 (Collaboration polish)
- **Blocked by**: 032 (sync), 034 (workspaces), 035 (membership)

## Slice

As collaborators editing the same project we can see **who else is here and what they're touching** — presence in the shell, and a light indication of another user's selected context / focused cell — so concurrent work feels shared, not surprising.

## Motivation

Row-delta sync (032) already makes edits *converge*; presence makes them *legible in the moment*. But presence is a distinct, ephemeral channel (who's online, cursors/selection) — not durable domain data — so it should not be built until the durable collaboration path (032–035) is solid and there's evidence people co-edit closely enough to want it. **Confirm demand first; this issue may stay parked.**

## Scope (if pursued)

- **Presence roster**: who is currently in a workspace/project, in the app-bar cluster (quiet chrome).
- **Ephemeral focus sharing**: another user's selected context (009's `selectedContextId`) and/or focused register cell shown lightly — a coloured ring/label keyed to the user, **not** persisted (ephemeral channel, never a synced row — ADR-0005 spirit: only durable domain data persists).
- **Conflict-in-the-moment cue**: two users editing the same cell get a gentle "X is editing" hint before LWW silently resolves (softens 032/036's after-the-fact conflict note).

Out of scope: operational-transform / character-level co-editing (LWW at row grain is the model, 032 — do not escalate to OT here), voice/chat, comments/annotations (their own feature if wanted), anything that persists presence as domain rows.

## Design brief

- **Ephemeral ≠ synced data**: presence rides a separate transient channel (the sync engine's presence primitive if it has one, else a lightweight broadcast); it never becomes a row and never touches the migration history (SPEC §3, ADR-0005).
- **Quiet and colour-as-identity** (STYLE_GUIDE §2/§4): a collaborator's cue uses a per-user chrome colour distinct from the *data* palette (principle 3: data colour is dimensions only) — so presence never reads as a dimension.
- **Calm** (§8): presence updates are ambient, ≤100ms, no jitter; reduced-motion safe.

**References**: issues 032 (durable sync — the layer this sits above, not within), 034/035 (who's in the workspace), 009 (`selectedContextId` as the shareable focus), 016 (shell/status) · STYLE_GUIDE §2 (colour-as-data vs chrome), §4, §8 · ADR-0005 (only durable domain data persists) · SPEC §1.

## Test-first plan

*(Gated on the demand check.)*

1. Presence roster reflects join/leave within the workspace.
2. A second client's selected context renders as an ephemeral, per-user cue that never appears in any synced delta or the DB (assert it's not persisted).
3. Same-cell concurrent edit shows the "editing" hint; LWW still resolves durably via 032.
4. Reduced-motion: cues are instant and legible.

## Acceptance criteria

- [ ] Demand validated before implementation (this issue does not auto-proceed).
- [ ] If built: presence + ephemeral focus sharing that never persists as domain data; per-user chrome colour distinct from the data palette; all feedback calm and reduced-motion safe.
- [ ] `npm run verify` green.

## Notes

Deliberately last in the v2 set and marked speculative — the durable path (032–037) delivers collaboration; presence is polish that should follow evidence, not precede it.
