# 001: Create, list, open a project — and survive reload

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 000

## Slice

As a designer I can create a named project, see it in the projects list, open it, and find it again after closing the browser.

## Scope

- Store: `createProject`, `renameProject`, `archiveProject` (soft delete) through the single mutation layer.
- UI: projects list (name + description, in-place rename per style guide §4), open → empty project shell with tier tabs.
- Persistence: PGlite on OPFS/IndexedDB in the real app; in-memory in tests.

## Test-first plan

1. Unit: `createProject` emits a row with UUIDv7 id + timestamps; `archiveProject` sets `deleted_at` and hides it from the list selector.
2. Component: projects list renders rows; click name → in-place input; Enter commits, Esc reverts (first exercise of the editing grammar).
3. e2e: create project → hard reload → project still listed and opens.

## Acceptance criteria

- [ ] Reload durability proven by the e2e test.
- [ ] All writes flow through the mutation layer (no direct db calls from components) — enforced by a lint boundary or module convention stated in the code.
- [ ] Soft-deleted projects never appear in selectors.
