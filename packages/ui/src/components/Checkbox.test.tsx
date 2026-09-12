import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Checkbox } from './Checkbox.js';

function Harness() {
  const [c, setC] = useState<boolean | 'indeterminate'>(false);
  return <Checkbox label="Include documents" checked={c} onCheckedChange={setC} />;
}

describe('Checkbox', () => {
  it('is a labelled checkbox toggled by click and keyboard', async () => {
    render(<Harness />);
    const cb = screen.getByRole('checkbox', { name: 'Include documents' });
    expect(cb).not.toBeChecked();
    await userEvent.click(cb);
    expect(cb).toBeChecked();
    cb.focus();
    await userEvent.keyboard(' ');
    expect(cb).not.toBeChecked();
  });

  it('renders the indeterminate state', () => {
    render(<Checkbox label="All" checked="indeterminate" onCheckedChange={() => undefined} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'indeterminate');
  });
});
