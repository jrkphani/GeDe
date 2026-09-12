import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { theme } from './theme.js';

const css = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** `prop: value` pairs of the first block whose selector matches, in source order. */
function declarations(selector: RegExp): [string, string][] {
  const m = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(css);
  if (m === null) throw new Error(`no block for ${selector.source}`);
  return (m[1] ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '')
    .map((d) => {
      const i = d.indexOf(':');
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
    });
}

describe('dark theme', () => {
  const explicit = declarations(/\[data-theme="dark"\]/);
  const preferred = declarations(/:root:not\(\[data-theme="light"\]\)/);

  it('the OS preference applies the same token swap as data-theme="dark", inside prefers-color-scheme: dark', () => {
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{/,
    );
    expect(preferred).toEqual(explicit);
    expect(explicit.length).toBeGreaterThan(0);
  });

  it('swaps every surface/ink token the design system lists and declares the colour scheme', () => {
    const names = explicit.map(([name]) => name);
    for (const token of [
      'color-scheme',
      '--surface',
      '--surface-sunken',
      '--border',
      '--border-strong',
      '--ink',
      '--ink-muted',
      '--action-primary-bg',
      '--selection-ring',
      '--success',
      '--warning',
      '--danger',
      '--info',
      '--skeleton-base',
      '--skeleton-sheen',
    ])
      expect(names).toContain(token);
    expect(Object.fromEntries(explicit)['--surface']).toBe('#0f1a15');
    expect(Object.fromEntries(explicit)['color-scheme']).toBe('dark');
    expect(Object.fromEntries(declarations(/:root/))['color-scheme']).toBe('light');
  });
});

