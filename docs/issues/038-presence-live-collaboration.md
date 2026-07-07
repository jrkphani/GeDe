# 038: Presence + live collaboration affordances

- **Status**: IMPLEMENTED — smallest honest slice built on explicit instruction to proceed despite the demand gate below (see Implementation notes). The "demand validated" acceptance box is deliberately left unchecked: that is a product/process decision this session did not make, not a code gap. Left in `docs/issues/` (not moved to `done/`) per that instruction.
- **Milestone**: M10 (Collaboration polish)
- **Blocked by**: 032 (sync), 034 (workspaces), 035 (membership) — all shipped on `main`

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

- [ ] Demand validated before implementation — **left unchecked**; this session was directed to implement anyway (see below), so the gate itself was never actually exercised.
- [x] If built: presence + ephemeral focus sharing that never persists as domain data; per-user chrome colour distinct from the data palette; all feedback calm and reduced-motion safe.
- [x] `npm run verify` green — 810 unit tests (was 771; +39 for this issue), 49 e2e, typecheck/eslint/stylelint clean.

## Implementation notes (this session)

Built exactly the test-first plan's four items, as the smallest honest slice, with one deliberate protocol addition (a `hello` handshake — see below) and several flagged scope cuts rather than invented scope.

**No schema change** — presence is genuinely ephemeral; no migration was added (no `0012`), no `src/db/**` module was touched or imported by any presence file.

**Architecture** (mirrors 032's own read-path split):
- `src/domain/presence.ts` — pure roster reducer (`applyPresenceEvent`), stale-entry pruning, cue derivations (`selectorsOfContext`/`editorsOfContext`), deterministic per-user color (`assignPresenceColor`, hash-seeded per ADR-0005's no-randomness spirit), and STYLE_GUIDE §9 voice (`presenceCueLabel`).
- `src/presence/presenceChannel.ts` — the DI-testable transport seam (`PresenceChannelLike`/`startPresence`), structurally identical to `syncEngine.ts`. Real default (`defaultPresenceChannelFactory`) is the browser `BroadcastChannel` API, workspace-namespaced.
- `src/store/presence.ts` — lifecycle + wiring: gated on `isSyncEnabled()` (032's flag) **and** a signed-in identity (033); reactively republishes `useContextsStore`'s `selectedContextId` (a one-way read, contexts.ts has zero presence awareness); exposes `usePresenceCues(contextId)` and `useOnlinePresence()`.
- `src/shell/PresenceRoster.tsx` — app-bar cluster chips (join/leave, plan #1), gated the same way `WorkspaceMembers`/`SyncIndicator` self-hide.
- `src/components/ContextRegister.tsx` — a `PresenceCue` beside the existing completeness status-dot: hollow = someone else has this context selected (plan #2), filled = someone else is editing it (plan #3).
- `src/components/EditableGrid.tsx` — added one optional prop, `onEditingChange?: (cell: EditingCell | null) => void`, reporting the grid's existing `editing` state; exported `EditingCell`. Purely additive — every existing caller is unchanged.

**Protocol addition beyond the issue text**: a plain pub/sub channel (BroadcastChannel or the test fakes) has no replay for a late subscriber, so a tab joining an already-populated workspace would otherwise see an empty roster until the next ~15s heartbeat. Added a `hello` handshake event: a new peer announces itself and existing peers reannounce immediately in response. `hello` is transport-level only — it never reaches the domain reducer as a presence fact.

**Deliberate scope cuts (flagged, not oversights)**:
1. **Cross-network transport**: `BroadcastChannel` is same-origin/same-browser only — genuinely functional for multi-tab collaboration today, but does **not** share presence across two different devices/browsers over the network. True cross-network presence needs new server infra (a WebSocket route behind the ALB, or a future Electric presence primitive) that this issue does not build — standing that up before there's evidence anyone wants this is exactly the over-building the issue's own "validate demand first" framing warns against.
2. **Editing-hint grain**: the same-cell hint (plan #3) is wired through `EditableGrid`'s shared `editing` state, which only covers text/mono/multiline cells (Symbol, Justification) — a dimension-binding combobox cell manages its own open state internally and isn't wired to this signal. The underlying domain model (`FocusedCell{contextId, field}`) is field-grain and fully correct/tested; the visible UI hint in this slice is field-grain where it's cheap (Justification) and otherwise degrades gracefully (no cue) rather than either mis-attributing a combobox edit or requiring deeper `ComboboxCell` surgery on a shared, heavily-used primitive.
3. **Canvas**: the design brief mentions a focus cue "in the register and/or canvas" — only the register (`ContextRegister`) is wired. `Canvas.tsx`/`DesignSurface.tsx` were left untouched to avoid risk on an already-shipped, SVG/d3-adjacent surface with its own adjacency-focus/opacity-emphasis machinery (issue 028); presence there would be a natural follow-up, not built here.
4. **No demand validation**: per this session's instructions, implemented despite the issue's own "validate demand first" framing — flagged explicitly rather than silently checking that acceptance box.

**Reduced-motion (plan #4)**: presence cues use no CSS transition at all — they mount/unmount via ordinary conditional rendering, which is instant by construction and needs no `prefers-reduced-motion` override.

Originally deliberately last in the v2 set and marked speculative — the durable path (032–037) delivers collaboration; presence is polish that should follow evidence, not precede it. That framing is unchanged; this session built the slice on explicit instruction, not because demand was confirmed.
