import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Switch } from './Switch.js';

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [on, setOn] = useState(false);
  return <Switch label="Gridlines" checked={on} onCheckedChange={setOn} disabled={disabled} />;
}

describe('Switch', () => {
  it('is a labelled switch toggled by click and Space', async () => {
    render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Gridlines' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.tab();
    await userEvent.tab({ shift: true });
    expect(sw).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('disabled switch is not toggled', async () => {
    render(<Harness disabled />);
    const sw = screen.getByRole('switch');
    expect(sw).toBeDisabled();
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});
