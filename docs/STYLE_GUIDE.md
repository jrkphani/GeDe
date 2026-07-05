# GeDe — Style Guide

## v1.0 · 2026-07-05 · companion to SPEC.md v0.2

Design identity: **a drafting table, not a dashboard.** GeDe renders a design *method*, so the app itself looks like precision drawing equipment: graph-paper ground, geometric hairline surfaces with zero radius, ink typography, one disciplined forest-green accent, and data as the only vivid color. Interaction feel: Zed-class snappiness — the app never animates what it can simply *do*.

Decisions locked 2026-07-05: light-first · Inter + JetBrains Mono · forest-green chrome · comfortable density · teal replaces emerald in the data palette · Lucide sparse · 0-radius geometric · 80–140ms motion.

---

## 1. Principles

1. **Drafting table.** Surfaces are instruments: graph-paper ground, opaque paper panels, hairline borders, square corners. No decorative depth — the only shadow in the app sits under popovers.
2. **In-place, always.** No modals or side-forms for data entry. Cells edit where they are; the composer is a bar, not a dialog.
3. **Color is data.** Chromatic *data* color belongs to dimensions alone. Chrome speaks ink and forest green; the two vocabularies never overlap (which is why the data palette contains no green).
4. **Position is derived.** Nothing on the canvas is draggable-to-mean-something. Selection, not arrangement, is the user's spatial verb.
5. **Instant beats elegant.** Commits, selection, and hover respond immediately. Motion exists only to preserve spatial continuity (drill-down), never to decorate.

---

## 2. Color system

Light is canonical: designed, screenshotted, and verified first. Dark is derived and verified before an issue ships. All tokens are CSS variables under `:root` / `[data-theme="dark"]`.

### 2.1 Ground & surfaces (the graph paper)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--paper` | `#FBFAF7` | `#191918` | Page ground, carries the grid |
| `--grid-minor` | `#ECEAE3` | `#222221` | 1px grid line every **24px** |
| `--grid-major` | `#E0DDD2` | `#2A2A28` | 1px grid line every **96px** (every 4th) |
| `--panel` | `#FFFFFF` | `#1F1F1E` | Opaque content panels: tables, composer, matrix |
| `--hairline` | `#E3E1D8` | `#2E2E2C` | 1px borders on panels, rows, inputs |

- The grid is rendered with CSS gradients on the page ground — never an image. Panels are **opaque**: text never sits directly on grid lines. The grid stays visible in page margins and as the canvas backdrop, where the circle reads like a drawing on graph paper.
- Grid pitch (24px) is deliberately a multiple of the 4px spacing base — panels and rows land *on* the grid.

### 2.2 Ink & chrome (forest green)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--ink` | `#1A1A1A` | `#F2F1ED` | Text, context chips, primary glyphs |
| `--ink-muted` | `#6B6961` | `#8F8D85` | Labels, column heads, canvas labels |
| `--accent` | `#2D6A4F` | `#63A583` | Focus rings, selected states, links, toggles |
| `--accent-strong` | `#23543F` | `#7FB89A` | Primary buttons, active controls |
| `--accent-wash` | `rgba(45,106,79,.10)` | `rgba(99,165,131,.16)` | Selection fills, row highlight |

Forest green is the *entire* chrome vocabulary — there is no second UI hue. Success states reuse `--accent`; the remaining status colors are `--danger #B3402E / #E06C55` and `--warning #9A6B00 / #D0A43C`, used only for genuine error/warning semantics.

### 2.3 Dimension data palette

Assigned in dimension sort order, user-overridable. **No green slots** — green is chrome (principle 3). Values are the light-theme set; dark-theme companions brighten one step. Adjacent-pair distinguishability (including for deuteranopia/protanopia) is validated by an automated contrast test at M2; these are the seeds:

| Slot | Name | Hex |
| --- | --- | --- |
| 1 | Violet | `#6F5BD6` |
| 2 | Teal | `#0E8A93` |
| 3 | Orange | `#D9542B` |
| 4 | Magenta | `#C0448F` |
| 5 | Ochre | `#A87F1A` |
| 6 | Blue | `#3D6BD6` |
| 7 | Rose | `#C75D73` |
| 8 | Slate | `#647E93` |

