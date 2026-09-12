import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Select } from './Select.js';

type Permission = 'edit' | 'view';

const OPTIONS = [
  { value: 'edit', label: 'Can make changes' },
  { value: 'view', label: 'View only' },
] as const;

function Harness({
  disabled = false,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (v: Permission) => void;
}) {
  const [value, setValue] = useState<Permission>('edit');
  return (
    <Select
      label="Permission"
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      options={OPTIONS}
      disabled={disabled}
    />
  );
}

describe('Select', () => {
  it('SHARE-01 is a labelled combobox on Radix Select that shows the chosen option and changes it by keyboard', async () => {
    const chosen: Permission[] = [];
    render(
      <Harness
        onChange={(v) => {
          chosen.push(v);
        }}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Permission' });
    expect(trigger).toHaveTextContent('Can make changes');
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Can make changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(chosen).toEqual(['view']);
    expect(trigger).toHaveTextContent('View only');
    // Focus returns to the trigger once the list closes.
    expect(trigger).toHaveFocus();
  });

  it('SHARE-01 Escape closes without choosing; a disabled select does not open', async () => {
    const chosen: Permission[] = [];
    const { unmount } = render(
      <Harness
        onChange={(v) => {
          chosen.push(v);
        }}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Permission' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(chosen).toEqual([]);
    unmount();

    render(<Harness disabled />);
    const off = screen.getByRole('combobox', { name: 'Permission' });
    expect(off).toBeDisabled();
    await userEvent.click(off);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('SHARE-01 hideLabel keeps the name for assistive technology; aria-label overrides it', () => {
    render(
      <Select
        label="Permission"
        hideLabel
        aria-label="Permission for Meena"
        value="view"
        onValueChange={() => undefined}
        options={OPTIONS}
        size="sm"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Permission for Meena' })).toBeInTheDocument();
    expect(screen.getByText('Permission')).toHaveClass('gd-visually-hidden');
  });
});
