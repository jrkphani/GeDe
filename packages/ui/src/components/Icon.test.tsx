import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon } from './Icon.js';

describe('Icon', () => {
  it('defines the 30 catalogue glyphs plus more, passkey, apple, the find set, the sort arrows, the keyboard glyph, archive and the rule flag', () => {
    expect(ICON_NAMES).toHaveLength(45);
    expect(ICON_NAMES).toContain('archive');
    expect(ICON_NAMES).toContain('rule'); // INSP-05: the cue beside a matched rule's fill (A11Y-04)
    expect(ICON_NAMES).toContain('chevron-down');
    expect(ICON_NAMES).toContain('check');
    expect(ICON_NAMES).toContain('keyboard');
    expect(ICON_NAMES).toContain('search');
    expect(ICON_NAMES).toContain('settings');
    expect(ICON_NAMES).toContain('draft');
    expect(ICON_NAMES).toContain('more');
    expect(ICON_NAMES).toContain('apple');
  });

  it.each(ICON_NAMES)('renders %s on the 18-grid with currentColor and round caps', (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('stroke-linecap', 'round');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg?.querySelectorAll('path, circle').length).toBeGreaterThan(0);
    if (name !== 'apple') {
      expect(svg).toHaveAttribute('viewBox', '0 0 18 18');
      expect(svg).toHaveAttribute('stroke-width', '1.3');
    }
  });

  it('A11Y-04 draft is dashed, not only hollow', () => {
    const { container } = render(<Icon name="draft" />);
    expect(container.querySelector('path')).toHaveAttribute('stroke-dasharray');
  });

  it('supports the three sizes and an accessible label', () => {
    const { container } = render(<Icon name="table" size={18} label="Table" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '18');
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAttribute('aria-label', 'Table');
  });
});
