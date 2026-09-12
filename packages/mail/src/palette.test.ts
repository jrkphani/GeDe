/**
 * The generated palette is pinned to packages/tokens: regenerating from tokens.css must
 * reproduce the committed file byte for byte, and every text/background pair the layout
 * uses clears WCAG AA in both schemes (the ratios the PR records).
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { palette, type ColorScheme } from './generated/palette.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = path.resolve(here, '../../tokens/src/tokens.css');
const GENERATED = path.resolve(here, 'generated/palette.ts');
const GENERATOR = pathToFileURL(path.resolve(here, '../scripts/palette-source.mjs')).href;

interface Generator {
  derivePalette(css: string): unknown;
  renderPaletteModule(palette: unknown): string;
}

/** WCAG 2.1 relative luminance and contrast ratio for `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('email palette', () => {
  test('DESIGN-SYSTEM §1 src/generated/palette.ts is exactly what tokens.css generates (run `npm run generate -w packages/mail` after a token change)', async () => {
    const { derivePalette, renderPaletteModule } = (await import(GENERATOR)) as Generator;
    const expected = renderPaletteModule(derivePalette(readFileSync(TOKENS_CSS, 'utf8')));
    expect(readFileSync(GENERATED, 'utf8')).toBe(expected);
  });

  test('A11Y-01 every text on its background clears 4.5:1 in both schemes; the button and the code box too', () => {
    for (const scheme of ['light', 'dark'] as ColorScheme[]) {
      const k = palette.colors[scheme];
      const pairs: [string, string, string][] = [
        ['ink on surface', k.ink, k.surface],
        ['muted ink on surface', k.inkMuted, k.surface],
        ['link on surface', k.link, k.surface],
        ['button label on button', k.actionFg, k.actionBg],
        ['code on code box', k.accent, k.accentSubtle],
      ];
      for (const [name, fg, bg] of pairs) {
        expect(contrast(fg, bg), `${scheme}: ${name}`).toBeGreaterThanOrEqual(4.5);
      }
      // The card boundary against the sunken page (non-text, 1.4.11 asks 3:1 of a control;
      // a decorative card border is held to the tokens' own hairline standard, ≥ 1.2:1).
      expect(contrast(k.border, k.surface), `${scheme}: border`).toBeGreaterThanOrEqual(1.2);
    }
  });

  test('DESIGN-SYSTEM §1 the fonts and radii are the tokens’ own', () => {
    expect(palette.fontUi).toMatch(/^'Helvetica Neue'/);
    expect(palette.fontMono).toMatch(/^'IBM Plex Mono'/);
    expect(palette.radiusMd).toBe('6px');
    expect(palette.radiusLg).toBe('10px');
  });
});
