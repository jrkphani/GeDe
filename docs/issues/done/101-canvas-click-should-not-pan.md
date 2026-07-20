# 101: Canvas — clicking an element should NOT pan/center the viewport (keyboard-only focus-pan)

- **Status**: ✅ SHIPPED (2026-07-20). User-reported: on the default canvas, clicking any element tries to center the viewport on it, which is unnecessary and jarring. Fixed by gating the focus-pan to keyboard-initiated focus only (adversarially validated design). RED-first e2e: click + touch tap both assert no pan; cross-node Tab (keyboard) still pans. verify:fast 1650; canvas suite 25/25.
- **Milestone**: M7 (089 canvas). **Depends on**: 089-P7 (canvas is now the default surface, so this is user-facing).

## Problem

`WorkspaceCanvas.onFocusCapture` (the D3 spike gate-d "focus-driven pan") fires on **every** focus and pans the viewport when the focused element is near/past a pane edge. It was designed for **keyboard** navigation — native `scrollIntoView` is a no-op on a transformed plane, so Tabbing to an off-screen cell (cross-node Tab, ⌘-jumps) needs an explicit pan to bring it into view. But it also fires on **mouse/touch clicks**, where the element is already visible (you just clicked it) — so the pan is pointless and disorienting.

## Fix (adversarially validated)

Gate the focus-pan to **keyboard-initiated focus only**, via a persistent "last input modality" ref (NOT a timer). On the canvas wrapper: `onKeyDownCapture` sets `lastInputWasKeyboardRef = true`, `onPointerDownCapture` sets it `false`; `onFocusCapture` early-returns unless the ref is `true`.

A first-cut design (a pointer-recency flag cleared on the next `requestAnimationFrame`) was rejected by adversarial review: it (a) reintroduces the bug on **touch** (tap→focus can exceed one rAF, so the flag clears before focus lands) and (b) races the codebase's own rAF-deferred `.focus()` calls (`onTableExitBoundary`/`onPropExitBoundary`/`onTableCreated`/`onPropCreated`). The persistent-modality ref has no expiry window, so it's immune to both: `pointerdown` (any pointerType incl. touch) sets `false` and it STAYS false until the next real keydown; a rAF-deferred keyboard `.focus()` still reads "keyboard" however many frames later — and if the user clicked in between, treating that as "attention moved" is the correct semantic.

`:focus-visible` was also rejected: text inputs are `:focus-visible` on click by UA convention, so click-to-edit (the app's most frequent focus change) would still pan.

## Gate

- **e2e (`@dev-flag`):** clicking a focusable cell near a pane edge does NOT move the viewport transform; the existing cross-node-Tab spec (keyboard focus) still pans its target on-screen.
- Verify: the canvas suite green; no regression to keyboard navigation / cross-node Tab / ⌘1-3 lane jumps.
