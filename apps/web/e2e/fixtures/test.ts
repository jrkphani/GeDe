import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

/** Every axe run lands here as one JSON file per screen; the global teardown summarises them. */
export const AXE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test-results/axe',
);
export const SCREENSHOT_DIR = path.resolve(AXE_DIR, '../screens');

/** WCAG 2.1 A + AA. `best-practice` is deliberately excluded: it is advisory, not a requirement. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

export interface AxeRecord {
  screen: string;
  url: string;
  viewport: { width: number; height: number } | null;
  deviceScaleFactor: number;
  ranAt: string;
  passes: number;
  incomplete: number;
  violations: {
    id: string;
    impact: string | null;
    help: string;
    helpUrl: string;
    nodes: { target: string[]; failureSummary: string | undefined }[];
  }[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function runAxe(page: Page, screen: string, deviceScaleFactor: number): Promise<AxeRecord> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return {
    screen,
    url: page.url(),
    viewport: page.viewportSize(),
    deviceScaleFactor,
    ranAt: new Date().toISOString(),
    passes: results.passes.length,
    incomplete: results.incomplete.length,
    violations: results.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({
        target: n.target.map(String),
        failureSummary: n.failureSummary,
      })),
    })),
  };
}

function describeViolations(record: AxeRecord): string {
  return record.violations
    .filter((v) => v.impact !== null && BLOCKING_IMPACTS.has(v.impact))
    .map(
      (v) =>
        `${v.id} (${String(v.impact)}): ${v.help}\n` +
        v.nodes.map((n) => `    ${n.target.join(' ')}`).join('\n'),
    )
    .join('\n');
}

export interface A11yFixtures {
  /**
   * Run axe on the current page, save `test-results/axe/<screen>.json` and fail
   * the test on any `serious` or `critical` violation (A11Y-03 contrast is one of them).
   * Moderate and minor findings are recorded, not failed.
   */
  checkA11y: (screen: string) => Promise<AxeRecord>;
  /** Save a full-page screenshot to `test-results/screens/<name>.png` for the PR. */
  snapshot: (name: string) => Promise<void>;
}

export const test = base.extend<A11yFixtures>({
  checkA11y: async ({ page, deviceScaleFactor }, use) => {
    mkdirSync(AXE_DIR, { recursive: true });
    await use(async (screen) => {
      const record = await runAxe(page, screen, deviceScaleFactor ?? 1);
      writeFileSync(path.join(AXE_DIR, `${slug(screen)}.json`), JSON.stringify(record, null, 2));
      const blocking = record.violations.filter(
        (v) => v.impact !== null && BLOCKING_IMPACTS.has(v.impact),
      );
      expect(blocking, `axe: ${screen}\n${describeViolations(record)}`).toEqual([]);
      return record;
    });
  },
  snapshot: async ({ page }, use) => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await use(async (name) => {
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${slug(name)}.png`),
        fullPage: true,
      });
    });
  },
});

export { expect };

/** The four layout breakpoints from the design system (CSS px). */
export const BREAKPOINTS = [480, 768, 1024, 1440] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/**
 * 200 % browser zoom, emulated the way Chromium implements page zoom: the
 * layout viewport halves in CSS px and the device scale factor doubles. Media
 * queries and rem-based type see exactly what a user pressing Ctrl-+ twice
 * sees. (`deviceScaleFactor: 2` alone changes nothing about layout, and CSS
 * `zoom` leaves media queries evaluating the unzoomed width.)
 */
export function zoomed200(width: Breakpoint, height = 900) {
  return {
    viewport: { width: width / 2, height: Math.round(height / 2) },
    deviceScaleFactor: 2,
  };
}

/** Resolve a `--token` colour to its computed rgb() form, exactly as the browser paints it. */
export async function computedTokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

/** Layout holds: nothing overflows the viewport horizontally (A11Y-06, RESP-*). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, 'document must not scroll horizontally').toBeLessThanOrEqual(
    overflow.clientWidth,
  );
}
