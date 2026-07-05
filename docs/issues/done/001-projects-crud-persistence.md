# 001: Create, list, open a project — and survive reload

- **Status**: SHIPPED
- **Milestone**: M1
- **Blocked by**: 000

## Slice

As a designer I can create a named project, see it in the projects list, open it, and find it again after closing the browser.

## Scope

- Store: `createProject`, `renameProject`, `archiveProject` (soft delete) through the single mutation layer.
- UI: projects list (name + description, in-place rename per style guide §4), open → empty project shell with tier tabs.
- Persistence: PGlite on OPFS/IndexedDB in the real app; in-memory in tests.

## Design brief

- **Screen**: projects list — a single paper panel centered on the graph paper, most-recent first. Goal: from launch to inside a project in under 5 seconds.
- **Empty state (first run)**: no dashboard chrome — the panel shows a phantom row with ghost text "Name your first project". Typing creates it; there is no "Create" button and no modal (STYLE_GUIDE principle 2).
- **Row anatomy**: name (Inter 14), description (muted), last-opened (muted, right). Hover reveals rename/archive affordances; rows are quiet at rest.
- **Destructive flow**: archive is instant + undoable via a quiet status line ("Archived *Tavalo* — Undo"), not a confirm dialog — undo replaces confirmation (snappy principle 5).
- **Loading**: PGlite open is typically <100ms — no spinner under 150ms; beyond that, the wordmark pulses once. No skeletons for a local list.
- **Error state**: storage unavailable (OPFS denied/private mode) renders a specific panel: what happened + "Export/import will still work from memory this session."
- **Focus & keyboard**: list is arrow-navigable; Enter opens; F2 or click renames in place. Tab order: wordmark → list → (nothing else exists yet).
- **Touch**: rows are 44px minimum targets.

**References**: SPEC §3 (schema), §4.1 · SITEMAP §1 (`/` route), §2 (app bar on projects list) · STYLE_GUIDE §2.1 (panels), §6 (grammar), §9 (voice) · TECH_STACK §2

## Test-first plan

1. Unit: `createProject` emits a row with UUIDv7 id + timestamps; `archiveProject` sets `deleted_at` and hides it from the list selector.
2. Component: projects list renders rows; click name → in-place input; Enter commits, Esc reverts (first exercise of the editing grammar).
3. e2e: create project → hard reload → project still listed and opens.

## Acceptance criteria

- [ ] Reload durability proven by the e2e test.
- [ ] All writes flow through the mutation layer (no direct db calls from components) — enforced by a lint boundary or module convention stated in the code.
- [ ] Soft-deleted projects never appear in selectors.
