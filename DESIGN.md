---
name: GeDe
description: A drafting-table interface for shared generative design models.
colors:
  paper: "#fbfaf7"
  panel: "#ffffff"
  ink: "#1a1a1a"
  ink-muted: "#6b6961"
  hairline: "#e3e1d8"
  forest-green: "#2d6a4f"
  forest-green-strong: "#23543f"
  danger: "#b3402e"
  warning: "#9a6b00"
  dimension-violet: "#6f5bd6"
  dimension-teal: "#0e8a93"
  dimension-orange: "#d9542b"
  dimension-magenta: "#c0448f"
  dimension-ochre: "#a87f1a"
  dimension-blue: "#3d6bd6"
  dimension-rose: "#c75d73"
  dimension-slate: "#647e93"
typography:
  display:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "28px"
  headline:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: "24px"
  body:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  chrome:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
  badge:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: "12px"
  micro:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "8px"
    fontWeight: 500
    lineHeight: "10px"
  mono:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
rounded:
  instrument: "0"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "32px"
  7: "48px"
  8: "64px"
components:
  button-command:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.instrument}"
    padding: "4px 8px"
  button-row-action:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.instrument}"
    padding: "4px 8px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.instrument}"
    padding: "16px"
---

# Design System: GeDe

## Overview

**Creative North Star: "The Drafting Table"**

GeDe is a precision instrument for teams building a shared design model. The interface is precise, calm, instrumental, and quietly technical: graph paper is the working ground; opaque paper panels hold records; square geometry and hairline rules make interactions feel deliberate rather than decorative.

The interface privileges the model over chrome. Tables are the durable record and the circle canvas is its spatial companion. Density is comfortable enough for sustained operator work, while the visual system remains restrained so dimensions, bindings, and coverage—not the interface—carry the vivid information.

**Key Characteristics:**

- Graph-paper ground with rectilinear, opaque working surfaces.
- Forest green is the single chrome accent; dimension colors belong only to data.
- Inter handles UI and content; JetBrains Mono marks the method’s symbols, tuples, ranks, and measurements.
- Interaction is immediate; motion exists only to preserve spatial continuity.

## Colors

The palette separates instrument from information: warm paper and dark ink establish the drafting table; forest green communicates interface state; the categorical palette encodes dimensions only.

### Primary

- **Forest Green:** The single chrome accent for focus, links, selected states, and active controls. It is not a general decorative color.
- **Forest Green Strong:** The higher-emphasis green for active controls and primary emphasis.

**The One Chrome Hue Rule.** Use forest green for interface state and keep it out of the dimension-data palette.

### Secondary

- **Dimension Violet, Teal, Orange, Magenta, Ochre, Blue, Rose, and Slate:** Ordered categorical data colors assigned to dimensions. They must never be used as arbitrary UI accents.

### Neutral

- **Paper:** The warm graph-paper ground.
- **Panel:** Opaque white surfaces that keep text off the grid.
- **Ink / Muted Ink:** Primary and supporting typography.
- **Hairline:** The one-pixel structural edge between surfaces, fields, and rows.

### Tertiary

- **Danger and Warning:** Reserved strictly for genuine destructive or cautionary states.

## Typography

**Display Font:** Inter Variable (with system UI fallback)

**Body Font:** Inter Variable (with system UI fallback)

**Label/Mono Font:** JetBrains Mono Variable (with monospace fallback)

**Character:** Inter makes the workspace sober and highly legible. JetBrains Mono appears only where the method itself speaks—Greek context symbols, tuples, ranks, coverage, and IDs—so technical notation remains meaningful rather than ornamental.

### Hierarchy

- **Display:** 600 at 22px / 28px for the app title and rare page-level emphasis.
- **Headline:** 600 at 17px / 24px for tier and section headers.
- **Body:** 400 at 14px / 20px for cells, prose, and routine operations.
- **Label:** 500 at 12px / 16px for supporting controls and compact metadata.
- **Column Head:** 500 at 11px / 16px with uppercase tracking for tabular structure.
- **Compact Chrome:** 600 at 15px for the stable wordmark and coverage lead; it is not body copy.
- **Badge:** 500 at 10px / 12px for collaborator initials inside a fixed 20px identity chip.
- **Matrix Micro:** 500 at 8px / 10px for count overlays inside fixed 24px coverage cells only.
- **Method Notation:** 500 at 13px / 20px in JetBrains Mono for symbols, tuples, ranks, and counts.