describe('presence palette', () => {
  it('SHARE-04 six presence colours, assigned on join, none of them the brand colour, in CSS and in theme.ts alike', () => {
    const root = Object.fromEntries(declarations(/:root/));
    const presence = [1, 2, 3, 4, 5, 6].map((n) => root[`--presence-${String(n)}`]);
    expect(presence.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(new Set(presence).size).toBe(6);
    expect(presence).toEqual([...theme.color.presence]);
    const brand = [theme.color.brand.subtle, theme.color.brand.base, theme.color.brand.strong];
    for (const colour of presence) expect(brand).not.toContain(colour);
    expect(presence).not.toContain(root['--forest-700']);
    expect(presence).not.toContain(root['--forest-500']);
  });

  const light = Object.fromEntries(declarations(/:root/));
  const dark = { ...light, ...Object.fromEntries(declarations(/\[data-theme="dark"\]/)) };
  const names = [1, 2, 3, 4, 5, 6].map((n) => `--presence-${String(n)}`);

  it('SHARE-04 A11Y-03 the dark theme overrides every presence colour (#132), the same six in theme.ts, none the brand colour', () => {
    const darkOnly = Object.fromEntries(declarations(/\[data-theme="dark"\]/));
    const swapped = names.map((n) => darkOnly[n]);
    expect(swapped.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(new Set(swapped).size).toBe(6);
    expect(swapped).toEqual([...theme.color.presenceDark]);
    for (const colour of swapped) {
      expect(colour).not.toBe(dark['--action-primary-bg']);
      expect(colour).not.toBe(light['--forest-700']);
      expect(colour).not.toBe(light['--forest-300']);
    }
    expect(resolved(light, '--presence-ink')).toBe(theme.color.presenceInk.light);
    expect(resolved(dark, '--presence-ink')).toBe(theme.color.presenceInk.dark);
  });

  const surfaces = ['--surface', '--surface-sunken'] as const;
  /** Every presence colour on both surfaces, and --presence-ink on the colour, to 2 dp. */
  const ratio = (block: Record<string, string>, a: string, b: string) =>
    Number(contrast(resolved(block, a), resolved(block, b)).toFixed(2));
  const table = (
    block: Record<string, string>,
  ): Record<string, Record<(typeof surfaces)[number] | 'ink', number>> =>
    Object.fromEntries(
      names.map((n) => [
        n,
        {
          '--surface': ratio(block, n, '--surface'),
          '--surface-sunken': ratio(block, n, '--surface-sunken'),
          ink: ratio(block, n, '--presence-ink'),
        },
      ]),
    );

  it('A11Y-03 every presence colour is at least 3:1 on --surface and --surface-sunken in both themes; --presence-ink reads at 4.5:1 on each (#132)', () => {
    const l = table(light);
    const d = table(dark);
    // Recorded ratios (DESIGN-SYSTEM §2: "token table records every ratio").
    expect(l).toEqual({
      '--presence-1': { '--surface': 16.78, '--surface-sunken': 15.87, ink: 16.78 },
      '--presence-2': { '--surface': 7.27, '--surface-sunken': 6.87, ink: 7.27 },
      '--presence-3': { '--surface': 7.1, '--surface-sunken': 6.72, ink: 7.1 },
      '--presence-4': { '--surface': 5.02, '--surface-sunken': 4.75, ink: 5.02 },
      '--presence-5': { '--surface': 5.47, '--surface-sunken': 5.18, ink: 5.47 },
      '--presence-6': { '--surface': 7.88, '--surface-sunken': 7.46, ink: 7.88 },
    });
    expect(d).toEqual({
      '--presence-1': { '--surface': 9.91, '--surface-sunken': 10.56, ink: 9.91 },
      '--presence-2': { '--surface': 9.26, '--surface-sunken': 9.88, ink: 9.26 },
      '--presence-3': { '--surface': 7.26, '--surface-sunken': 7.74, ink: 7.26 },
      '--presence-4': { '--surface': 7.89, '--surface-sunken': 8.41, ink: 7.89 },
      '--presence-5': { '--surface': 8.13, '--surface-sunken': 8.67, ink: 8.13 },
      '--presence-6': { '--surface': 6.98, '--surface-sunken': 7.44, ink: 6.98 },
    });
    for (const block of [l, d])
      for (const n of names) {
        for (const s of surfaces) expect(block[n]![s]).toBeGreaterThanOrEqual(3);
        expect(block[n]!.ink).toBeGreaterThanOrEqual(4.5);
      }
  });

  it('FX-08 the operand outlines 2–6 follow the presence tokens by reference, so the dark swap carries them', () => {
    for (const [ref, presence] of [
      [2, 2],
      [3, 3],
      [4, 5],
      [5, 6],
      [6, 1],
    ] as const) {
      expect(light[`--reference-${String(ref)}`]).toBe(`var(--presence-${String(presence)})`);
      expect(Object.fromEntries(declarations(/\[data-theme="dark"\]/))).not.toHaveProperty(
        `--reference-${String(ref)}`,
      );
    }
  });
});

/** WCAG 2.1 relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve `var(--x)` one level (the primitives are literal in the same block). */
function resolved(block: Record<string, string>, name: string): string {
  const value = block[name];
  if (value === undefined) throw new Error(`no ${name}`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  return ref === null ? value : resolved(block, ref[1]!);
}

describe('A11Y-03 boundary contrast (#81)', () => {
  const light = Object.fromEntries(declarations(/:root/));
  const dark = { ...light, ...Object.fromEntries(declarations(/\[data-theme="dark"\]/)) };
  const surfaces = ['--surface', '--surface-sunken'] as const;

  /** Every `--border*` pair, recorded; only `--border-strong` carries the non-text floor. */
  const table = (block: Record<string, string>) =>
    Object.fromEntries(
      ['--border', '--border-strong'].map((token) => [
        token,
        Object.fromEntries(
          surfaces.map((s) => [
            s,
            Number(contrast(resolved(block, token), resolved(block, s)).toFixed(2)),
          ]),
        ),
      ]),
    );

  it('A11Y-03 --border-strong is at least 3:1 on --surface and --surface-sunken in both themes; theme.ts carries the same value', () => {
    const l = table(light);
    const d = table(dark);
    // Recorded ratios (DESIGN-SYSTEM §5: "token table records every ratio").
    expect(l['--border-strong']).toEqual({ '--surface': 4.22, '--surface-sunken': 3.99 });
    expect(d['--border-strong']).toEqual({ '--surface': 3.47, '--surface-sunken': 3.7 });
    for (const block of [l, d])
      for (const s of surfaces) expect(block['--border-strong']![s]).toBeGreaterThanOrEqual(3);
    // --border stays the decorative hairline: below the floor by design, so nothing may use
    // it as a control's only boundary (#81).
    expect(l['--border']!['--surface']).toBeLessThan(3);
    expect(d['--border']!['--surface']).toBeLessThan(3);
    expect(theme.color.surface.borderStrong).toBe(resolved(light, '--border-strong'));
  });
});
