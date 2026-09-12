import { describe, expect, it } from 'vitest';
import { formatFindings, isTestFile, scanSource, stripComments } from './check-literals.js';

describe('check-literals scanSource', () => {
  it('flags a literal hex colour in CSS', () => {
    const f = scanSource('.a { color: #14532d; }', '.css');
    expect(f).toEqual([{ file: '<memory>', line: 1, kind: 'hex-colour', text: '#14532d' }]);
  });

  it('flags 3-, 4-, 6- and 8-digit hex and is case-insensitive', () => {
    const f = scanSource('a{color:#FFF;b:#abcd;c:#ABCDEF;d:#12345678}', '.css');
    expect(f.map((x) => x.text)).toEqual(['#FFF', '#abcd', '#ABCDEF', '#12345678']);
  });

  it('ignores hex inside block comments and line comments', () => {
    const src = `/* was #ffffff */\nconst a = 1; // #14532d\nconst url = 'https://x.y/#abc';`;
    const f = scanSource(src, '.ts');
    // Only the URL fragment survives comment stripping; it is not a comment.
    expect(f).toEqual([{ file: '<memory>', line: 3, kind: 'hex-colour', text: '#abc' }]);
  });

  it('does not treat a URL `//` as a comment', () => {
    expect(stripComments("x = 'https://a.b' // #fff", '.ts')).toBe("x = 'https://a.b'        ");
  });

  it('flags px radii only inside border-radius declarations', () => {
    const f = scanSource('.a{border-radius:6px;width:6px}.b{border-radius: 0 4px 0 0}', '.css');
    expect(f.map((x) => x.kind)).toEqual(['px-radius', 'px-radius']);
  });

  it('accepts border-radius via tokens', () => {
    expect(scanSource('.a{border-radius:var(--radius-md)}', '.css')).toEqual([]);
  });

  it('flags ms durations in CSS and TS', () => {
    expect(scanSource('.a{transition:opacity 120ms}', '.css')[0]?.kind).toBe('ms-duration');
    expect(scanSource("const d = '200ms';", '.ts')[0]?.kind).toBe('ms-duration');
  });

  it('accepts durations via tokens and numeric constants', () => {
    expect(scanSource('.a{transition:opacity var(--dur-fast)}', '.css')).toEqual([]);
    expect(scanSource('setTimeout(f, 200)', '.ts')).toEqual([]);
  });

  it('reports the right line number after multi-line comments', () => {
    const src = `/*\n * long\n */\nconst c = '#000';`;
    expect(scanSource(src, '.ts')[0]?.line).toBe(4);
  });

  it('honours the literal-ok marker on a line', () => {
    expect(scanSource("const c = '#000'; // literal-ok", '.ts')).toEqual([]);
  });

  it('does not flag hash ids that are not hex', () => {
    expect(scanSource('#root { margin: 0 }', '.css')).toEqual([]);
  });
});

describe('check-literals helpers', () => {
  it('recognises test files', () => {
    expect(isTestFile('Button.test.tsx')).toBe(true);
    expect(isTestFile('smoke.spec.ts')).toBe(true);
    expect(isTestFile('Button.tsx')).toBe(false);
  });

  it('formats findings one per line', () => {
    const out = formatFindings([{ file: 'a.css', line: 3, kind: 'hex-colour', text: '#fff' }]);
    expect(out).toBe('a.css:3  hex-colour  #fff');
  });
});
