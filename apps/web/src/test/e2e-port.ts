/**
 * The local preview port for the Playwright suite: derived from the checkout
 * path so two worktrees never share one (see `playwright.config.ts`), and
 * never one of the ports Chromium refuses to connect to (`ERR_UNSAFE_PORT`,
 * its `net::kRestrictedPorts` list — 5060/5061 are SIP, 4045 lockd, and so on).
 * A checkout whose hash lands on one of those would otherwise fail every
 * journey before it started.
 */
export const PORT_BASE = 4200;
export const PORT_SPAN = 1000;

/** Chromium's restricted ports that fall inside `[PORT_BASE, PORT_BASE + PORT_SPAN)`. */
export const CHROME_UNSAFE_PORTS: ReadonlySet<number> = new Set([4045, 5060, 5061]);

/** The port for a checkout, from its 16-bit path hash; steps past any unsafe port. */
export function portFromHash(hash16: number): number {
  let port = PORT_BASE + (hash16 % PORT_SPAN);
  while (CHROME_UNSAFE_PORTS.has(port)) port = PORT_BASE + ((port - PORT_BASE + 1) % PORT_SPAN);
  return port;
}
