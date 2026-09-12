/**
 * The live bounding box of a step's target (ONB-04). Finds the element by
 * its `data-tour` anchor and re-measures it whenever anything that can move
 * it happens — never on a timer:
 *
 *   - a MutationObserver on the document, so the anchor is found the moment
 *     it mounts (the toolbar after navigating into the sample) and dropped
 *     the moment it unmounts, and any layout-changing mutation re-measures;
 *   - a ResizeObserver on the element and on the root, for size changes;
 *   - `resize` and capturing `scroll` on the window, and `visualViewport`
 *     resize/scroll for pinch and browser zoom;
 *   - capturing `transitionend` / `animationend` on the document, so a
 *     target moved by a CSS transition or animation on any ancestor (the
 *     inspector docking, a sheet sliding) is re-measured when it settles —
 *     no mutation happens for those, and no timer is used;
 *
 * every trigger schedules one `requestAnimationFrame`, and the state only
 * changes when the rounded box did.
 */
import { useEffect, useState } from 'react';

import { roundedRect, sameRect, type Rect } from './geometry.js';
import type { TourTarget } from './steps.js';

export function tourAnchor(target: TourTarget): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
}

/** Measure once, now. Exported for the hook and for tests. */
export function measureTarget(target: TourTarget | null): Rect | null {
  if (target === null) return null;
  const element = tourAnchor(target);
  if (element === null) return null;
  return roundedRect(element.getBoundingClientRect());
}

export function useSpotlight(target: TourTarget | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(() => measureTarget(target));

  useEffect(() => {
    if (target === null) {
      setRect(null);
      return;
    }
    let frame: number | null = null;
    let observedElement: HTMLElement | null = null;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);

    function measure(): void {
      frame = null;
      const element = target === null ? null : tourAnchor(target);
      if (element !== observedElement) {
        if (observedElement !== null) resize?.unobserve(observedElement);
        observedElement = element;
        if (element !== null) resize?.observe(element);
      }
      const next = element === null ? null : roundedRect(element.getBoundingClientRect());
      setRect((previous) => (sameRect(previous, next) ? previous : next));
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
  }, [target]);

  return target === null ? null : rect;
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
