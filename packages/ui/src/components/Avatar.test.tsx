import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, initialsOf } from './Avatar.js';

describe('Avatar', () => {
  it('derives initials from first and last word, one letter from an email', () => {
    expect(initialsOf('Meenarapan D')).toBe('MD');
    expect(initialsOf('Sembian')).toBe('S');
    expect(initialsOf('meena@1cloudhub.com')).toBe('M');
    expect(initialsOf('  ')).toBe('?');
  });

  it('names the person unless decorative', () => {
    render(<Avatar name="Meenarapan D" />);
    expect(screen.getByRole('img', { name: 'Meenarapan D' })).toHaveTextContent('MD');
    const { container } = render(<Avatar name="Sembian V" decorative size={24} />);
    expect(container.querySelector('.gd-avatar--24')).toHaveAttribute('aria-hidden', 'true');
  });
});
