import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';
import { Toast, ToastProvider } from './Toast.js';

function Harness({ onUndo }: { onUndo: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <ToastProvider>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Delete row
      </Button>
      <Toast open={open} onOpenChange={setOpen} title="Row 14 deleted" undo={{ onUndo }} />
    </ToastProvider>
  );
}

describe('Toast', () => {
  it('announces the title and exposes an Undo action', async () => {
    const onUndo = vi.fn();
    render(<Harness onUndo={onUndo} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    expect(await screen.findByText('Row 14 deleted')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
