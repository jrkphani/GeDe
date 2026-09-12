import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark, Wordmark } from './BrandMark.js';

describe('BrandMark', () => {
  it('draws frame, gridlines and node at 36px', () => {
    const { container } = render(<BrandMark label="GeDe" />);
    expect(screen.getByRole('img', { name: 'GeDe' })).toBeInTheDocument();
    expect(container.querySelector('rect')).toHaveAttribute('rx', '4');
    expect(container.querySelector('path')).not.toBeNull();
    expect(container.querySelector('circle')).toHaveAttribute('r', '5');
  });

  it('drops gridlines below 32px and simplifies below 20px', () => {
    const a = render(<BrandMark size={24} />).container;
    expect(a.querySelector('path')).toBeNull();
    const b = render(<BrandMark size={16} />).container;
    expect(b.querySelector('rect')).toHaveAttribute('stroke-width', '3');
    expect(b.querySelector('circle')).toHaveAttribute('r', '7');
  });

  it('Wordmark locks up the mark with the name', () => {
    render(<Wordmark />);
    expect(screen.getByText('GeDe')).toHaveClass('gd-wordmark__text');
  });
});
