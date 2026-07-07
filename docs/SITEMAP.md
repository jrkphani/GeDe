# GeDe — Sitemap & Shell

## v1.0 · 2026-07-05 · companion to SPEC.md v0.2 and STYLE_GUIDE.md v1.0

Decisions locked 2026-07-05: app-only routes (`/` is the app) · top tier tabs + ⌘K command palette · two-row header (app bar + context bar) · persistent status bar.

---

## 1. Route map

```text
/                                   Projects list (root; last-opened project is one Enter away)
/p/:projectId                       → redirects to the last-visited tier (default: foundation)
/p/:projectId/foundation            1st Tier — purpose + value propositions
/p/:projectId/architecture          2nd Tier — architecture tables
/p/:projectId/design                3rd Tier — root canvas + register
/p/:projectId/design/:ctx/:ctx…     Child canvas (one segment per recursion level, context ids)
   ?view=canvas|coverage            Design sub-view (canvas default; coverage matrix)
/welcome                            Hero / landing (v2, issue 033) — product framing; "Sign in" + "Use locally"
/login                              Custom login screen (v2, issue 033) — Cognito email/password (not Hosted UI)
/auth/callback                      OIDC PKCE redirect callback (v2) — completes sign-in, returns to origin
/*                                  Not-found: quiet panel, "Back to projects"
```

- **URL segments use context ids** (stable under rename); breadcrumbs display symbols. Deep links restore tier, canvas depth, view, and selection.
- Browser back/forward mirror breadcrumb navigation exactly (SPEC §4.1); tier switches and `view` changes are history entries too.
- **Auth is an on-ramp, not a gate** (v2, issue 033 / ADR-0009): `/welcome` + `/login` unlock the *shared* server features (sync, workspaces), but the single-user **local-first app is fully usable without an account** — signed-out users can still open `/` and every project route. The hero offers "Use locally" alongside "Sign in". v1 had no public/marketing routes (the GitHub README was the public face).

## 2. Shell anatomy

Three fixed chrome bands; everything between them scrolls per-surface (the page itself never scrolls).

```text
┌──────────────────────────────────────────────────────────────────┐
│ APP BAR · 40px                                                    │
│ GeDe ▸ Tavalo      Foundation · Architecture · Design      ⌘K ↶ ↷ ◐ ⋯ │
├──────────────────────────────────────────────────────────────────┤
│ CONTEXT BAR · 32px (content varies per tier; hidden when empty)   │
│ Root ▸ α ▸ α2   ·   Dimensions ⚙   ·   12/45 documented · 2 drafts │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│                       SURFACE (graph paper)                        │
│                                                                    │
├──────────────────────────────────────────────────────────────────┤
│ STATUS BAR · 28px                                                  │
│ Undid: bind Users → α — Undo        …        2 drafts · v1.4.0     │
└──────────────────────────────────────────────────────────────────┘
```

### App bar (stable everywhere)

- **Wordmark** (→ `/`) · **project name** (in-place rename) · **tier tabs** · right cluster: **⌘K** trigger, **undo/redo**, **theme toggle**, **project menu** (Export…, Import…, project settings), **account** (v2, issue 033 — signed-out: quiet "Sign in" `command` button; signed-in: identity + sign-out popover, composed from `ui/` primitives).
- On `/` (projects list): wordmark + right cluster only; no tabs.

### Context bar (per tier)

- **Design**: breadcrumbs (mono symbols) · dimension-manager trigger · view toggle (canvas/coverage) · coverage stat · draft count. This is where issues 002/011/012 mount their triggers.
- **Architecture**: table quick-jump + "Add table".
- **Foundation**: empty → bar hidden (no dead chrome).

### Status bar (persistent, all screens)

- Left: last-action narration + inline Undo (the app's single feedback channel; `aria-live="polite"` — issue 006).
- Right: ambient counts (drafts, coverage), backup reminder on first visit (issue 015), app version; v2 adds sync state here.
- Never stacks, never toasts, nothing to dismiss.

## 3. Navigation styles

- **Tier tabs**: Inter 13/500; active = ink + 2px accent underline (square, flush with the bar's hairline); inactive = muted ink; hover = ink. Keyboard: ⌘1/⌘2/⌘3.
- **Breadcrumbs**: JetBrains Mono 13; crumbs are links (accent on hover/focus); separator `▸` muted; current crumb = ink, not a link. Overflow: middle crumbs collapse to `…` (menu on click), root and current always visible.
- **Command palette (⌘K)**: centered panel (0 radius, popover shadow), type-ahead over: tier jumps, canvases (by lineage `α ▸ α2`), contexts (by symbol/name/justification), and verbs ("New context", "Export project…"). Mono for symbols/tuples in results. Esc closes, focus returns to origin. **Semantic search (v2, issue 042)**: an on-device embedding model (client-side, $0 AWS, offline) blends a *meaning* score into the lexical ranking — "hide the unconnected" finds the adjacency toggle — while exact/prefix matches still rank first; degrades to pure lexical until the model loads.
- **Links** in surfaces: accent color, underline on hover only.

## 4. Keyboard map (global)

| Keys | Action |
| --- | --- |
| ⌘K | Command palette |
| ⌘1 / ⌘2 / ⌘3 | Foundation / Architecture / Design |
| ⌘Z / ⇧⌘Z | Undo / redo |
| c | New context (Design, compose mode) |
| v | Toggle canvas / coverage view (Design) |
| Esc | Close popover → clear selection → (never exits a tier) |

Surface-local grammars (grid, canvas, matrix) are defined in their issues; they must not shadow the globals.

## 5. Responsive shell

| Container | App bar | Context bar | Status bar |
| --- | --- | --- | --- |
| ≥ 640px | Full | Full | Full |
| 400–640px | Tabs compress (icon-free, shorter labels); project name truncates | Scrollable horizontally within the bar | Narration truncates, counts stay |
| < 400px | Tabs become a segmented 3-way control; right cluster folds into ⋯ menu | Breadcrumbs collapse to `… ▸ current` | Counts only |

Bands are fixed heights at all sizes — chrome never grows; content areas absorb all flexibility (canvas rules in STYLE_GUIDE § Canvas responsiveness).

## 6. Ownership

The shell is built by issue **016** (app bar, tabs, routes, status bar, theme toggle) and **017** (command palette). **v2** adds the auth on-ramp — **033** (hero `/welcome`, `/login`, app-bar account affordance; Cognito, ADR-0009) — and **042** (semantic ⌘K search, on-device embeddings). Feature issues mount into the slots this document defines and reference it — deviations are spec changes, not implementation choices.
