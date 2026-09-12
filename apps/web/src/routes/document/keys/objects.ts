/**
 * Moving focus between the objects on a sheet — tables and graphs — without a
 * pointer (A11Y-01, ADR-038, #131). Tab never leaves a table forward: past
 * its last cell it appends a row (GRID-05), so a graph below a table cannot
 * be reached by Tab. ⌃⌥→ / ⌃⌥← step through the sheet's objects in the order
 * they render, landing on each object's own entry: a table's tab stop (its
 * selected cell, else its first), a graph's header.
 *
 * Reads the DOM the canvas renders, as the context menu does, so nothing here
 * keeps a second model of the sheet. A pinned table's inert ghost is skipped;
 * its live copy in the pinned layer counts once.
 */

/** Every focusable object on the sheet, in render order. */
export function sheetObjects(root: ParentNode = document): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('section[data-table-id], section[data-graph-id]'),
  ).filter((el) => el.closest('[inert]') === null);
}

/** The object the active element sits in, or null. */
export function currentObject(active: Element | null): HTMLElement | null {
  return active?.closest<HTMLElement>('section[data-table-id], section[data-graph-id]') ?? null;
}

/** Where focus lands inside an object: a table's tab stop, a graph's header or its tab stop. */
export function objectEntry(object: HTMLElement): HTMLElement | null {
  if (object.dataset.tableId !== undefined) {
    return (
      object.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]') ??
      object.querySelector<HTMLElement>('[role="gridcell"]')
    );
  }
  return (
    object.querySelector<HTMLElement>('.gd-graph__header[tabindex]') ??
    object.querySelector<HTMLElement>('[tabindex="0"]')
  );
}

/**
 * The object `direction` steps from the current one, wrapping at either end;
 * with none current, the first (forward) or last (backward). Null on an empty
 * sheet.
 */
export function stepObject(
  objects: readonly HTMLElement[],
  current: HTMLElement | null,
  direction: 1 | -1,
): HTMLElement | null {
  if (objects.length === 0) return null;
  const index = current === null ? -1 : objects.indexOf(current);
  if (index < 0) return objects[direction === 1 ? 0 : objects.length - 1] ?? null;
  return objects[(index + direction + objects.length) % objects.length] ?? null;
}
