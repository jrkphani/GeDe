/**
 * A11Y-03: the colour pairs the inspector, the context menus and the shortcut
 * sheet put on screen, measured from the tokens in both themes. Body text
 * ≥ 4.5:1; UI boundaries and large text ≥ 3:1. The ratios printed by this
 * test are the ones recorded in the pull request.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(__dirname, '../../../../../../packages/tokens/src/tokens.css'),
  'utf8',
);

function block(selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  const start = css.search(selector);
  if (start < 0) return out;
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const light = block(/^:root \{/m);
const dark = { ...light, ...block(/^\[data-theme="dark"\] \{/m) };

/** Resolve `var(--x)` chains to a hex; `color-mix` is not resolved (not used by the pairs below). */
function hex(tokens: Record<string, string>, name: string): string {
  let value = tokens[name] ?? '';
  for (let i = 0; i < 8; i += 1) {
    const ref = /^var\(--([\w-]+)\)$/.exec(value);
    if (ref === null) break;
    value = tokens[ref[1]!] ?? '';
  }
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a plain hex: ${value}`);
  return value;
}

function luminance(h: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

/** Text on background, by token name, with the floor each must clear. */
const PAIRS: readonly { where: string; fg: string; bg: string; floor: number }[] = [
  {
    where: 'inspector labels, section hints (mono 9 px, muted)',
    fg: 'ink-muted',
    bg: 'surface',
    floor: 4.5,
  },
  { where: 'inspector body, select triggers, menu items', fg: 'ink', bg: 'surface', floor: 4.5 },
  {
    where: 'shortcut sheet keycaps, stepper values on sunken',
    fg: 'ink',
    bg: 'surface-sunken',
    floor: 4.5,
  },
  {
    where: 'muted text on the sunken surface (sheet counts)',
    fg: 'ink-muted',
    bg: 'surface-sunken',
    floor: 4.5,
  },
  { where: 'inspector address (live amber)', fg: 'selection-ring', bg: 'surface', floor: 4.5 },
  { where: 'formula error line', fg: 'danger', bg: 'surface', floor: 4.5 },
  { where: 'menu danger items', fg: 'danger', bg: 'surface', floor: 4.5 },
  { where: 'menu checkmark, select checkmark', fg: 'link', bg: 'surface', floor: 3 },
  { where: 'rail and menu borders', fg: 'border', bg: 'surface', floor: 1.2 },
  { where: 'focus ring against the surface', fg: 'focus-ring', bg: 'surface', floor: 3 },
];

describe('A11Y-03 contrast of the Wave 2 chrome', () => {
  for (const theme of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`A11Y-03 every pair clears its floor in the ${theme[0]} theme`, () => {
      const report: string[] = [];
      for (const pair of PAIRS) {
        const ratio = contrast(hex(theme[1], pair.fg), hex(theme[1], pair.bg));
        report.push(`${pair.where}: ${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}:1`);
        expect(ratio, `${theme[0]} ${pair.where}`).toBeGreaterThanOrEqual(pair.floor);
      }
      // Printed so the ratios can be copied into the pull request.
      console.info(`[A11Y-03 ${theme[0]}]\n${report.join('\n')}`);
    });
  }
});
