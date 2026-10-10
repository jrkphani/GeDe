import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('SET-01 I18N-01 Enter while an IME composes, or as keyCode 229, does not confirm', () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    const plain = screen.getByRole('radio', { name: 'Plain table' });
    fireEvent.keyDown(plain, { code: 'Enter', key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(plain, { code: 'Enter', key: 'Enter', isComposing: true });
    expect(onEnter).not.toHaveBeenCalled();
    fireEvent.keyDown(plain, { code: 'Enter', key: 'Enter', keyCode: 13 });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('SET-09 A11Y-01 a group under a visible heading takes its name from it, once', () => {
    render(
      <>
        <p id="shape-heading">Each tuple goes in</p>
        <RadioCards<'a' | 'b'>
          labelledBy="shape-heading"
          value="a"
          onChange={vi.fn()}
          options={[
            { value: 'a', label: 'One column' },
            { value: 'b', label: 'One column per set' },
          ]}
        />
      </>,
    );
    const group = screen.getByRole('radiogroup', { name: 'Each tuple goes in' });
    expect(group).not.toHaveAttribute('aria-label');
  });
});
