import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button.js';
import { Dialog, DialogClose } from './Dialog.js';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Delete Work-Force?"
      description="Anything deleted can be recovered for 30 days."
      trigger={<Button>Delete</Button>}
      actions={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="danger">Delete</Button>
        </>
      }
    />
  );
}

describe('Dialog', () => {
  it('opens from the trigger, traps focus, closes on Escape and returns focus', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Delete' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Delete Work-Force?' });
    expect(dialog).toHaveAccessibleDescription('Anything deleted can be recovered for 30 days.');
    // focus is inside the dialog
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('MENU-05 returnFocusTo sends focus to the named element when the opener is gone', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
      return (
        <>
          <button type="button" ref={setAnchor}>
            Row
          </button>
          <Dialog open={open} onOpenChange={setOpen} title="Participants" returnFocusTo={anchor} />
        </>
      );
    }
    render(<Harness />);
    await screen.findByRole('dialog', { name: 'Participants' });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Row' })).toHaveFocus();
  });

  it('LIB-07 the sheet variant is the same dialog on an edge panel', () => {
    render(
      <Dialog open onOpenChange={() => undefined} title="Participants" variant="sheet">
        <p>Meenarapan D</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Participants' });
    expect(dialog).toHaveClass('gd-dialog--sheet');
    expect(dialog).toHaveAttribute('data-variant', 'sheet');
  });
});
