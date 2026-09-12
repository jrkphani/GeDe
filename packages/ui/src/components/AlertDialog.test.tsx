import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AlertDialog } from './AlertDialog.js';
import { Button } from './Button.js';

function Harness({ onAction }: { onAction: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Delete All
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={setOpen}
        title="Permanently delete 2 workscapes?"
        description="Everything in Recently Deleted is removed for good. This cannot be undone."
        actionLabel="Delete All"
        onAction={onAction}
      />
    </>
  );
}

describe('AlertDialog', () => {
  it('LIB-D8 is an alertdialog that states the consequence, starts on Cancel, traps focus, and runs the action from its verb', async () => {
    const onAction = vi.fn();
    const u = userEvent.setup();
    render(<Harness onAction={onAction} />);
    const opener = screen.getByRole('button', { name: 'Delete All' });
    await u.click(opener);
    const dialog = screen.getByRole('alertdialog', { name: 'Permanently delete 2 workscapes?' });
    expect(dialog).toHaveAccessibleDescription(
      'Everything in Recently Deleted is removed for good. This cannot be undone.',
    );
    // The destructive verb is never the default: focus starts on Cancel.
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    await u.tab();
    await u.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const confirm = screen
      .getAllByRole('button', { name: 'Delete All' })
      .find((b) => dialog.contains(b));
    expect(confirm).toHaveClass('gd-btn--danger');
    await u.click(confirm!);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('LIB-D8 Escape and Cancel close without acting; clicking outside does not dismiss', async () => {
    const onAction = vi.fn();
    const u = userEvent.setup();
    render(<Harness onAction={onAction} />);
    await u.click(screen.getByRole('button', { name: 'Delete All' }));
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Delete All' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    // A pointer down outside the dialog (Radix listens for it on the document).
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('MENU-05 returnFocusTo sends focus to the named element on close', async () => {
    function Anchored() {
      const [open, setOpen] = useState(true);
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
      return (
        <>
          <button type="button" ref={setAnchor}>
            Row
          </button>
          <AlertDialog
            open={open}
            onOpenChange={setOpen}
            title="Permanently delete 1 workscape?"
            description="This cannot be undone."
            actionLabel="Delete All"
            onAction={() => undefined}
            returnFocusTo={anchor}
          />
        </>
      );
    }
    render(<Anchored />);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Row' })).toHaveFocus();
  });
});
