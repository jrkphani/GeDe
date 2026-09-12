# GeDe — build handover

Everything a team needs to build GeDe: a working prototype, the functional
specification, the architecture, and the design system with its tokens.

## What is here

    prototype/
      Work Scape Canvas.dc.html     The interactive prototype. Open in a browser.
      support.js                    Runtime it loads. Keep alongside.

    specs/
      Text-Oriented Spreadsheet PRD.dc.html   Product spec, §1–24.
      GeDe Architecture C4.dc.html            C4 context → containers → components,
                                              deployment, data model, capacity.
      GeDe Design System.dc.html              Tokens, iconography, components,
                                              responsive, motion, a11y, voice, emails.
      GeDe Error Pages.dc.html                4xx and 5xx states.
      GeDe Sign-in Options.dc.html            Sign-in and sign-out directions (1c shipped).
      GeDe First Run.dc.html                  First-run tour directions (1a shipped).

    tokens/
      tokens.css                    CSS custom properties. The source of truth.
      theme.ts                      Typed theme object for React.

    reference/
      shortcuts.md                  Keyboard map, matching iCloud Numbers.

    CHANGELOG.md                    What changed since the last package, with the
                                    requirement IDs for anything the PRD prose
                                    does not cover yet. Read this first.

Open any .html file directly in a browser — no build step, no server.

## Reading order

0. **CHANGELOG.md** — what changed since the last package, and the open items.
1. **PRD §1–23** — what the product is and why the grid is a lattice.
2. **PRD §24** — 135 numbered, testable requirements across eighteen areas
   (AUTH, LIB, LIB-D, DOC, GRID, FMT, FX, REF, HIER, FIND, KEYS, SORT, MENU,
   INSP, GRAPH, SHARE, LOAD, I18N, A11Y, RESP, ONB). Each ID is the unit of QA
   traceability.
3. **Architecture** — containers, the reactive dependency graph, persistence,
   deployment on ARM, and the capacity model.
4. **Design system** — before writing any component.
5. **Prototype** — the behavioural reference when prose is ambiguous.

Where the prototype and the PRD disagree, the PRD wins; file the difference.
The CHANGELOG is orientation; the PRD carries the binding wording.

## Stack decisions already made

- **React + TypeScript.** Grid body virtualised; formula evaluation outside React.
- **Reactive dependency graph** keyed by stable cell ids, with cycle detection —
  not a general DAG engine.
- **ProseMirror-family rich-text schema** with a mark-preserving transform algebra.
  Not Quill or Slate.
- **DOM-first rendering.** Canvas is reserved for gridlines and bulk edges.
  No PixiJS, no React Flow.
- **Sparse lattice index**, not a quadtree — everything snaps to 160 × 22.
- **CRDT persistence** (Yjs or Automerge). The document is shared by default.
- **Web Workers** for regex and fuzzy matching.
- **Headless component primitives** (Radix, Ark or Base UI). A hand-rolled
  dropdown is a defect: it will be inconsistent and inaccessible.
- **Cognito** for identity. Passwordless only: passkeys, one-time codes, Apple.
- **ARM** compute, CodeBuild CI/CD, ap-southeast-1.

## Non-negotiables

- **Tokens.** No literal hex, radius or duration in a component file.
- **WCAG 2.1 AA.** Keyboard-complete, 2 px amber focus ring, 4.5:1 body contrast,
  no state carried by hue alone.
- **Addressing.** Presentation never changes a cell's A1 address. Indentation,
  wrapping and grouping are visual; position is data.
- **Optimistic editing.** A local edit renders immediately; typing is never
  blocked by sync. Only a failed sync surfaces anything.
- **Phone is read-only** below 768 px, by contract.
- **Apple's sign-in button** is Apple's. Three variants, their glyph, 44 pt
  minimum, approved wording, never subordinate to another provider.

## Definition of done, per component

1. No literal colour, radius or duration in source.
2. All interactive states specified and keyboard-reachable.
3. Renders at 480, 768, 1024, 1440 and at 200 % zoom.
4. Light and dark checked; contrast ratio recorded in the PR.
5. Built on the headless primitive, not a `div` with handlers.
