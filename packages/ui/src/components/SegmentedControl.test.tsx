import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SegmentedControl } from './SegmentedControl.js';

type Mode = 'sign-in' | 'sign-up';

function Harness() {
  const [mode, setMode] = useState<Mode>('sign-in');
  return (
    <SegmentedControl<Mode>
      label="Mode"
      value={mode}
      onChange={setMode}
      options={[
        { value: 'sign-in', label: 'Sign in' },
        { value: 'sign-up', label: 'Create account' },
      ]}
    />
  );
}

describe('SegmentedControl', () => {
  it('AUTH-02 renders a Radix radio group with exactly one segment checked', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Sign in' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Create account' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveAttribute('data-state', 'checked');
  });

  it('AUTH-02 A11Y-01 follows the ARIA radio pattern: Tab lands on the checked segment, arrows move the selection and keep focus, clicking the checked segment never empties it (#144)', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    await u.tab();
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveFocus();
    // Radix moves roving focus on a timer (a Safari fix) and checks the item that gains
    // focus while the arrow is still down, so the key is held across the wait as a finger
    // would be; user-event's instantaneous press-and-release would beat the timer.
    await u.keyboard('{ArrowRight>}');
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Create account' })).toBeChecked();
    });
    await u.keyboard('{/ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Create account' })).toHaveFocus();
    await u.keyboard('{ArrowLeft>}');
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Sign in' })).toBeChecked();
    });
    await u.keyboard('{/ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveFocus();
    await u.click(screen.getByRole('radio', { name: 'Create account' }));
    expect(screen.getByRole('radio', { name: 'Create account' })).toBeChecked();
    await u.click(screen.getByRole('radio', { name: 'Create account' }));
    expect(screen.getByRole('radio', { name: 'Create account' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Create account' })).toHaveFocus();
  });
});
