# 083: Tier editing lockout — a not-yet-streamed self-membership row snaps the whole app read-only

- **Status**: OPEN — diagnosed, not yet fixed (filed file-only; no source edits in this issue).
- **Severity**: High — a signed-in user can be locked out of editing their own or a shared project across **all three tiers at once** (Foundation, Architecture, Design), with no error and no visible cause.
- **Milestone**: M6 (sharing hardening, same track as 067/078/080) — client role-resolution + a store-action feedback gap. No schema change; no synced-column ripple.
- **Blocked by**: none. Independent of the 082 Design-route worktree — the fix lives in `workspace.ts`/`workspaceRole.ts` and the tier store actions, **not** in the shared `inline-editor.tsx` primitives 082 is editing (coordination note below).

## User story

As a signed-in collaborator (a first-time invitee, or an owner returning after a sign-out wipe), I open a project and **the "add" affordance is gone / does nothing** — I cannot add a table in the 2nd Tier, and I see the same in the 1st Tier. Nothing tells me why. I have write access on the server, but the app is showing me a read-only surface (or silently swallowing my add), so it "reads as broken, not calm."

## Investigation summary (verified file:line chain)

The add chain itself is correct end to end and its unit tests pass — the break is at the **UI role gate**, with a **silent-failure** secondary that hides any add rejection:

- **Tier-2 add-table input** — `ArchitectureSurface.tsx:86-91` renders `PhantomInput ... onSubmit={(name) => void addTable(name)}`, wrapped in a section gated at `ArchitectureSurface.tsx:84` on `readOnly ? null : (...)`.
- **The primitive fires correctly** — `inline-editor.tsx:125-161` (`PhantomInput`); the Enter handler (`:146-156`) calls `onSubmit` on `Enter && draft.trim() && !submittingRef.current`, clears, refocuses, resets the re-entrancy guard in `.finally`. No swallowed submit.
- **Store action is correct** — `tier2.ts:227-245` `addTable`: `bump()` → `dbAddTable` → `reloadTables(projectId)` (which does `set({ tables, entriesByTable })`) → `enqueueIfSyncing` → command-log push. Unit test `tier2.test.ts:45-46` ("addTable persists and is one undo step") passes.
- **Mutation is correct** — `mutations.ts:1073-1085` `addTier2Table` inserts `{id, projectId, workspaceId, name, sort}`; resolves `workspaceId` via `projectWorkspaceId` (`mutations.ts:38-44`).
- **Re-render path is correct** — `tables` is subscribed at `ArchitectureSurface.tsx:38`; `TablePanel` maps it at `:78-80`. `addTable`'s own `reloadTables` refreshes synchronously; the 075B delta subscription (`tier2.ts:215-224`) covers inbound deltas behind the generation guard. **The 072/075 "mutation succeeds but the store never refreshes" mode does NOT apply here** — it is already handled.

