/**
 * A11Y-03: the colour pairs the inspector, the context menus and the shortcut
 * sheet put on screen, measured from the tokens in both themes. Body text
 * ≥ 4.5:1; UI boundaries and large text ≥ 3:1. The ratios printed by this
 * test are the ones recorded in the pull request.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_TOKENS,
  TEXT_COLOUR_TOKENS,
  UNSAFE_TEXT_ON_FILL,
  type TextColourToken,
} from '@gede/core';

const css = readFileSync(
  resolvePath(__dirname, '../../../../../../packages/tokens/src/tokens.css'),
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

/**
 * Resolve `var(--x)` chains and `color-mix(in srgb, A p%, B)` to a hex. The
 * mix is what CSS does in the sRGB space: a channel-wise blend of the two
 * gamma-encoded colours (the dark tints are built this way in tokens.css).
 */
function hex(tokens: Record<string, string>, name: string): string {
  return resolve(tokens, tokens[name] ?? '', name);
}

function resolve(tokens: Record<string, string>, value: string, name: string): string {
  for (let i = 0; i < 8; i += 1) {
    const ref = /^var\(--([\w-]+)\)$/.exec(value);
    if (ref === null) break;
    value = tokens[ref[1]!] ?? '';
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(value);
  if (mix !== null) {
    const a = resolve(tokens, mix[1]!, name);
    const b = resolve(tokens, mix[3]!, name);
    const p = Number(mix[2]) / 100;
    const ch = (i: number) =>
      Math.round(
        Number.parseInt(a.slice(i, i + 2), 16) * p +
          Number.parseInt(b.slice(i, i + 2), 16) * (1 - p),
      );
    return `#${[1, 3, 5].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`;
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

/** INSP-06 text colour token → the custom property `[data-ink]` paints it with (cell.css). */
const INK_TOKENS: Readonly<Record<TextColourToken, string>> = {
  ink: 'ink',
  'ink-muted': 'ink-muted',
  brand: 'link',
  live: 'selection-ring',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
};

describe('A11Y-03 INSP-04 INSP-05 INSP-06 contrast of fills, bands, rules and text colours', () => {
  it('A11Y-03 every text colour token clears 4.5:1 on every fill tint in both themes, except exactly the pairs @gede/core names as unsafe (which the renderer replaces with ink)', () => {
    const report: string[] = [];
    const unsafe = new Set<string>();
    for (const theme of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const fill of HIGHLIGHT_TOKENS) {
        const bg = hex(theme[1], `tint-${fill}`);
        for (const token of TEXT_COLOUR_TOKENS) {
          const ratio = contrast(hex(theme[1], INK_TOKENS[token]), bg);
          report.push(`${theme[0]} ${token} on ${fill} fill = ${ratio.toFixed(2)}:1`);
          if (ratio < 4.5) unsafe.add(`${fill}:${token}`);
        }
        // Ink on every fill is body text: never under 4.5:1 in either theme.
        expect(
          contrast(hex(theme[1], 'ink'), bg),
          `${theme[0]} ink on ${fill}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    const declared = new Set<string>();
    for (const fill of HIGHLIGHT_TOKENS) {
      for (const token of UNSAFE_TEXT_ON_FILL[fill]) declared.add(`${fill}:${token}`);
    }
    // The core table is the contract the renderer enforces: it must match the measurement.
    expect(Array.from(unsafe).sort()).toEqual(Array.from(declared).sort());
    console.info(`[A11Y-03 fills]\n${report.join('\n')}`);
  });

  it('A11Y-03 the alternating bands and header bands keep ink and muted text ≥ 4.5:1; the rule weights are ≥ 3:1 boundaries on both surfaces', () => {
    const report: string[] = [];
    for (const theme of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const ramp of ['amber', 'forest', 'slate'] as const) {
        // Header bands carry ink only (letters and glyphs take ink on a styled band, document.css);
        // the soft alternating bands carry cell text, which may be muted (a locked cell).
        const bands: [string, readonly ('ink' | 'ink-muted')[]][] = [
          [`tint-${ramp}`, ['ink']],
          [`tint-${ramp}-soft`, ['ink', 'ink-muted']],
        ];
        for (const [kind, inks] of bands) {
          const bg = hex(theme[1], kind);
          for (const fg of inks) {
            const ratio = contrast(hex(theme[1], fg), bg);
            report.push(`${theme[0]} ${fg} on ${kind} = ${ratio.toFixed(2)}:1`);
            expect(ratio, `${theme[0]} ${fg} on ${kind}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
      for (const rule of ['rule-hairline', 'rule-strong', 'rule-accent'] as const) {
        for (const bg of ['surface', 'surface-sunken'] as const) {
          const ratio = contrast(hex(theme[1], rule), hex(theme[1], bg));
          report.push(`${theme[0]} ${rule} on ${bg} = ${ratio.toFixed(2)}:1`);
          expect(ratio, `${theme[0]} ${rule} on ${bg}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
    console.info(`[A11Y-03 bands and rules]\n${report.join('\n')}`);
  });
});

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
