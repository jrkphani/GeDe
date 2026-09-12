import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
