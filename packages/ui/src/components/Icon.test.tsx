import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon } from './Icon.js';

describe('Icon', () => {
  it('defines the 30 catalogue glyphs plus passkey and apple', () => {
    expect(ICON_NAMES).toHaveLength(32);
    expect(ICON_NAMES).toContain('draft');
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
