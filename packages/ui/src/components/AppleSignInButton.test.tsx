import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppleSignInButton } from './AppleSignInButton.js';

describe('AppleSignInButton', () => {
  it('AUTH-08 uses approved wording, the Apple glyph and is keyboard reachable', async () => {
    const onClick = vi.fn();
    render(<AppleSignInButton onClick={onClick} />);
    const b = screen.getByRole('button', { name: 'Sign in with Apple' });
    expect(b).toHaveClass('gd-apple');
    expect(b.querySelector('svg[data-name="apple"]')).not.toBeNull();
    await userEvent.tab();
    expect(b).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalled();
  });

  it('accepts only the second approved wording', () => {
    render(<AppleSignInButton wording="Continue with Apple" />);
    expect(screen.getByRole('button', { name: 'Continue with Apple' })).toBeInTheDocument();
  });
});
