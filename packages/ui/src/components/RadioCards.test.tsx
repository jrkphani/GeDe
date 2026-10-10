import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RadioCards } from './RadioCards.js';

type Kind = 'plain' | 'simple' | 'product';

function Harness({ onEnter }: { onEnter: () => void }) {
  const [kind, setKind] = useState<Kind>('plain');
  return (
    <RadioCards<Kind>
      label="Table kind"
      value={kind}
      onChange={setKind}
      onEnter={onEnter}
      options={[
        { value: 'simple', label: 'Simple set', glyph: '{ a, b }', description: 'A range.' },
        { value: 'product', label: 'Cartesian product', glyph: 'A × B' },
        { value: 'plain', label: 'Plain table' },
      ]}
    />
  );
}

describe('RadioCards', () => {
  it('SET-01 A11Y-01 a Radix radio group: Tab lands on the preselected card, arrows move the selection, Enter confirms', async () => {
    const u = userEvent.setup();
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    expect(screen.getByRole('radiogroup', { name: 'Table kind' })).toBeInTheDocument();
    // The glyph is decorative: the radio is named by its label and sentence only.
    expect(screen.getByRole('radio', { name: /^Simple set/ })).toHaveAccessibleName(
      'Simple set A range.',
    );
    await u.tab();
    expect(screen.getByRole('radio', { name: 'Plain table' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Plain table' })).toBeChecked();
    await u.keyboard('{Enter}');
    expect(onEnter).toHaveBeenCalledTimes(1);
    await u.keyboard('{ArrowUp>}');
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Cartesian product' })).toBeChecked();
    });
    await u.keyboard('{/ArrowUp}');
    expect(screen.getByRole('radio', { name: 'Cartesian product' })).toHaveAttribute(
      'data-state',
      'checked',
    );
  });
});
