# GeDe Design System — Digest

Sources (read-only):
- `/Users/jrkphani/Projects/GeDe/handover/specs/GeDe Design System.dc.html` — single artboard "GeDe · Design System Foundation · v1.0 · React · WCAG 2.1 AA · 1Cloudhub". Page text is templated (`{{ x }}`); all real values live in a `class Component extends DCLogic { renderVals() {...} }` script (React.createElement, no JSX). Sections: 01 Visual identity · 02 Colour · 03 Typography · 04 Space/radius/elevation · 05 Iconography · 06 Components · 07 Responsive · 08 Motion · 09 Accessibility · 10 Developer handoff · 11 Voice and notifications.
- `handover/tokens/tokens.css`, `handover/tokens/theme.ts`, `handover/reference/shortcuts.md`
- `handover/prototype/Work Scape Canvas.dc.html` (inventory only)

Other spec files present but NOT digested here: `GeDe Architecture C4.dc.html`, `GeDe Error Pages.dc.html`, `GeDe Sign-in Options.dc.html`, `Text-Oriented Spreadsheet PRD.dc.html`.

---

## 1. Tokens

### tokens.css (verbatim values)

Header comment: "GeDe design tokens — single source of truth. A literal hex, radius or duration in a component file fails review."

**Primitives**
```
--forest-50:  #f0f7f3;   --forest-100: #d8e9df;   --forest-300: #7fb195;
--forest-500: #2a7b4e;   --forest-700: #14532d;   /* brand */   --forest-900: #0a2d18;
--amber-50:   #fdf6ec;   --amber-100:  #f8e6c8;   --amber-300:  #e0a04a;
--amber-500:  #d97706;   --amber-700:  #b45309;   /* live state */   --amber-900: #7c3a05;
--slate-0:    #ffffff;   --slate-50:   #f7f9f8;   --slate-200:  #e3e8e5;
--slate-400:  #b8c4be;   --slate-600:  #5b6b63;   --slate-900:  #14201a;
--success: #166534;  --warning: #b45309;  --danger: #b42318;  --info: #155e75;
```
**Semantic**
```
--action-primary-bg: var(--forest-700);   --action-primary-fg: var(--slate-0);
--link:              var(--forest-700);   --selection-ring:    var(--amber-700);
--focus-ring:        var(--amber-700);    --reference-1:       var(--amber-700);
--surface:           var(--slate-0);      --surface-sunken:    var(--slate-50);
--border:            var(--slate-200);    --ink:               var(--slate-900);
--ink-muted:         var(--slate-600);
--border-strong:     #6f7f77;   /* added 2026-09-13 (#81): control boundaries, 4.22:1 on --surface, 3.99:1 on --surface-sunken */
```
**Presence** ("assigned on join; never the brand colour")
```
--presence-1: #14201a; --presence-2: #155e75; --presence-3: #6d28d9;
--presence-4: #b45309; --presence-5: #0f766e; --presence-6: #9d174d;
```
**Type**
```
--font-ui:   'Helvetica Neue', Helvetica, Arial, 'Noto Sans Tamil', 'Noto Sans Devanagari', 'Noto Sans Telugu', sans-serif;
--font-mono: 'IBM Plex Mono', monospace;
```
**Space (4px base)**
```
--space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
--space-5: 1.5rem;  --space-6: 2rem;   --space-7: 3rem;    --space-8: 4rem;
```
**Radius** `--radius-none: 0; --radius-sm: 3px; --radius-md: 6px; --radius-lg: 10px; --radius-pill: 999px;`

**Elevation**
```
--elev-raised:  0 1px 2px rgba(20,32,26,0.08);
--elev-overlay: 0 8px 24px -10px rgba(20,32,26,0.35);
--elev-modal:   0 24px 60px -20px rgba(20,32,26,0.45);
```
**Motion**
```
--dur-fast: 120ms; --dur-base: 180ms; --dur-emphasis: 240ms; --dur-enter: 300ms;
--ease-out:      cubic-bezier(0,0,0.2,1);
--ease-standard: cubic-bezier(0.2,0,0,1);
--ease-emphasis: cubic-bezier(0.2,0.8,0.2,1);
```
**Loading**
```
--skeleton-base: #eef2f0; --skeleton-sheen: #f6f9f7; --skeleton-speed: 1400ms;
--loading-delay: 200ms;   --loading-min-hold: 400ms;
```
**Canvas lattice** ("absolute, NOT on the space scale") `--lattice-col: 160px; --lattice-row: 22px;`

**Breakpoints (for JS reference)** `--bp-sm: 480px; --bp-md: 768px; --bp-lg: 1024px; --bp-xl: 1440px;`

**Dark theme** `[data-theme="dark"]`:
```
--surface: #0f1a15; --surface-sunken: #0a120e; --border: #24352c;
--border-strong: #5f7268;   /* added 2026-09-13 (#81): 3.47:1 on --surface, 3.70:1 on --surface-sunken */
--ink: #e6ede9; --ink-muted: #9fb0a7;
--action-primary-bg: #2a7b4e;  /* lifted for contrast on dark (per DS page) */
--selection-ring: #e0a04a;
--skeleton-base: #16231c; --skeleton-sheen: #1d2e25;
```
**Reduced motion** `@media (prefers-reduced-motion: reduce) { * { transition-duration: 0ms !important; animation: none !important; } }`

Note: the DS page also lists `--presence-2 #155e75 "Second collaborator"` in its semantic table, and the enter easing `cubic-bezier(0,0,0.15,1)` appears only in theme.ts/motion table, not as a CSS `--ease-enter` token (gap).

