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

  it('INSP-11 INSP-10 disabledReason disables the trigger and carries the reason on hover; hint sits beside the label without joining its name', async () => {
    render(
      <Select
        label="Format"
        hint="whole column"
        value="edit"
        onValueChange={() => undefined}
        options={OPTIONS}
        disabledReason="not implemented in this release"
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Format' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', 'not implemented in this release');
    expect(screen.getByText('whole column')).toBeInTheDocument();
    await userEvent.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

const REGIONS = [
  { value: 'nepal', label: 'Nepal' },
  { value: 'india', label: 'India' },
  { value: 'tibet', label: 'Tibet', disabled: true },
];

function Picker({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Select
        label="Region"
        value={value}
        onValueChange={setValue}
        options={REGIONS}
        placeholder="Pick a region"
        clearLabel="No region"
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe('Select as a picker (REF-03)', () => {
  it('REF-03 an empty value shows the placeholder; a keyboard pick fills it', async () => {
    render(<Picker />);
    const trigger = screen.getByRole('combobox', { name: 'Region' });
    expect(trigger).toHaveTextContent('Pick a region');
    await userEvent.tab();
    expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('listbox')).toBeVisible();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('value')).toHaveTextContent('india');
    expect(trigger).toHaveTextContent('India');
  });

  it('REF-03 a chosen value can be cleared through the clear item and the placeholder returns', async () => {
    render(<Picker initial="nepal" />);
    const trigger = screen.getByRole('combobox', { name: 'Region' });
    expect(trigger).toHaveTextContent('Nepal');
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: 'No region' }));
    expect(screen.getByTestId('value')).toHaveTextContent('');
    expect(trigger).toHaveTextContent('Pick a region');
  });

  it('REF-03 an empty option list shows the empty sentence', async () => {
    render(
      <Select
        label="Region"
        value=""
        onValueChange={() => undefined}
        options={[]}
        placeholder="Pick a region"
        emptyText="The target column has no values yet"
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Region' }));
    expect(await screen.findByRole('note')).toHaveTextContent(
      'The target column has no values yet',
    );
  });
});
