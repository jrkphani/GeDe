import { render, screen } from '@testing-library/react';
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
  it('AUTH-02 renders a Radix toggle group with exactly one segment on', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveAttribute('data-state', 'on');
    expect(screen.getByRole('radio', { name: 'Create account' })).toHaveAttribute(
      'data-state',
      'off',
    );
  });

  it('switches by click and by arrow keys; clicking the active segment never empties the selection', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('radio', { name: 'Create account' }));
    expect(screen.getByRole('radio', { name: 'Create account' })).toHaveAttribute(
      'data-state',
      'on',
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Create account' }));
    expect(screen.getByRole('radio', { name: 'Create account' })).toHaveAttribute(
      'data-state',
      'on',
    );
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveFocus();
  });
});
