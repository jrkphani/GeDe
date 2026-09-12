import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppleSignInButton } from './AppleSignInButton.js';

describe('AppleSignInButton', () => {
  it('AUTH-08 (button only) uses approved wording, the Apple glyph and is keyboard reachable', async () => {
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

  it('AUTH-08 (button only) the height never drops below the 44 px target token, whatever the root font size', () => {
    const css = readFileSync(resolve(__dirname, 'AppleSignInButton.css'), 'utf8');
    expect(css).toMatch(/--gd-apple-height:\s*max\(2\.75rem, var\(--hit-target\)\)/);
    expect(css).toMatch(/min-height:\s*var\(--gd-apple-height\)/);
    const tokens = readFileSync(resolve(__dirname, '../../../tokens/src/tokens.css'), 'utf8');
    expect(tokens).toMatch(/--hit-target:\s*44px/);
  });

  it('accepts only the second approved wording', () => {
    render(<AppleSignInButton wording="Continue with Apple" />);
    expect(screen.getByRole('button', { name: 'Continue with Apple' })).toBeInTheDocument();
  });
});
