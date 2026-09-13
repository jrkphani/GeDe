/**
 * The live bounding box of a step's target (ONB-04). Finds the elements by
 * their `data-tour` anchor and re-measures them whenever anything that can
 * move them happens — never on a timer:
 *
 *   - a MutationObserver on the document, so the anchor is found the moment
 *     it mounts (the toolbar after navigating into the sample) and dropped
 *     the moment it unmounts, and any layout-changing mutation re-measures;
 *   - a ResizeObserver on the elements and on the root, for size changes;
 *   - `resize` and capturing `scroll` on the window (so a scrolled inspector
 *     re-measures the checklist inside it), and `visualViewport`
 *     resize/scroll for pinch and browser zoom;
 *   - capturing `transitionend` / `animationend` on the document, so a
 *     target moved by a CSS transition or animation on any ancestor (the
 *     inspector docking, a sheet sliding) is re-measured when it settles —
 *     no mutation happens for those, and no timer is used;
 *
 * every trigger schedules one `requestAnimationFrame`, and the state only
 * changes when the rounded box did.
 *
 * A target is a list of selectors tried in order; the first with a painted
 * match wins, and the box is the union of its matches — step 3's `point`
 * card spotlights every pointing target over the sheet's tables at once, and
 * its `dimensions` card falls back from the checklist to the person's ring
 * graph while the checklist is not on screen (graph deselected).
 */
import { useEffect, useState } from 'react';

import { intersectRect, roundedRect, sameRect, unionRect, type Rect } from './geometry.js';
import type { TourTarget } from './steps.js';

/** The selectors a target resolves to, in order of preference. */
export type TargetSelectors = readonly string[];

export function anchorSelector(target: TourTarget): string {
  return `[data-tour="${target}"]`;
}

/**
 * Which elements a card spotlights. `pairId` is the pair the person made in
 * step 3: while its checklist is not on screen, the spotlight falls back to
 * what brings it back — the pair's ring while it is not selected (select it),
 * else the collapsed rail's Expand control (the person dismissed the overlay,
 * RESP-03), else the ring.
 */
export function targetSelectors(
  target: TourTarget | null,
  pairId: string | null = null,
): TargetSelectors | null {
  if (target === null) return null;
  if (target === 'dimensions' && pairId !== null) {
    const ring = `[data-pair-id="${pairId}"][data-graph-kind="ring"]`;
    return [
      anchorSelector(target),
      `${ring}:not([data-selected])`,
      anchorSelector('inspector-expand'),
      ring,
    ];
  }
  return [anchorSelector(target)];
}

const CLIPPING = new Set(['auto', 'scroll', 'hidden', 'clip']);

/**
 * The element's box as painted: its bounding box, clipped by every scrolling
 * ancestor (the inspector rail scrolls; a checklist scrolled half out of it
 * is spotlit only where it shows). Null when nothing of it paints.
 */
export function paintedRect(element: HTMLElement): Rect | null {
  let box = roundedRect(element.getBoundingClientRect());
  for (let node = element.parentElement; node !== null && box !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (CLIPPING.has(style.overflowX) || CLIPPING.has(style.overflowY)) {
      box = intersectRect(box, roundedRect(node.getBoundingClientRect()));
    }
  }
  return box;
}

export interface Anchors {
  /** The first selector's painted matches, in document order; empty when none paints. */
  readonly elements: readonly HTMLElement[];
  /** Matches of that selector that paint nothing (a pointing target off the canvas). */
  readonly hidden: number;
}

const NO_ANCHORS: Anchors = { elements: [], hidden: 0 };

export function tourAnchors(selectors: TargetSelectors): Anchors {
  for (const selector of selectors) {
    const all = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const elements = all.filter((element) => paintedRect(element) !== null);
    if (elements.length > 0) return { elements, hidden: all.length - elements.length };
  }
  return NO_ANCHORS;
}

/** The anchors' union box, or null when nothing paints. */
function measureAnchors(elements: readonly HTMLElement[]): Rect | null {
  let box: Rect | null = null;
  for (const element of elements) box = unionRect(box, paintedRect(element));
  return box;
}

/** Measure once, now. Exported for the hook and for tests. */
export function measureTarget(target: TourTarget | TargetSelectors | null): Rect | null {
  if (target === null) return null;
  const selectors = typeof target === 'string' ? [anchorSelector(target)] : target;
  return measureAnchors(tourAnchors(selectors).elements);
}

export interface Spotlight {
  /** The union box of the painted anchors, or null. */
  readonly rect: Rect | null;
  /** Anchors that paint nothing — the card can say a target is off the canvas. */
  readonly hidden: number;
}

const NO_SPOTLIGHT: Spotlight = { rect: null, hidden: 0 };

function measureSpotlight(selectors: TargetSelectors | null): Spotlight {
  if (selectors === null) return NO_SPOTLIGHT;
  const anchors = tourAnchors(selectors);
  return { rect: measureAnchors(anchors.elements), hidden: anchors.hidden };
}

function sameSpotlight(a: Spotlight, b: Spotlight): boolean {
  return a.hidden === b.hidden && sameRect(a.rect, b.rect);
}

/** Joins a selector list into one dependency key; no selector contains a newline. */
const SEPARATOR = '\n';

function sameElements(a: readonly HTMLElement[], b: readonly HTMLElement[]): boolean {
  return a.length === b.length && a.every((element, i) => element === b[i]);
}

export function useSpotlight(selectors: TargetSelectors | null): Rect | null {
  return useSpotlightBox(selectors).rect;
}

export function useSpotlightBox(selectors: TargetSelectors | null): Spotlight {
  // Selectors are compared by value, so a caller may pass a fresh array each render.
  const key = selectors === null ? null : selectors.join(SEPARATOR);
  const [spotlight, setSpotlight] = useState<Spotlight>(() => measureSpotlight(selectors));

  useEffect(() => {
    if (key === null) {
      setSpotlight(NO_SPOTLIGHT);
      return;
    }
    const list = key.split(SEPARATOR);
    let frame: number | null = null;
    let observed: readonly HTMLElement[] = [];
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);

    function measure(): void {
      frame = null;
      const anchors = tourAnchors(list);
      if (!sameElements(anchors.elements, observed)) {
        for (const element of observed) resize?.unobserve(element);
        observed = anchors.elements;
        for (const element of observed) resize?.observe(element);
      }
      const next: Spotlight = { rect: measureAnchors(anchors.elements), hidden: anchors.hidden };
      setSpotlight((previous) => (sameSpotlight(previous, next) ? previous : next));
    }

    function schedule(): void {
      if (frame !== null) return;
      frame = requestAnimationFrame(measure);
    }

    const mutations = new MutationObserver(schedule);
    mutations.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    resize?.observe(document.documentElement);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    document.addEventListener('transitionend', schedule, true);
    document.addEventListener('animationend', schedule, true);
    measure();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      mutations.disconnect();
      resize?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, { capture: true });
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      document.removeEventListener('transitionend', schedule, true);
      document.removeEventListener('animationend', schedule, true);
    };
  }, [key]);

  return key === null ? NO_SPOTLIGHT : spotlight;
}

/** The viewport's size, re-read on resize and zoom. */
export function useViewportSize(): { width: number; height: number } {
  const read = (): { width: number; height: number } => ({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const update = (): void => {
      setSize((previous) => {
        const next = read();
        return previous.width === next.width && previous.height === next.height ? previous : next;
      });
    };
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    update();
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  return size;
}
