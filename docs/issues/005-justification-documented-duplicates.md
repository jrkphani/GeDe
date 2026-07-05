# 005: Justification, documented status, duplicate-tuple warning

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 004

## Slice

As a designer I record *why* a combination matters, and the app tells me when a tuple is already taken — without ever blocking me (SPEC invariant 2: capacity, not completeness).

## Scope

- Justification cell in the register (in-place, multiline-capable).
- Documented status: complete bindings **and** non-empty justification.
- Duplicate detection via `tuple_hash`: creating/editing a context onto an existing tuple shows a non-blocking inline badge listing the existing context symbol(s) (STYLE_GUIDE §4 — muted badge, never a popup).

## Test-first plan

1. Unit: documented selector — complete + justified = documented; complete + empty justification = not documented.
2. Unit: duplicate detection returns existing context ids for a tuple; save is **not** rejected.
3. Component: badge renders on the duplicate row, names the sibling symbol, disappears when either context re-binds away.
4. e2e: two contexts on the same tuple both save; both appear in the register with warning badges.

## Acceptance criteria

- [ ] No code path blocks a save due to tuple duplication.
- [ ] Documented status never gates saving, exporting, or navigation (SPEC invariant 2 wording).
- [ ] Warning copy follows STYLE_GUIDE §7 voice (quiet, specific).
