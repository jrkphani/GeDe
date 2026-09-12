import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';
import { Toast, ToastProvider, TOAST_DURATION_MS } from './Toast.js';

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

describe('Toast placement and dwell (DS §4, #143)', () => {
  const css = readFileSync(resolve(__dirname, 'Toast.css'), 'utf8');

  it('LIB-D9 the viewport is bottom-centred one lattice row up, and a toast dwells about seven seconds', () => {
    const viewport = /\.gd-toast__viewport \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(viewport).toMatch(/bottom: var\(--lattice-row\);/);
    expect(viewport).toMatch(/left: 50%;/);
    expect(viewport).toMatch(/transform: translateX\(-50%\);/);
    expect(TOAST_DURATION_MS).toBe(7000);
  });
});
