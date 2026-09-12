import { describe, expect, test } from 'vitest';

import { CHROME_UNSAFE_PORTS, PORT_BASE, PORT_SPAN, portFromHash } from './e2e-port.js';

describe('e2e preview port', () => {
  test('never lands on a port Chromium refuses (ERR_UNSAFE_PORT), for every hash', () => {
    for (let hash = 0; hash < 65536; hash += 1) {
      const port = portFromHash(hash);
      expect(CHROME_UNSAFE_PORTS.has(port), String(hash)).toBe(false);
      expect(port).toBeGreaterThanOrEqual(PORT_BASE);
      expect(port).toBeLessThan(PORT_BASE + PORT_SPAN);
    }
    // The hash that named 5061 for one checkout steps to the next free port.
    expect(portFromHash(5061 - PORT_BASE)).toBe(5062);
    expect(portFromHash(5060 - PORT_BASE)).toBe(5062);
    expect(portFromHash(4045 - PORT_BASE)).toBe(4046);
    expect(portFromHash(0)).toBe(PORT_BASE);
  });
});