### theme.ts shape
"Generated from tokens.css — keep in sync." `export const theme = {...} as const; export type Theme = typeof theme;`
```
color: {
  brand:    { subtle: '#f0f7f3', base: '#14532d', strong: '#0a2d18' },
  live:     { subtle: '#fdf6ec', base: '#b45309', strong: '#7c3a05' },
  surface:  { base: '#ffffff', sunken: '#f7f9f8', border: '#e3e8e5' },
  ink:      { base: '#14201a', muted: '#5b6b63', onBrand: '#ffffff' },
  status:   { success: '#166534', warning: '#b45309', danger: '#b42318', info: '#155e75' },
  presence: ['#14201a','#155e75','#6d28d9','#b45309','#0f766e','#9d174d'] }
space: [0, 4, 8, 12, 16, 24, 32, 48, 64]
radius: { none: 0, sm: 3, md: 6, lg: 10, pill: 999 }
font: { ui: <stack above>, mono: "'IBM Plex Mono', monospace" }
text: { display, h1, h2, h3, body, bodySm, cell, monoCell, label }  // each { size(rem string), weight, lh, ls }
motion: { fast:{120,'cubic-bezier(0,0,0.2,1)'}, base:{180,'cubic-bezier(0.2,0,0,1)'},
          emphasis:{240,'cubic-bezier(0.2,0.8,0.2,1)'}, enter:{300,'cubic-bezier(0,0,0.15,1)'} }
loading: { delay: 200, minHold: 400, shimmer: 1400 }
breakpoint: { xs: 0, sm: 480, md: 768, lg: 1024, xl: 1440 }
lattice: { col: 160, row: 22 }
```
theme.ts has no dark palette and no elevation/presence-name tokens.

Naming rule (handoff section): `category-role-variant-state`, kebab in CSS, camel in TS. Primitives (`forest-700`) are private; components use semantic aliases (`action-primary-bg`). Figma styles carry the same names.

---

## 2. Typography, space, radius, motion, colour semantics, focus, contrast

### Typography
"One grotesque, one mono." Helvetica Neue for interface and content; IBM Plex Mono for anything addressable — cell references, formulas, tokens, counts, labels ("if it is monospace, you can type it into a formula"). Indic scripts fall back to Noto (Tamil, Devanagari, Telugu). Indic line-height 1.7 minimum; matras clip at 1.4.

Type scale (size / line-height / weight / tracking):
| token | spec | px |
|---|---|---|
| display | 2.5rem / 1.05 / 600 / −0.04em | 40 |
| h1 | 1.75rem / 1.15 / 600 / −0.03em | 28 |
| h2 | 1.25rem / 1.25 / 600 / −0.02em | 20 |
| h3 | 1rem / 1.35 / 600 / −0.01em | 16 |
| body | 0.9375rem / 1.6 / 400 | 15 |
| body-sm | 0.8125rem / 1.55 / 400 | 13 |
| cell | 0.71875rem / 1.35 / 400 | 11.5 |
| mono-cell | 0.625rem / 1.3 / 400 / 0.01em · IBM Plex Mono | 10 |
| label | 0.5625rem / 1.2 / 500 / 0.08em · uppercase · IBM Plex Mono | 9 |

Rules: sizes in rem, root stays 16px so user zoom works. Body copy never below 0.8125rem (13px); grid cells never below 0.6875rem (11px). Three weights only: 400, 500, 600 — no 700, no italic in UI chrome. Measure caps at 70ch for prose; grid cells clip with ellipsis + `title`. Negative tracking scales with size: −0.04em at display, 0 below 14px. Button font-size in specimens 13.5px (0.84375rem); sm 12px/6px 11px padding, md 10px 16px, lg 15px/12px 20px.

### Space / radius / elevation
4px base: space-1..8 = 4, 8, 12, 16, 24, 32, 48, 64 px. Document canvas is separate and absolute: 160 × 22 px lattice giving every cell its A1 address — "Never mix the two — canvas objects snap to the lattice, chrome pads on the scale." Radius: none 0, sm 3, md 6, lg 10, pill 999. Elevation: flat none; raised; overlay; modal (values above).

### Colour semantics
Two hues, one job each. **Forest #14532d** = brand: identity, primary actions, links, active navigation. **Amber #b45309** = live state: selected cell, formula references, collaborator presence, unsaved/in-progress. Grey = everything else. "No third meaning."

Ramps with contrast on white: Forest 50 #f0f7f3, 100 #d8e9df, 300 #7fb195, 500 #2a7b4e (4.6:1), 700 #14532d (10.6:1), 900 #0a2d18 (15.9:1). Amber 50 #fdf6ec, 100 #f8e6c8, 300 #e0a04a, 500 #d97706 (3.1:1, large-text/decoration only), 700 #b45309 (4.8:1), 900 #7c3a05 (8.2:1). Slate 0 #ffffff, 50 #f7f9f8, 200 #e3e8e5, 400 #b8c4be, 600 #5b6b63 (6.1:1), 900 #14201a (16.8:1). Status: success #166534 (7.4:1), warning #b45309 (4.8:1), danger #b42318 (5.9:1), info #155e75 (7.0:1).

Rules: Forest 700 on white 10.6:1 safe for body text. Amber 700 4.8:1 safe for text; amber 500 decoration only. Never hue alone for meaning — pair with icon, label or weight. Surface tints step by one ramp value; no arbitrary alpha overlays. Dark theme is a token swap, never a filter or `invert()`. `theme-color` meta: `#ffffff` light, `#0f1a15` dark.

### Focus ring
`:focus-visible { outline: 2px solid #b45309; outline-offset: 2px; border-radius: 3px; }` — "2 px amber outline at 2 px offset on every focusable element, never removed." Focus is amber, not forest, because focus is live state. Inputs on focus: border amber + `box-shadow 0 0 0 3px rgba(180,83,9,0.18)`; primary button focus specimen adds `0 0 0 3px rgba(180,83,9,0.35)` glow plus the outline.

