/**
 * A11Y-03 for the graphs: every colour pair the ring, the coverage grid, the
 * pointing overlay and the Graph tab put on screen, measured from the tokens
 * in both themes. Text ≥ 4.5:1; strokes, nodes, dots, rings ≥ 3:1. The
 * ratios printed here are the ones recorded in the pull request.
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

function channels(h: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(c: readonly number[]): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Resolve a token to a hex: `var()` chains, and `color-mix(in srgb, A p%, B)`
 * as the browser computes it (a per-channel blend in sRGB) — the dark theme's
 * `--reference-2..5` are mixes of the presence palette with white.
 */
function hex(tokens: Record<string, string>, name: string, depth = 0): string {
  const value = tokens[name] ?? '';
  if (depth > 8) throw new Error(`${name}: too deep`);
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  if (ref !== null) return hex(tokens, ref[1]!, depth + 1);
  const mix = /^color-mix\(in srgb,\s*var\(--([\w-]+)\)\s*(\d+)%,\s*var\(--([\w-]+)\)\)$/.exec(
    value,
  );
  if (mix !== null) {
    const p = Number(mix[2]) / 100;
    const a = channels(hex(tokens, mix[1]!, depth + 1));
    const b = channels(hex(tokens, mix[3]!, depth + 1));
    return toHex(a.map((v, i) => v * p + b[i]! * (1 - p)));
  }
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a plain hex: ${value}`);
  return value;
}

function luminance(h: string): number {
  const lin = channels(h).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

const PAIRS: readonly { where: string; fg: string; bg: string; floor: number }[] = [
  { where: 'complete node symbol (surface on ink)', fg: 'surface', bg: 'ink', floor: 4.5 },
  { where: 'draft node symbol, parameter labels', fg: 'ink', bg: 'surface', floor: 4.5 },
  {
    where: 'dimension labels (mono, muted), header sub line',
    fg: 'ink-muted',
    bg: 'surface',
    floor: 4.5,
  },
  { where: 'draft node dashed stroke', fg: 'ink-muted', bg: 'surface', floor: 3 },
  { where: 'complete node and filled coverage cell', fg: 'ink', bg: 'surface', floor: 3 },
  {
    where: 'selected node ring, lit cell, lit row, pointing outline',
    fg: 'selection-ring',
    bg: 'surface',
    floor: 3,
  },
  { where: 'focus ring on a node, dot or cell', fg: 'focus-ring', bg: 'surface', floor: 3 },
  { where: 'arc and dot, dimension 1', fg: 'reference-1', bg: 'surface', floor: 3 },
  { where: 'arc and dot, dimension 2', fg: 'reference-2', bg: 'surface', floor: 3 },
  { where: 'arc and dot, dimension 3', fg: 'reference-3', bg: 'surface', floor: 3 },
  { where: 'arc and dot, dimension 4', fg: 'reference-4', bg: 'surface', floor: 3 },
  { where: 'arc and dot, dimension 5', fg: 'reference-5', bg: 'surface', floor: 3 },
  { where: 'arc and dot, dimension 6', fg: 'reference-6', bg: 'surface', floor: 3 },
  { where: 'graph glyph in the header', fg: 'link', bg: 'surface', floor: 3 },
  { where: 'coverage symbol on a filled cell', fg: 'surface', bg: 'ink', floor: 4.5 },
  { where: 'Graph tab counts (mono, muted)', fg: 'ink-muted', bg: 'surface', floor: 4.5 },
];

describe('A11Y-03 contrast of the context graphs', () => {
  for (const theme of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`A11Y-03 GRAPH-07 every graph pair clears its floor in the ${theme[0]} theme`, () => {
      const report: string[] = [];
      for (const pair of PAIRS) {
        const ratio = contrast(hex(theme[1], pair.fg), hex(theme[1], pair.bg));
        report.push(`${pair.where}: ${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}:1`);
        expect(ratio, `${theme[0]} ${pair.where}`).toBeGreaterThanOrEqual(pair.floor);
      }
      console.info(`[A11Y-03 graphs ${theme[0]}]\n${report.join('\n')}`);
    });
  }
});