**The Meaningful Mono Rule.** Use mono for model notation and measurement, never as a generic “technical” styling cue.

## Layout

The shell uses compact horizontal bands—app bar, contextual controls, working surface, status—above a graph-paper field. The workspace is a three-lane model: Foundation, Architecture, and Design coexist, while lane-focus controls and deep links orient the operator without replacing the shared surface.

Spacing follows a four-pixel scale (4, 8, 12, 16, 24, 32, 48, 64). The 24px grid pitch and 96px major grid align to that rhythm. Tables retain a 40px row height and 12px horizontal cell padding for sustained reading and editing.

On narrow screens, the workspace preserves hierarchy by stacking editing regions rather than compressing them into floating strips. Canvas labels degrade deterministically from full labels to truncation to a legend; touch targets remain at least 44px.

## Elevation & Depth

GeDe is flat by default. Opaque panels, a warm paper ground, and one-pixel hairlines establish hierarchy; shadows are not used to decorate or separate ordinary content. The only ambient shadow belongs to popovers and menus so temporary overlays read above the working surface.

### Shadow Vocabulary

- **Popover:** `0 2px 8px rgba(0, 0, 0, 0.1)` in light mode and `0 2px 8px rgba(0, 0, 0, 0.45)` in dark mode, reserved for menus and popovers.
- **Frozen Table Column:** `2px 0 4px rgba(0, 0, 0, 0.08)` as a functional depth cue for the pinned symbol column.

**The Flat-By-Default Rule.** A surface earns depth only when it temporarily floats above the model or must remain legible while pinned.

## Shapes

All chrome is square: panels, controls, fields, chips, menus, and focus outlines use a zero radius. Hairline borders, not rounded cards, define the instrument.

Circles belong to data geometry alone: canvas arcs, parameter dots, and context nodes. That opposition between rectilinear tool and circular model is the visual signature.

## Components

### Buttons

- **Command buttons:** Always-visible, quiet actions use paper fill, ink text, and a firm muted-ink border. They are legible without hover.
- **Row actions:** Contextual verbs use muted ink and transparent fill, and reveal on the owning row’s hover or focus.
- **Focus:** A square 2px forest-green outline with a 1px offset.
- **Destructive actions:** Reuse the row-action shape and reserve danger color for actual destructive work.

### Inputs / Fields

- **Style:** In-place editing preserves the displayed text metrics and keeps the surface flat; fields use hairlines and square corners where structure is needed.
- **Focus:** Forest-green focus outline; errors and warnings are specific and inline.
- **Phantom rows:** New-record affordances are calm at rest and reveal keyboard guidance when focused.

### Navigation

- **App bar:** A 40px stable band with project identity, lane-focus controls, and compact global utilities.
- **Workspace lanes:** Foundation, Architecture, and Design are focus targets within one shared workspace, not three unrelated destinations.
- **Active state:** Forest-green underline and ink text identify the focused lane; shortcuts remain available in accessible labels.

### Tables / Registers

- **Style:** Opaque paper panels, hairline row and column rules, faint zebra tracking, and a pinned symbol column.
- **Interaction:** Edit in place; hover or focus reveals local row actions; selection uses a green wash and a two-pixel left rule.
- **Tone:** The grid is a record, not a dashboard card.

### Canvas

- **Style:** A square SVG circle lives directly on the graph-paper ground, with colored dimension arcs and derived context geometry.
- **Interaction:** Selection and adjacency make relationships visible; no position is user-authored meaning.
- **Motion:** Only spatial continuity animates—especially drill-down. Commit, hover, and selection feedback remain effectively immediate.

## Do's and Don'ts

### Do:

- **Do** treat the workspace as a precision instrument: use paper, hairlines, square corners, and low-noise hierarchy.
- **Do** use forest green for chrome state and categorical color only for dimensions and relationships.
- **Do** preserve in-place editing, keyboard operation, visible focus, and non-blocking inline recovery.
- **Do** let the model provide visual interest: tuples, coverage, relationships, and data geometry outrank decoration.

### Don't:

- **Don't** turn GeDe into a dashboard of cards, summary metrics, or decorative charts.
- **Don't** add gradients, rounded chrome, decorative shadows, or color used only for ornament.
- **Don't** use mono for arbitrary labels or use dimension colors for generic interface emphasis.
- **Don't** replace the live table/canvas model with a modal tutorial or separate form workflow.