Because the data path is sound and its tests pass, the failure is one of the two shared gates below. The literal input widgets differ across tiers (Tier-2 add-table uses `PhantomInput`; Tier-1 add-value-prop and Tier-2 add-entry use `EditableGrid`'s `PhantomCell`, `EditableGrid.tsx:565-614`), so the shared cause is **not** the input component — it is the `readOnly`/role gate they all sit behind, and the fire-and-forget call sites.

## Root cause

### Primary — Cause A: the role gate snaps to `'viewer'`

`resolveEffectiveRole` (`src/domain/workspaceRole.ts:47-62`) returns `'viewer'` at its **final line** — `return mine?.role ?? 'viewer'` (`workspaceRole.ts:62`) — whenever **all** of:

1. auth is configured, and
2. the user is signed in (`userSub !== null`, so it does not short-circuit to `'owner'` at `:54`), and
3. `members.length > 0` (so it does not short-circuit to `'owner'` at `:58`), and
4. the signed-in `sub` is **not** among `members` (`mine` is `undefined` at `:59`).

That single line collapses `role` to `'viewer'`, which flips `readOnly = !canWrite(role)` true and turns off the add affordance in **all three surfaces at once**:

- `ArchitectureSurface.tsx:84` — the add-table section renders **`null`** (no `PhantomInput`).
- `FoundationSurface.tsx:177` — renders the **read-only `EditableGrid` (no phantom)** branch instead of the `DndContext` + phantom branch.
- `EditableGrid.tsx:668` — `const activePhantom = readOnly ? undefined : phantom` suppresses the phantom row (Tier-2 add-entry, and Tier-1's grid).

`computeRole` (`src/store/workspace.ts`, `computeRole`/`load`) feeds `resolveEffectiveRole`, and `useWorkspaceRole` (`src/store/workspace.ts`, `useWorkspaceRole`) exposes the result to the surfaces.

**Why it fits the current deployment (post-078/080 sharing):** a first-time invitee — or an owner after 063's clear-on-sign-out local wipe — can have **other** members' `workspace_members` rows stream into local PGlite **before their own** does. `members` is then non-empty but the caller is absent from it → `'viewer'` → locked out until (and unless) their own membership row materializes. This is a **067-class self-membership-materialization gap**: 067 made `workspace_members` stream and re-derive on `membersAppliedAt`, but nothing guarantees *self* arrives before (or alongside) the others, and `resolveEffectiveRole` treats "self not yet present" identically to "confirmed viewer."

In solo/local mode `resolveEffectiveRole` short-circuits to `'owner'` (`workspaceRole.ts:52-58`), which is why every unit test and local-dev session sees add working — the bug only manifests signed-in against a shared/multi-member workspace.

### Secondary — Cause B: fire-and-forget add with zero error surface

All three add call sites discard the promise and any rejection:

- `ArchitectureSurface.tsx:90` — `onSubmit={(name) => void addTable(name)}`
- `ArchitectureSurface.tsx:330` — `onCreate: (name) => void addEntry(table.id, null, name)`
- `FoundationSurface.tsx:209` — `onCreate: (name) => void addProp(name)`

There is **no `try/catch`, no `.catch`, no `useStatusStore.announce`** anywhere in the add path. `addTier2Table` / `addTier1Prop` / `addTier2Entry` each resolve a workspaceId via `firstOrThrow` (`src/db/util.ts:8`), which **hard-throws** if a local FK-ancestor row is missing or the insert's `.returning()` comes back empty (an FK / NOT-NULL violation on `workspace_id`). Any such rejection is silently swallowed — indistinguishable from a no-op.

Note the useful asymmetry: **rename / description / reorder / remove do NOT resolve a workspaceId**, so a throw in the workspace-id resolution breaks **add specifically** while edits keep working. (This is the disambiguator in the next section.)

## Confirm before fixing (must-do disambiguator)

Run these first — A and B need different fixes:

1. **Is the add input visible at all?** Absent → **Cause A** (role gate hides the affordance). Present but Enter is a no-op → **Cause B** (silent rejection).
2. **Can you rename an existing row/table?** No, the whole surface is read-only → **Cause A**. Yes, but only *add* fails → **Cause B** (throw inside the add-only workspace-id path).
3. **Log the collapse directly:** compare `useWorkspaceRole(projectId).role` vs `useWorkspaceStore.getState().members` vs `useAuthStore.getState().user?.sub`. If `role === 'viewer'` while `members` is non-empty and your `sub` is absent from it → **Cause A confirmed** at `workspaceRole.ts:62`.

## Fix direction (do NOT collide with the 082 worktree)

**For Cause A** (`workspace.ts` / `workspaceRole.ts` only — does not touch `PhantomInput`/`InlineEdit`):
- Close the 067-class gap: ensure the signed-in user's own `workspace_members` row is **seated and streamed** (or seeded locally on accept/sign-in) so `members` is never non-empty-without-self during normal operation.
- And/or make `resolveEffectiveRole` **fail OPEN to a distinct "role loading / unknown" state** rather than snapping to `'viewer'` while `members` is still catching up — i.e. distinguish "self confirmed absent" from "self not yet materialized." A `'loading'`/`unknown` state keeps the surface interactive (or shows an explicit "checking your access…" state) instead of a silent read-only wall.

**For Cause B** (store actions or call sites — **not** the shared `inline-editor.tsx` primitive):
- Surface add failures via `useStatusStore.announce` (the app's one sanctioned feedback channel, already used at `ArchitectureSurface.tsx:166`). Put the feedback in the **store actions** (`addTable`/`addProp`/`addEntry`) or the **call sites**, so a failed add is a calm message, never a silent no-op.

**Coordination note:** the 082 Design-route agent is actively editing `src/components/ui/inline-editor.tsx` (082 doc, Phase 1 / Files-touched #3). Do **not** add error handling inside `PhantomInput`/`InlineEdit` — keep 083's changes in `workspace.ts`, `workspaceRole.ts`, and the tier store actions to avoid a merge collision with that worktree.

## Files / layers likely touched

1. `src/domain/workspaceRole.ts:47-62` — `resolveEffectiveRole`: introduce a fail-open "role loading/unknown" outcome distinct from confirmed `'viewer'`.
2. `src/store/workspace.ts` — `computeRole` / `load` / `useWorkspaceRole`: thread the loading/unknown state; ensure self-membership is seated/streamed before deriving a restrictive role.
3. `src/store/tier2.ts` (`addTable`, `addEntry`) and `src/store/tier1.ts` (`addProp`) — announce failures via `useStatusStore` instead of letting a rejection escape into the fire-and-forget `void`.
4. Consumers of `role`/`readOnly` (`src/components/ArchitectureSurface.tsx:84,90,330`, `src/components/FoundationSurface.tsx:177,209`, `src/components/EditableGrid.tsx:668`) — render the "role loading" state as interactive-or-explicit, not a silent read-only wall (verify only; ideally no change if the store models the state).

## Test-first plan (red first)

1. **`resolveEffectiveRole` — self absent from non-empty members** (`src/domain/workspaceRole.test.ts`): given auth configured, `userSub` set, `members` non-empty but not containing `userSub`, assert the **desired loading/fail-open** result (not a hard `'viewer'`). Red today: `workspaceRole.ts:62` returns `'viewer'`.
2. **Store action announces a failed add** (`src/store/tier2.test.ts` / `src/store/tier1.test.ts`): when the underlying mutation rejects, assert `useStatusStore` receives an announce (the add does not silently swallow). Red today: `void addTable(name)` / `void addProp(name)` discard the rejection with no feedback.
3. **Surface keeps the add affordance under "role loading"** (`src/components/FoundationSurface.test.tsx` and `src/components/ArchitectureSurface.test.tsx`): with role still resolving (self-membership not yet streamed), assert the phantom / add-table input is **present** (or an explicit "checking access" state), not a silent read-only surface. Red today: `readOnly` is true, so `ArchitectureSurface.tsx:84` renders `null` and `EditableGrid.tsx:668` drops the phantom.

## Acceptance criteria

- [ ] An owner or seated member is **never** shown read-only purely because their own `workspace_members` row has not yet streamed into local PGlite (Cause A closed). Test 1 passes.
- [ ] A failed add surfaces a **calm status message** (`useStatusStore.announce`) — never a silent no-op (Cause B closed). Test 2 passes.
- [ ] The add affordance is present (or an explicit access-loading state shows) while role is still resolving; the surface never silently collapses to read-only mid-load. Test 3 passes.
- [ ] No `dangerouslySetInnerHTML` / security regressions introduced.
- [ ] **Does not touch the 082-owned primitives** (`src/components/ui/inline-editor.tsx`) — changes are confined to `workspace.ts`, `workspaceRole.ts`, and the tier store actions.
- [ ] `npm run verify:fast` green (`npx tsc --noEmit`, `npx eslint . --quiet`, `npx stylelint`, vitest).

## References

- Code (verified file:line): `src/domain/workspaceRole.ts:47-62` (`resolveEffectiveRole`, final `?? 'viewer'` at `:62`), `src/store/workspace.ts` (`computeRole`, `load`, `useWorkspaceRole`), `src/components/ArchitectureSurface.tsx:84,90,330`, `src/components/FoundationSurface.tsx:177,209`, `src/components/EditableGrid.tsx:668`, `src/components/ui/inline-editor.tsx:125-161`, `src/db/mutations.ts` (`addTier2Table` `:1073-1085`, `addTier1Prop` `:951-971`, `addTier2Entry` `:1164-1185`, `projectWorkspaceId` `:38-44`), `src/db/util.ts:8` (`firstOrThrow`).
- Related issues: `done/067` (stream `workspace_members` + re-derive on `membersAppliedAt` — the self-membership precedent this gap sits inside), `done/063` (clear-on-sign-out local wipe — one way self's row is missing on return), `done/080` (dedicated server-authoritative `/accept` invitation redemption — the invitee entry path).
- **See also:** the pending Tier-2 (Architecture) UX audit — add-table flow, empty-state guidance, keyboard-rapid-entry, token/a11y findings — to be filed separately as **084** (not folded into 083).
- `docs/STYLE_GUIDE.md` §1 ("read-only reads as calm, not broken"), §10 (a11y baseline) · `docs/SITEMAP.md` §2 (per-surface chrome).
