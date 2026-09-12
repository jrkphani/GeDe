/**
 * Keyboard access inside an SVG graph (A11Y-01): one tab stop per graph, the
 * arrows move between its nodes, dots and cells, Enter activates and
 * Shift+Enter is the double-click equivalent (open a child sheet). Keys are
 * read from `event.code` (I18N-02) and ignored while composing (I18N-01).
 */
import { useCallback, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface Roving {
  /** `tabIndex` for the item at `index`. */
  tabIndex: (index: number) => 0 | -1;
  /** Keep the tab stop on the item that took focus (a click, or a move). */
  onFocus: (index: number) => void;
  /** Arrow navigation on the container; returns true when it consumed the key. */
  onKeyDown: (event: ReactKeyboardEvent) => boolean;
}

export function useRoving(count: number): Roving {
  const [active, setActive] = useState(0);
  const current = count === 0 ? 0 : Math.min(active, count - 1);
  const tabIndex = useCallback((index: number) => (index === current ? 0 : -1), [current]);
  const onFocus = useCallback((index: number) => {
    setActive(index);
  }, []);
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.nativeEvent.isComposing || count === 0) return false;
      // A modified arrow is someone else's chord (⇧⌘→ steps to the next object, ADR-042).
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
      let next: number | null = null;
      switch (event.code) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = (current + 1) % count;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          next = (current - 1 + count) % count;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = count - 1;
          break;
        default:
          return false;
      }
      event.preventDefault();
      event.stopPropagation();
      setActive(next);
      // Items carry their roving index (`data-graph-item`), since paint order in the SVG is
      // not the traversal order.
      const target = event.currentTarget.querySelector<HTMLElement | SVGElement>(
        `[data-graph-item="${String(next)}"]`,
      );
      if (target !== null && 'focus' in target) {
        (target as HTMLElement).focus({ preventScroll: true });
      }
      return true;
    },
    [count, current],
  );
  return { tabIndex, onFocus, onKeyDown };
}

/** Enter activates; Shift+Enter is the open (double-click) gesture. */
export function activation(event: ReactKeyboardEvent): 'activate' | 'open' | null {
  if (event.nativeEvent.isComposing) return null;
  if (event.code !== 'Enter' && event.code !== 'Space' && event.code !== 'NumpadEnter') return null;
  return event.shiftKey ? 'open' : 'activate';
}
