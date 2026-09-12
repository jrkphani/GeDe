/**
 * The last workscape this tab had open. The document shell records it on
 * load and rename; the signed-out screen names it ("Signed out of GeDe —
 * Everest trek is saved"). Session storage: it is a fact about this tab, and
 * "Switch account" must not carry it to the next person.
 */
const KEY = 'gede.lastDocument';

export interface LastDocument {
  id: string;
  title: string;
}

export function rememberLastDocument(doc: LastDocument): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(doc));
  } catch {
    /* nothing to remember with */
  }
}

export function readLastDocument(): LastDocument | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v === 'object' && v !== null && 'id' in v && 'title' in v) {
      const { id, title } = v;
      if (typeof id === 'string' && typeof title === 'string' && title !== '') return { id, title };
    }
    return null;
  } catch {
    return null;
  }
}

export function forgetLastDocument(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}