**Recorded 2026-09-13 (#143).** The ring is drawn at −2 px (inset) on exactly the controls that tile edge to edge inside a clipping container, where an outward ring would fall under a neighbour or be cut by the container: grid cells and the cell editor (one lattice unit each, GRID-03's selection ring is inset by the same rule), sheet tabs, menu items and select options. Everything else — buttons, links, fields, library rows (`library.css`, formerly inset), the column-header ▼ — takes the global +2 px ring. A new inset ring needs a clipping reason stated in the stylesheet.

### Contrast requirements
Body text ≥ 4.5:1; large text and UI boundaries ≥ 3:1; borders, focus rings, selection rings and graph strokes ≥ 3:1 against background. Token table records every ratio; CI fails on a new pair below threshold; contrast recorded in each PR.

**Recorded 2026-09-13 (#132).** The six presence colours are UI boundaries (the collaborator outline, SHARE-04) and had no dark values; `--presence-1` (`#14201a`) measured 1.06:1 on the dark surface. The dark block now swaps them — `#b8c4be`, `#6fc7e0`, `#b794f4`, `#e0a04a`, `#4fc1b0`, `#ee7fa7` — at 9.91 / 9.26 / 7.26 / 7.89 / 8.13 / 6.98:1 on `--surface` (`#0f1a15`) and 10.56 / 9.88 / 7.74 / 8.41 / 8.67 / 7.44:1 on `--surface-sunken`; light stays 16.78 / 7.27 / 7.10 / 5.02 / 5.47 / 7.88:1 on white. Text on a presence fill (the name tag, avatar initials, operand badges) is `--presence-ink` — white in light, the surface colour in dark — at the same ratios, all ≥ 4.5:1. The formula operand outlines `--reference-2..6` reference the presence tokens, so the dark swap carries them. `packages/tokens/src/tokens.test.ts` pins every ratio and the light/dark parity.

**Recorded 2026-09-13 (#81).** `--border` (slate-200 `#e3e8e5`) is 1.24:1 on `--surface` and 1.17:1 on `--surface-sunken` in light, `#24352c` 1.37:1 / 1.47:1 in dark: a decorative hairline (section separators, rulers, menu separators), exempt under WCAG 1.4.11, never a control's only boundary. The boundary of a text field, a select trigger and list, and a menu is `--border-strong` — light `#6f7f77` (4.22:1 / 3.99:1), dark `#5f7268` (3.47:1 / 3.70:1); hover and open states darken it to `--ink-muted` (5.63:1 light, 7.84:1 dark). The `#d3dcd7` (1.40:1) and `#b8c4be` (1.80:1) field borders in the table below are the handover's values and do not meet the floor; the shipped components use the token. `packages/tokens/src/tokens.test.ts` computes and pins these ratios.

---

## 3. Iconography

**Custom in-house set — not a third-party library.** "One family, one construction." Line-drawn on an 18 × 18 grid (viewBox `0 0 18 18`), 1px keyline inset, 16px live area, 1.3px stroke, round caps and joins, no fills except nodes, corner radius 1.6px on small frames, 8-unit construction grid, optical alignment over mathematical. Sizes: 13px inside dense chrome/menus, 15px default, 18px primary toolbars (22 shown too); stroke stays 1.3px at every size. Hit area ≥ 32px, ≥ 44px below `lg`. Colour: `stroke="currentColor"`, never hard-coded — ink 900 (#14201a) at rest, forest when the controlled state is active, amber when live, disabled = slate 400 #b8c4be (not opacity).

Implementation: one React component, one sprite — `<Icon name="filter" size={15} />`; icon-only buttons need `aria-label` AND `title`/tooltip.

The set (30 glyphs, SVG paths defined inline in the spec):
- Structure: Table, Add row, Add column, Graph, Sheet, Shaped table
- Data: Sort, Filter, Group, Formula, Reference, Derive
- View: Gridlines, Zoom in, Fit, Pin, Collapse rail, Edges
- Document: Share, People, Link, Download, Delete, Recover
- State: Complete, Draft (dashed circle), Warning, Error, Locked, Loading (dashed arc)

Do: pair icons with labels when room; reuse before drawing; one meaning per glyph. Don't: mix filled/outline; use emoji, icon fonts, or third-party sets; let an icon carry state alone; draw pictorial/illustrative/mascot/skeuomorphic art.

Brand mark: single lattice cell (36×36 frame rx 4, stroke 2.5, gridlines `M2 13h36M13 2v36` at 1.4/opacity .55, node circle r5 at (26,26)) on viewBox 0 0 40 40; below 32px gridlines drop, below 20px only node + frame (16px favicon: no lines, stroke 3, node r7 at 25, rx 3). Min mark 20px. Lockup gap 12px, wordmark 600 weight, tracking −0.035em. Never recolour node amber (except the document icon, whose amber node marks a document). Asset files: favicon.svg (currentColor + media query, both themes inline), favicon.ico (16/32/48), icon-192.png, icon-512.png, icon-maskable-512.png (40% safe zone), apple-touch-icon.png (180, opaque, 20% padding), safari-pinned-tab.svg (mask colour forest 700), og-card.png (1200×630), logo-lockup.svg, logo-reversed.svg, doc-icon.svg. Avatar fallback: initials on forest 900 / #14201a, never generated faces.

---

## 4. Component inventory

**Headless primitive choice:** "Behaviour — focus traps, roving tabindex, portal positioning, ARIA wiring, dismiss semantics — comes from a headless library (Radix UI, or Ark/Base UI). GeDe supplies only tokens and skin. A hand-rolled dropdown is a defect." Concrete code and the a11y table name **Radix** specifically (`@radix-ui/react-dropdown-menu`, "Use Radix DropdownMenu / ContextMenu — do not hand-roll", "Radix primitives supply this"). Ark/Base UI are listed only as alternates. Definition of done: "Built on the headless primitive, not on a div with handlers." All five states (default, hover, focus-visible, active, disabled) specified and keyboard-reachable.

| Component | Level | Variants / states / behaviour | Primitive |
|---|---|---|---|
| Button | atom | primary (forest bg, white, once per view), secondary (white, ink, border #d3dcd7), ghost (transparent, forest text), danger (#b42318, irreversible only). States: hover (#0f3f22), focus (amber outline + glow), active (#0a2d18, translateY 1px), disabled (opacity .45, not-allowed). Sizes sm/md/lg. Loading: keeps width, label → present participle ("Inviting…"), `disabled` + `aria-busy="true"`, spinner `role="status"`. Radius 6 (44px/8px on sign-in stack). | native button / styled |
| Text field, select | atom | default (border #d3dcd7, 9px 11px, radius 6), focus (amber border + 3px 18% amber ring), error (#b42318 border, message beneath naming the problem), disabled (#f2f5f3 bg, #8b9c93 text). Label above (12.5px #5b6b63), hint below (11.5px #8b9c93). Placeholder never carries the label. Select options: Automatic/Text/Number/Currency/Date. | native + Radix Select as needed |
| Checkbox / Radio / Switch | atom | 17px box, radius 4 (radio 17 round), 1.5px border #b8c4be → forest when on; switch 40×22, thumb 16, forest when on, `left 140ms cubic-bezier(0.2,0.8,0.2,1)`. | Radix Checkbox/RadioGroup/Switch |
| Tabs | molecule | Switch a pane. Underline 2px forest, active 600 weight ink, inactive #5b6b63. Example tabs: Table, Cell, Text, Arrange, Graph. | Radix Tabs |
| Segmented control | molecule | Switch a view. Track #eef2f0 radius 7, active pill white with raised shadow. (Ring / Coverage) **Recorded 2026-09-13 (#144):** exactly one segment is always on, so it follows the ARIA radio pattern — Tab lands on the checked segment, arrows move the selection, Space checks. | Radix RadioGroup (was ToggleGroup, which moved only focus on arrows) |
| Chips | molecule | Filter. Border forest + #f0f7f3 fill when on, 7px square swatch. Never nest same kind inside same kind. | ToggleGroup |
| Menu / Dropdown / Context menu | molecule | Width ~252, radius 8, overlay shadow, 5px vertical padding; checkmark left, shortcut right (mono 10.5px), separators by kind; disabled shown never hidden. Anchor to trigger, flip before leaving viewport; Escape closes, focus returns to trigger; arrows move, typeahead; max-height 82vh then inner scroll. | **Radix DropdownMenu / ContextMenu** |
| Grid (cells, headers, density) | organism | Row = one lattice unit 22px (compact, text 11.5px, ellipsis + title) or 44px wrapped (two rows so A1 stays exact). Header 22px #f7f9f8, 1.5px ink bottom rule, column letters mono 8.5px. Title bar 44px with mono degree code (e.g. "3°"). Selection = amber inset 2px ring; references amber outlines keyed by operand; other collaborators teal/violet/orange assigned on join. Numeric/currency right-align; text/dates left. Below 1024px no reflow — viewport pans. Cells expose row/col headers to AT. | custom (no Radix) |
| Inspector rail | organism | 322px rail, collapsible to 38px strip; sections 13/14px padded blocks separated by hairlines, each opened by a mono uppercase 9px label (e.g. "selected node", "data format"). | Collapsible |
| Dialog / Sheet / Popover | organism | Modal (width 300, radius 10, modal shadow) for blocking decisions; popover (radius 8, overlay shadow) for in-place adjustments; sheet for share/settings. All trap focus, close on Escape, return focus to trigger. Enter motion 300ms. | Radix Dialog / Popover |
| Toast | organism | Reversible & transient. Dark #14201a, white text, "Undo" in amber-100 #f8e6c8, radius 8. | Radix Toast |
| Banner | organism | Persistent & consequential. Amber-50 bg, amber-100 border, ⚠ amber, text #5d4213, bold cause + remedy. | — |
| Empty state | organism | Dashed #d3dcd7 border, radius 10, #fafcfb bg, mono uppercase label, prose, primary + secondary action that fills it. | — |
| Avatar / badge / presence | atom | 30px initials (24px stacked with −7px overlap, 2px white ring); presence dot 8px + "X is editing D12"; badges pill: Shared (forest-50/forest-700), Draft (amber-50/amber-700). Six presence colours, never brand green. | — |
| Canvas objects (table, graph, ruler) | organism | Live on the lattice; hairline chrome, no shadow at rest, amber 1px ring only when selected; column letters mono 10px on #f2f5f3, row numbers mono 9.5px, 26px gutter. Graph card 190px wide, 34px header, "ring"/"coverage" view badge. | custom |
| Loading / skeleton / progress | organism | Tier 1 inline (<200ms show nothing); Tier 2 skeleton (200ms–1s) shaped like content, keeps 22px lattice rows, varied bar widths, `aria-hidden` bars, `aria-busy` container; Tier 3 (>1s) skeleton + status line (`role="status" aria-live="polite"`), 4px progress bar forest. Shimmer 1.4s ease-in-out, spinner 620ms linear, pulse 1.2s. Delay 200ms, min hold 400ms. Never full-page spinner; edits optimistic; indeterminate spinner for unknown durations. | — |
| Sign in with Apple | molecule | Apple-specified: black / white / white-outline only, Apple SVG glyph (never  char), min 44pt height, radius 0–½ height, SF Pro ~43% of height medium, wording "Sign in with Apple" / "Continue with Apple", equal-or-greater prominence than other third-party sign-ins. GeDe uses black; own primary buttons take 44px/8px radius on that screen; passkey button sits above. | — |
| Find bar | organism | Floating at foot of canvas (iCloud Numbers style): gear (fuzzy, replace, search-formulas, include-documents), input, "2 of 6" mono, ‹ › , Done. Matches tint amber in place; operators `col:` and `is:`; fuzzy on by default. | — |
| Shortcut sheet | organism | Opened with `?`; grouped keycaps (mono 11px, #f2f5f3, 2px bottom border). | Dialog |
| Coachmark card (tour) | organism | **Added 2026-09-12** (First Run spec direction 1a; ONB-09). Fixed-position card, 286 px wide, radius lg (10–11 px), modal shadow, white on slate-0, anchored 14 px below its target and flipping above when the space below is under ~226 px; horizontally clamped 12 px from either viewport edge; centred in the viewport when the step has no target (step 2). Anatomy top to bottom: step counter (mono 9.5 px, amber-700, `STEP n OF 5`) with progress dots on the same line; title 14 px/600 ink; body 12.5 px slate-600; optional comparison note 11.5 px with a 2 px left rule; footer row with the pending action in amber-700 and a text-only Skip. No Next control. Not shown below 768 px. Strings in the message catalogue. Contrast: amber-700 on white 4.8:1. | Radix Popover (non-modal, no focus trap — the target must stay operable) |
| Spotlight scrim (tour) | organism | **Added 2026-09-12** (ONB-04, ONB-11). A single fixed element positioned 5 px outside the target's live bounding box, radius lg, 2 px amber-700 border, with a 9999 px spread shadow in slate at ~46 % alpha that dims everything else; `pointer-events: none` so the spotlit element and the rest of the page stay operable. When a step has no target the same element becomes a full-viewport dim at ~34 % alpha. Re-measured on scroll, resize, zoom and layout change (ResizeObserver / rAF — the prototype polls every 350 ms, which is not the target). z-index above canvas and chrome, below the card. | custom |
| Progress dots (tour) | atom | **Added 2026-09-12** (ONB-09). Five 5 px round dots, gap 4 px; completed and current steps forest-700, remaining slate-200. Purely decorative — the step counter text carries the same information for AT (`aria-hidden` on the dots). | — |
| Help control (library) | atom | **Added 2026-09-12** (ONB-08). A `?` icon button in the library header, 30 × 30, ghost, tooltip "Guided tour"; replays the tour (clears the flag, restarts at step 1). Distinct from the document shortcut sheet, which `?` still opens inside a document. | native button |
| Sample badge (library row) | atom | **Added 2026-09-12** (ONB-01). The sample workscape shows `Sample` in the shared column where other rows show "By Me" / "By <name>". Same pill style as the existing Shared badge (forest-50 / forest-700). | — |

Toast additions 2026-09-12 (LIB-D9, ONB-14): library toasts keep the existing dark Toast (slate-900, white text, Undo button outlined white at 35 % alpha, radius 8–9 px, bottom-centred 22 px up, ~7 s auto-dismiss). Recorded 2026-09-13 (#143): the shipped viewport is bottom-centred one lattice row (22 px) up and the provider default is 7 000 ms (`TOAST_DURATION_MS`); the earlier bottom-left, 6 s viewport was the deviation. The tour-completion toast is a forest-700 variant with a Replay action (~8 s). Neither introduces a token; both remain Radix Toast.

Menu item labels shown: Freeze header columns, Sort ascending/descending, Group rows by this column, Add column before/after, Delete column, Magic fill (disabled), Copy ⌘C.

---

## 5. Responsive

"Five breakpoints, one layout law. Chrome adapts; the document does not reflow."

| Token | Range | Chrome | Capability |
|---|---|---|---|
| xs | < 480px | Single column; sheet switcher as bottom bar; canvas full-bleed | Read-only: pan, zoom, select, follow references |
| sm | 480–767px | As xs with two-line chrome bar; share and account remain | Read-only; 44px minimum hit targets |
| md | 768–1023px | Toolbar returns and wraps; inspector opens as overlay sheet | Full editing; context menus on long-press |
| lg | 1024–1439px | Inspector docks at 322px, collapsible; chrome clusters icon-only | Full editing, keyboard traversal |
| xl | ≥ 1440px | Inspector docked, toolbar on one row, canvas takes remainder | Full editing; multiple graphs side by side |

Recorded 2026-09-13 (#137, ADR-039): "read-only below 768 px" is applied as *narrow and coarse-pointered*. A fine-pointer window under 768 CSS px — a 1440 px display at 200 % browser zoom — gets the `md` chrome and stays editable, so the 200 % rule below holds for functionality too. Below `md` the title row is two lines for every device (#124).

Do: query the container, not the window, inside the canvas; collapse inspector to a 38px strip before shrinking contents; let toolbars wrap to a second row rather than clip/scroll; raise hit targets to 44px below `md`. Don't: reflow a table's columns at a breakpoint (addresses would change); hide a command with no other home; **ship an edit affordance below `md` — phone is read-only by contract**; scale type with `vw`.

**200% zoom rule:** all type in rem; layout holds at 200% browser zoom with no loss of content (WCAG 1.4.4); verified at each breakpoint. Definition of done: renders at 480, 768, 1024, 1440 and at 200% zoom.

---

## 6. Motion, accessibility, voice, email

### Motion
"Motion explains where something came from. Nothing moves for decoration, nothing animates longer than 300 ms, and every transition is cancellable."
| name | spec | use |
|---|---|---|
| instant | 0ms linear | Selection, hover tint, checkbox |
| fast | 120ms ease-out `cubic-bezier(0,0,0.2,1)` | Buttons, switches, chips, tooltip appearance |
| base | 180ms standard `cubic-bezier(0.2,0,0,1)` | Menus, popovers, inspector sections |
| emphasis | 240ms spring-ish `cubic-bezier(0.2,0.8,0.2,1)` | Rail collapse, table move/resize, graph reposition |
| enter | 300ms decelerate `cubic-bezier(0,0,0.15,1)` | Modal and sheet entry — longest in system |

Reduced motion: transitions → 0ms, animations removed, but state change must remain visible — replace slide with instant position change, never a fade that hides the change; skeletons go to a flat tint.

### Accessibility (WCAG 2.1 AA — "criteria, not aspirations")
1.4.3 Contrast (as §2); 1.4.11 Non-text contrast ≥ 3:1; 1.4.1 Use of colour — draft nodes dashed as well as hollow, errors carry icon + text, references show an index not only a hue (greyscale screenshot review); 2.1.1 Keyboard — Tab/arrows traverse cells, Enter edits, Escape cancels, ⌘-keys by physical key; 2.4.7 Focus visible — 2px amber/2px offset never removed (axe + keyboard walk); 2.4.3 Focus order — menus/dialogs trap and restore focus (Radix); 1.4.4 Resize text — rem, 200%; 1.4.12 Text spacing — no fixed heights on chrome text containers, grid rows exempt (lattice) and clip with title; 2.3.3 Animation — prefers-reduced-motion; 4.1.3 Status messages — polite live region, skeletons aria-hidden with aria-busy on container; 4.1.2 Name/role/value — cells expose row+column headers, graph nodes are buttons with `aria-pressed`, live regions announce selection and sync (VoiceOver + NVDA).

Merge checklist (every PR): keyboard-only pass; focus visible on every new control; contrast recorded for new pairs; works at 200% zoom; dark theme checked; reduced-motion checked; screen-reader labels on icon-only buttons; no new literal hex/px radius/ms duration; built on the headless primitive; renders at 480 and 1440.

### Voice
Plain, specific, unhurried. No exclamation marks, no "Oops", no emoji. Name the object ("Delete Work-Force?" not "Delete this item?"). Buttons are verbs — Share, Invite, Delete — never OK/Yes/Submit. Errors state cause and remedy ("Sum skipped D14 — it holds text."). Sentence case everywhere; Title Case only in the wordmark.

### Email rules and templates
Subject ≤ 60 chars, front-loaded with actor or object. One primary action per message with a plain-text link beneath. Sender `GeDe <no-reply@gede.1cloudhub.com>`; reply-to the actor where one exists. Never include document content. Codes expire in 10 minutes and say so; invitations in 14 days.

| key | trigger | subject | CTA / note |
|---|---|---|---|
| auth.welcome | Account created | "Your GeDe account is ready" | Open GeDe; plain link gede.1cloudhub.com; explains no password — passkey or one-time code |
| auth.otp | One-time sign-in code | "123456 is your GeDe sign-in code" | No button, code only; code repeated in preheader; expires 10 min, single use |
| auth.passkey | Passkey added | "A passkey was added to your GeDe account" | Review your passkeys; lists device/browser/time/location; security mail never links directly to a destructive action |
| share.member | Shared with existing user | "Meenarapan shared “1Cloudhub - Workscape” with you" | Open workscape; reply-to sharer; no document content |
| share.invite | Invitation to non-user | "Meenarapan invited you to a GeDe workscape" | Accept invitation; one-time token in link; expires 14 days; mentions passkey setup |
| collab.mention | Mentioned in a comment | "Sembian mentioned you in “Generic Design Architect”" | Go to the cell; comment text not included |

### Email — as shipped (`packages/mail`, ADR-044)

Every mail GeDe sends is rendered by `@gede/mail`, one layout from the tokens, in the recipient's locale. The handover table above is the brief; this is what exists.

**Layout.** A 600 px column on `--surface-sunken`, one card on `--surface` with a 1 px `--border` and `--radius-lg`; the brand lockup (the mark as the hosted `icon-192.png` at 36 px beside the wordmark — the one place Title Case lives); an `h1` at 22 px/600; body copy at 16 px, line-height 1.6, in the UI font stack (`--font-ui`; no web fonts — Noto is not asked for in mail); then **either** the one-time code — 32 px `--font-mono`, letter-spaced, in the live amber (`--selection-ring`, the only amber in the message) on `--tint-amber-soft` with a `--radius-md` box — **or** the one primary action (`--action-primary-bg` / `--action-primary-fg`, `--radius-md`, a verb) with the plain link written out beneath it in `--link`; a hairline rule; a footer at 14 px `--ink-muted` that says why the mail arrived, which address it went to, and "GeDe, the text-oriented spreadsheet." Table markup, inline styles, at most one `<a>`, no images beyond the mark. Every colour is read from `tokens.css` at generation time into `src/generated/palette.ts` (light from `:root`, dark from the `[data-theme="dark"]` swap); the file is pinned by test and excluded from `check-literals`, which scans the rest of the package.

**Dark.** `<meta name="color-scheme" content="light dark">` and `supported-color-schemes`, plus a `<style>` block that swaps the same tokens under `prefers-color-scheme: dark` (the amber becomes the dark selection ring, amber-300). Contrast, both schemes, pinned in `palette.test.ts`: ink on surface 16.8:1 / 15.0:1, muted ink 5.6:1 / 7.8:1, link 9.1:1 / 7.3:1, button label 9.1:1 / 5.2:1, code on its box 4.7:1 / 8.4:1 (light / dark).

**Kinds** (subjects in en-US; fixed subjects ≤ 60 characters in every locale, share subjects trimmed on the title):

| kind | sent by | subject | body |
|---|---|---|---|
| `signUpCode` | Cognito, `CustomMessage_SignUp` / `_ResendCode` | Your GeDe sign-up code | Confirm your email address; the code; works once, expires in 24 hours |
| `signInCode` | Cognito, `CustomMessage_Authentication` (EMAIL_OTP first factor) | Your GeDe sign-in code | Sign in to GeDe; the code; works once, expires in 10 minutes (the client's `authSessionValidity`) |
| `emailChangeCode` | Cognito, `CustomMessage_UpdateUserAttribute` / `_VerifyUserAttribute` | Confirm your new GeDe email address | The code; the previous address keeps working until confirmed (`keepOriginal`) |
| `share.member` | services/sync, SES | {actor} shared “{title}” with you | Open workscape; reply-to the sharer |
| `share.invite` | services/sync, SES | {actor} invited you to a GeDe workscape | Accept invitation; valid 14 days; passkey or code, no password |

Not sent, because the PRD sends none: a welcome mail, a passkey-added notice, a mention. The code is never in a subject or the preheader (Cognito's `{####}` appears exactly once, by test).

**Locales.** en-US, en-GB, en-IN, ta-IN, hi-IN, te-IN — the catalogue mechanism of `apps/web/src/i18n` (same keys everywhere, `{placeholders}` preserved, product names untranslated). Cognito mail follows the user's `locale` attribute, which the web app writes at sign-up and on every change; share mail follows the member's `users.locale`, else the inviter's. An unknown tag renders en-US. `docs/mail-previews/` holds the rendered sheets (light, dark, the Indic locales), produced from the test snapshots by `packages/mail/scripts/screenshots.mjs`.

**Sender.** Cognito's own address until SES has production access; then `no-reply@gede.work` (runbook §5). The templates do not depend on the sender.

---

## 7. Keyboard shortcut map (shortcuts.md, verbatim)

"Keyboard shortcuts — matches iCloud Numbers. Resolve every shortcut from `event.code`, not `event.key`, so they work on Tamil99, InScript and Remington layouts. No shortcut may be the only route to a command; each also appears beside its command in a menu or tooltip."

**Document:** New workscape ⌘N · Open ⌘O · Print ⌘P · Close document ⌘W · Show shortcut sheet ?
**Edit:** Undo / Redo ⌘Z · ⇧⌘Z · Cut / Copy / Paste ⌘X · ⌘C · ⌘V · Paste and match style ⌥⇧⌘V · Select all ⌘A · Delete contents ⌫
**Find:** Find ⌘F · Find next / previous ⌘G · ⇧⌘G · Find and replace ⌥⌘F · Close find bar Esc
**Format:** Bold / Italic / Underline ⌘B · ⌘I · ⌘U · Strikethrough ⇧⌘X · Superscript / Subscript ⌃⌘+ · ⌃⌘− · Format inspector ⌥⌘1 · Organize inspector ⌥⌘2
**Table and cells:** Move between cells Tab · ⇧Tab · arrows · Edit cell ⏎ or double-click · Commit and move down / right ⏎ · Tab · Cancel edit Esc · Add row below ⌥⌘↓ · Add column after ⌥⌘→ · Nest / promote row ⌘] · ⌘[
**View:** Zoom in / out ⌘+ · ⌘− · Actual size ⌘0 · Fit to canvas ⇧⌘0 · Show or hide inspector ⌥⌘I · Next / previous sheet ⌃⇥ · ⌃⇧⇥

---

## 8. Prototype inventory — "Work Scape Canvas.dc.html"

One `<x-dc>` artboard, 352KB (package 2026-09-12; was 339KB — see `docs/PROTOTYPE-CHANGES-2026-09-12.md` for the delta); a single `class Component extends DCLogic` (~3,500 lines) with a templated HTML body (`{{ }}` bindings, `list="{{ ... }}"` repeaters). Props panel (editable in Claude Design): `accent` (color; options #14532d, #0f766e, #155e75, #1f3d7a), `initialLayout` (float | lanes | stack), `gridlines` (off | light | contrast), `showEdges` (bool), `density` (compact | comfortable). Note: prototype chrome uses `oklch(...)` neutrals (e.g. body bg `oklch(0.966 0.004 262)`), which predate the tokens.css slate ramp — the DS is the normative source.

**Screens / states (routed by `S.user` and `S.docOpen`):**
1. Sign-in / sign-up (`!S.user`): two-column at ≥900px with hero; email → one-time code step ("Verify and sign in" / "Verify and create account"), "Sign in with passkey" (note: "Face ID, Touch ID or your device PIN…"), "Sign in with Apple" / "Continue with Apple", copy "Sign in with your passkey, a one-time code, or Apple.", "Welcome back", "Create your GeDe account". User persisted in `localStorage['gede.user']`.
2. Library (`inLibrary`): header with `?` (Guided tour), + and the user initial; sidebar 230px (hidden <900px) with nav Recents ◷ / Browse ▭ / Shared ⇪ / Archived ▣ / Recently Deleted ⌫ and favourites (1Cloudhub, Governance); search; grouped list by when/owner; sort by Name/Date; toolbar Share · Download a copy · Send a copy · Delete | Archive | Recover | Unarchive (slot varies by view and selection) · More; participants panel (Owner, "(You)", Can make changes / View only); bottom-centred toasts with Undo. Fixture `LIBDOCS`: Q3 Delivery — Guided sample (42 KB, `sample: true`, shown first in Recents), 1Cloudhub - Workscape (956 KB, Meenarapan), Generic Design Architect (Sembian V), GEDE | Resource library, GeDe | MicroWorks, REKI | JOTTER, Documentations | ResorucM2, Monthly Cash Distribution (mine), Everest trek. Trash/archive/purge are in-memory maps on `S.lib` (`trashed`, `archived`, `purged`); the tour flag is `localStorage['gede.tour.done']` — both are prototype stand-ins for server state (ONB-03, LIB-D11).
3. Document canvas (`inDoc`): title bar, sheet switcher, toolbar (`t.tools`: Pin to viewport/Unpin, Collapse all, Expand all…), pan/zoom viewport (scale 0.46 default; LOD `micro` ≥0.48, `meso` ≥0.3, `macro` below), tables on 160×22 lattice, DAG edges between tables, graph objects (ring + coverage pair), context menu (`ctxItems`), find bar, share sheet, shortcut sheet (`?` / Esc), inspector rail (`railOpen`) with tabs Graph (when graph selected) · Table · Cell · Text · Arrange · Derive, and an Organize panel with tabs Categories · Sort · Filter. Read-only when `vw < 768` ("View only on phone"); tablet 768–1199.

**Components demonstrated:** grid cells with inline edit (draft/commit/cancel), formula cells (`=sum(...)`, `=concat(...)`, A1 refs and ranges, `@Entity.Path` references with autocomplete), derived columns (Extract by chip regex — Email/Date/Currency/Company/Country/Parenthetical/After dash/Before dash; Format presets Title Case/UPPERCASE/lowercase/Trimmed; Split into child rows; Word count/Characters/Frequency), nested rows (depth `d`, nest/promote), column ops (add before/after, delete, hide, fit width, reorder, freeze header rows/cols, merge/unmerge, wrap text), row ops, sort/filter/category facets, quick filter, cell text formatting (bold/italic/underline/strike/sup/sub, fonts Helvetica Neue / IBM Plex Mono / Georgia, ink swatches, highlights #fff3a3/#d9f2d0/#fbd9e8/#d7e8fb, presets Title 19/600, Heading 14/600, Body 11.5/400), cell borders (none/hairline/strong/accent; edges), table styles, gridline modes, zebra, data formats (Automatic/Text/Number/Currency/Date; currencies SGD MYR PHP IDR USD INR; dp), locales (en-US, en-GB, en-IN, ta-IN, hi-IN, te-IN with keyboard notes and `Intl.Collator` numeric/base), layouts (Free float / Pipeline lanes / Single stack / Side by side / Stacked), graph views (ring with Greek-letter nodes α…ω, palette GPAL `#14532d #155e75 #b45309 #6d28d9 #0f766e #9d174d #1f3d7a #7c3a05`; coverage matrix with rowDim/colDim/pins; "Point at table"/"Re-point"/"No table bound"; shaped table "Contexts n" with Dimension A/B/C + Notes), child sheets ("Children of <symbol>"), share sheet (access "Only people you invite" / "Anyone with the link"; perms edit/view; people fixtures shankar@/miren@1cloudhub.com; Copy link / "Link copied"; Send a copy / Download a copy), NL "compile intent" bar (`compileIntent`, Magic Fill, Add to Playground…), Copy Snapshot, toasts, "Everything is saved. Nothing is left on this device." sign-out copy. Added 2026-09-12: five-step guided tour (`TOUR` table, `data-tour` anchors `sample` / `graph` / `find` / `share`, spotlight scrim + fixed coachmark card, `STEP n OF 5` counter, progress dots, Skip, completion toast with Replay) and library delete/archive (conditional toolbar slot, Archived view, Recently Deleted with Recover / Recover All / Delete All, Undo toasts).

**Document model hints (fixtures):**
- Table: `{ id, code ('1°','2Tₐ','3°'), title, meta, w, h, sortCol, indentCol, cols: [{ id, label, w, mono?, accent?, strong?, center? }], rows: [...] }`.
- Row: `{ id, d (depth 0..n), <colId>: text, sub?, bgSub?, subs?: { colId: subscript }, dim?: [colIds], muted?, bold? }` — ids like `w0…w17`, `s1…s23`, `a0…a30`, `g1…g14`; user tables `ut<n>`, rows `ut1-r0`, new rows `<tid>-n<6 digits>`, new cols `xc<n>_<4 digits>` / `xc<6 digits>`.
- Cell key = `rowId + ':' + colId` (e.g. `a3:name`); all per-cell state maps keyed that way: `edits, fmt, dataFmt, formulas {expr, parts}, refs, linkVals, wrap, depth`. Per-column maps keyed `tid:colId` (`colW, colFmt {kind,cur,dp}, freeze, hiddenCols, removedCols, colOrder, sort, query, fuzzy, facet, groupBy`).
- Address index `addr = { byKey: { 'rowId:colId' → 'B14' }, byAddr: { 'B14' → { table, rowId, colId } } }`; column letter from lattice x offset (`colLetter`), row number from lattice y (`Math.round(y / GH) + TITLE_ROWS(2) + derived-header + 1`), `GW=160`, `GH=22`, `snapW` rounds widths to 160 multiples. Address ranges parse `^[A-Z]{1,3}\d{1,4}$`.
- Sheets: `{ id 'sh1'.., num '1°', label ('Workscape','GovernBASE','Assemblage','Programage','Directorate'), tables: [tid] }`; `sheetTables` for user additions; child sheets `child_<stamp>`.
- Edges: `{ from: tid, to: tid, label '@Group ▸ Work-Groups', dash }`.
- Graphs: `{ id, pair, sheet, tid, dims[], view 'ring'|'coverage', x, y, w (lattice cols), h (lattice rows), rowDim, colDim, pins{} }`.
- Derived column: `{ id 'd1', src: colId, method 'Extract'|'Format'|'Split', args {chip|preset|delimiter} }`.
- Presence/people are name+email+perm; no server model — all client state.

---

## 9. Technology choices

- **React** (DS header "v1.0 · React"; prototype and DS are `React.createElement` class components on Claude Design's `DCLogic` runtime — no version pinned). Handoff sample uses JSX + `@radix-ui/react-dropdown-menu`.
- **Headless primitives: Radix UI** (Ark/Base UI listed as acceptable alternates; all concrete references are Radix).
- **CSS approach:** tokens as **vanilla CSS custom properties** in `tokens.css` (`:root` + `[data-theme="dark"]`) plus a typed `theme.ts` object generated from the same JSON source ("One source of truth in JSON, emitted as CSS custom properties and a typed TypeScript theme"). The `Button.tsx` sample uses a Stitches-style `styled('button', { variants, defaultVariants })` API with `$token` references from `@/theme` — i.e. a CSS-in-JS/variants API, not Tailwind and not CSS Modules (neither is mentioned). Dark theme = `data-theme="dark"` attribute token swap.
- **Fonts:** Helvetica Neue / Helvetica / Arial system stack (not web-loaded); IBM Plex Mono 400/500/600 and Noto Sans Tamil/Devanagari/Telugu 400/600 loaded from Google Fonts (`fonts.googleapis.com/css2?...&display=swap`, preconnect to fonts.gstatic.com). Prototype loads Plex Mono at 400/500 only.
- Root font-size 16px; rem everywhere; container queries inside the canvas; `event.code`-based shortcuts.
- Domain: `gede.1cloudhub.com`; PWA manifest `site.webmanifest`; auth is passkey / OTP email / Sign in with Apple, no passwords.