(The prototype's emerald Stake arc becomes **teal** — the example project reads Violet · Teal · Orange.)

States: documented = filled dot · unexplored = hollow · draft context = dashed ring. Greek context chips are always `--ink` at maximum contrast (square chip, white/black symbol), never a dimension color.

---

## 3. Typography

Self-hosted `woff2` (variable), subset to Latin + Greek; no CDN (offline PWA).

- **UI / content:** **Inter** (variable). — **Data notation:** **JetBrains Mono** for everything the *method* writes: Greek symbols (α, β1), tuple readouts `{Comfort}{Users}{Engagement}`, degree/rank notation (`1°`, `Zero°`, `p₃ₓ`), coverage stats, IDs.

| Role | Font | Size/Line | Weight |
| --- | --- | --- | --- |
| Page title | Inter | 22/28 | 600 |
| Section / tier header | Inter | 17/24 | 600 |
| Table column head | Inter | 11/16, +0.06em tracking, uppercase | 500, `--ink-muted` |
| Body & cells | Inter | 14/20 | 400 |
| Small labels, badges | Inter | 12/16 | 500 |
| Symbol chips, tuples, ranks | JetBrains Mono | 13/20 | 500 |
| Canvas labels | Inter | 13/18 | 400, `--ink-muted` |

Hierarchy comes from weight and spacing, never from additional colors. Minimum text contrast 4.5:1 in both themes (checked in CI at M2).

---

## 4. Space, shape, elevation

- **Spacing scale:** 4px base — `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. Grid pitch 24px; major grid 96px; page gutters 24/32px.
- **Radius: `0` on everything chrome** — panels, buttons, inputs, chips, badges, menus, tooltips. The only circles on screen are *data geometry*: canvas arcs, parameter dots, context nodes. That contrast (rectilinear instrument, circular drawing) **is** the visual signature.
- **Borders over shadows:** 1px `--hairline` defines every edge. The single shadow token, popovers/menus only: `0 2px 8px rgba(0,0,0,.10)` light / `0 2px 8px rgba(0,0,0,.45)` dark.
- **Focus:** `2px solid --accent` outline, `outline-offset: 1px`, square. Shown on `:focus-visible` only.
- **Selection:** `--accent-wash` fill + 2px `--accent` left rule on rows; `--accent` ring on canvas nodes.

## 5. Iconography

**Lucide**, 16px, 1.5px stroke, `--ink` (or `--ink-muted` at rest) — and *sparse*: toolbar verbs, breadcrumb chevrons, status glyphs, close affordances. Never decorative, never beside a label that already says it. Anything expressible as text or notation (ranks, symbols, counts) uses typography, not an icon.

## 6. Tables (Numbers grammar, comfortable density)

- **Row height 40px**; cell padding 12px horizontal; hairline row separators only (no vertical rules except between frozen symbol column and the rest).
- Row hover: `--paper`-tinted wash reveals affordances (drag handle, add-child). Otherwise rows are quiet.
- Click or Enter edits in place — borderless input, identical metrics to display text (zero layout shift). Enter commits + moves down; Tab moves right; Esc reverts. New row = start typing in the phantom row.
- Nested rows indent by 24px per level (one grid cell); no tree lines.
- Validation is inline and non-blocking: duplicate-tuple warnings are a muted mono badge (`= β`), never a popup.

## 7. Canvas

- Arcs: 6px stroke, butt caps meeting the square aesthetic, gaps between dimensions; parameter dots on the arc; labels outside (`--ink-muted`). The graph-paper grid shows behind the circle — the drawing sits on the paper.
- Selected context: n spokes in dimension colors + composer bar populated; unselected contexts dim to 40%.
- Composer bar: a full-width panel (0 radius, hairline top border) — mono tuple readout, justification in place.

### Canvas responsiveness

Geometry is scale-free (1000×1000 abstract space → SVG `viewBox`). Container-query driven (the canvas shares a row with the register):

| Container width | Labels | Chrome |
| --- | --- | --- |
| ≥ 640px | Full external labels | Register beside canvas; composer below canvas |
| 400–640px | Truncated + tooltip on hover/focus | Register stacks below canvas |
| < 400px | Legend chips, tap-to-reveal | Canvas capped at `min(100%, 60vh)`; read-mostly |

- The circle always renders 1:1; the square viewport is `min(container width, available height)`, centered on the grid.
- Touch targets: every dot/node carries an invisible ≥ 44px hit circle regardless of visual radius.
- Label degradation is deterministic: shrink one step → truncate → legend. No jiggle.
- n > 8 dimensions: arcs compress, labels legend-only (functional; outside the optimized range per ADR-0002).

## 8. Motion

- **Snappy: 80–140ms**, ease-out, CSS transitions only. Hover/commit/selection feedback ≤ 100ms — effectively instant. Nothing animates on data commit.
- The one spatial exception: **drill-down zoom ~200ms** (canvas scales into the opened node) to preserve continuity across recursion levels.
- One thing moves at a time. `prefers-reduced-motion` replaces all transitions with instant state changes, including drill-down.

## 9. Voice

UI copy is quiet, specific, and numerate: "12 / 45 tuples documented", "α2 needs 1 more binding", "Removing Process deletes 7 bindings". No exclamation marks, no anthropomorphism, no praise. Errors say what happened and the one action that fixes it.

## 10. Accessibility baseline

- Text ≥ 4.5:1; UI glyphs ≥ 3:1; dimension colors never the sole channel (dots pair with position + label; states pair fill with ring style).
- Full keyboard operability is a per-issue acceptance criterion, not a polish pass (see issues 004/009/010).
- Focus order follows the visual grammar: breadcrumb → toolbar → primary surface (register/canvas) → composer.
- Touch targets ≥ 44px everywhere, including canvas hit circles.
