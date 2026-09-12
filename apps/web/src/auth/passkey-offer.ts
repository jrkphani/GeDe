/** AUTH-07: after a code sign-in, offer a passkey; a decline is honoured for 30 days. */
const KEY = 'gede.passkeyOfferDeclinedAt';
export const DECLINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function passkeyOfferDeclinedRecently(now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return false;
    const at = Number(raw);
    return Number.isFinite(at) && now - at < DECLINE_WINDOW_MS;
  } catch {
    return false;
  }
}

export function recordPasskeyOfferDeclined(now: number = Date.now()): void {
  try {
    localStorage.setItem(KEY, String(now));
  } catch {
    /* private mode: we will simply ask again next time */
  }
}

export function clearPasskeyOfferDecline(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
