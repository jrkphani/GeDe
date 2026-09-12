import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from './Badge.js';

describe('Badge', () => {
  it('A11Y-04 carries its meaning in text; the tone is a class on top', () => {
    render(<Badge tone="live">Draft</Badge>);
    const badge = screen.getByText('Draft');
    expect(badge).toHaveClass('gd-badge', 'gd-badge--live');
  });
});
