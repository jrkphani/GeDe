# 016: App shell — routes, header, tabs, status bar

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 001

> Pick this immediately after 001 — every tier surface (004, 013, 014) mounts into slots this shell provides.

## Slice

As a designer I move between projects and tiers through a stable shell: app bar with tier tabs, per-tier context bar slot, persistent status bar, working URLs and browser history.

## Scope

- Router with the full SITEMAP §1 route map (tier routes, design depth segments, `view` param, not-found, last-tier redirect); deep links restore tier/depth/view.
- App bar per SITEMAP §2: wordmark, in-place project rename, tier tabs (⌘1/2/3), undo/redo buttons (wired fully in 006), theme toggle, project menu shell.
- Context bar as an empty slot component (tiers fill it in later issues; hidden when empty).
- Status bar with the narration region (`aria-live`) and ambient-count slots.
- Responsive shell behavior per SITEMAP §5; theme toggle persists.
- Out of scope: ⌘K palette (017), context-bar contents (002/011/012), menu actions (015).

## Design brief

- **Chrome bands are fixed**: 40/32/28px, hairline-separated, panels opaque on the graph paper; the page never scrolls — surfaces do.
- **Tabs**: active = ink + 2px accent underline flush with the bar hairline; no pill, no background (STYLE_GUIDE §4 zero-radius).
- **Theme toggle**: instant swap (no transition wash), both themes verified per issue from here on.
- **Empty context bar collapses** — no dead 32px band on Foundation.
- **Status bar is the only feedback channel**: nothing in the shell toasts, badges, or bounces.
- **Not-found**: quiet panel, "Back to projects", no illustration.

**References**: SITEMAP §1–5 · SPEC §4.1 · STYLE_GUIDE §2, §4, §8 · issue 006 (narration region contract)

## Test-first plan

1. Unit: route parsing/serialization round-trips for every SITEMAP §1 shape (incl. depth segments + view param); unknown routes yield not-found.
2. Component: tier tabs render/activate per route; ⌘1/2/3 navigate; active tab styling asserted by token, not hex.
3. Component: context bar hides when its slot is empty; status bar live region announces a pushed narration.
4. e2e: deep-link to `/p/:id/design?view=coverage` → correct tier + view; browser back walks history; reload restores; theme survives reload.

## Acceptance criteria

- [ ] Every route in SITEMAP §1 is reachable, deep-linkable, and history-correct.
- [ ] Shell bands match SITEMAP §2 anatomy at all three responsive tiers (§5).
- [ ] Feature surfaces mount via slots — no feature code imports shell internals.
