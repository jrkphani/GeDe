import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button.js';
import { Collapsible } from './Collapsible.js';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} trigger={<Button>Views</Button>}>
      <p>Recents</p>
    </Collapsible>
  );
}

describe('Collapsible', () => {
  it('LIB-10 the trigger announces expanded state and the content is absent while closed', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Views' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Recents')).not.toBeInTheDocument();
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Recents')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByText('Recents')).not.toBeInTheDocument();
  });
});
