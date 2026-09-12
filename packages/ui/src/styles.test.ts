import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');

describe('global styles', () => {
  it('A11Y-02 focus ring is not removed: 2px amber outline at 2px offset on :focus-visible', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px/);
    expect(css).not.toMatch(/outline:\s*none/);
  });

  it('I18N-03 the Indic 1.7 line-height is a floor on every element in the language, not a root value body can override', () => {
    // `:lang()` matches every descendant that inherits the language; `[lang^=]` only the root.
    const rule =
      /:lang\(ta\),\s*:lang\(hi\),\s*:lang\(te\)\s*\{\s*line-height:\s*1\.7 !important;\s*\}/;
    expect(css).toMatch(rule);
    // Declared after the component sheets and after `body`, so it is last in the cascade too.
    const at = css.search(rule);
    expect(at).toBeGreaterThan(css.lastIndexOf('@import'));
    expect(at).toBeGreaterThan(css.search(/body\s*\{/));
  });

  it('imports the token sheet exactly once and sets base typography from tokens', () => {
    expect(css.match(/@import '@gede\/tokens\/tokens\.css'/g)).toHaveLength(1);
    expect(css).toMatch(/body\s*\{[^}]*font:\s*400 0\.9375rem\/1\.6 var\(--font-ui\)/);
  });

  it('AUTH-08 (button only) RESP-05 the root font size stays at 100 % so 2.75rem is 44 px, not 41.25', () => {
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*100%/);
    expect(css).not.toMatch(/html\s*\{[^}]*font:\s*400 0\.9375rem/);
  });
});
