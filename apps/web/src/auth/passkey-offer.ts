/**
 * AUTH-07: after a code sign-in, offer a passkey; a decline is honoured for
 * 30 days. The memory is keyed by the user's `sub`, so one person declining
 * on a shared device does not silence the offer for the next.
 */
const KEY = 'gede.passkeyOfferDeclinedAt';
export const DECLINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const keyFor = (sub: string): string => `${KEY}.${sub}`;

export function passkeyOfferDeclinedRecently(sub: string, now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(keyFor(sub));
    if (raw === null) return false;
    const at = Number(raw);
    return Number.isFinite(at) && now - at < DECLINE_WINDOW_MS;
  } catch {
    return false;
  }
}

export function recordPasskeyOfferDeclined(sub: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(keyFor(sub), String(now));
  } catch {
    /* private mode: we will simply ask again next time */
  }
}

export function clearPasskeyOfferDecline(sub: string): void {
  try {
    localStorage.removeItem(keyFor(sub));
  } catch {
    /* nothing to clear */
  }
}
