import { useEffect, useState } from 'react';

/**
 * A11Y-05: one polite live region for the whole app. Anything — selection,
 * sync status, loading progress — calls `announce()`; the region re-renders
 * the text so assistive tech reads it once.
 */
const listeners = new Set<(text: string) => void>();
let lastText = '';

export function announce(text: string): void {
  // Repeat announcements need a changed DOM node; a trailing space toggles it.
  lastText = lastText === text ? `${text} ` : text;
  listeners.forEach((l) => {
    l(lastText);
  });
}

export function LiveRegion() {
  const [text, setText] = useState('');
  useEffect(() => {
    listeners.add(setText);
    return () => {
      listeners.delete(setText);
    };
  }, []);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="gd-visually-hidden"
      data-testid="live-region"
    >
      {text}
    </div>
  );
}
