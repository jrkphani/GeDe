import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { Popover } from './Popover.js';

function Host() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        aria-label="Editor"
        onChange={(e) => {
          setOpen(e.target.value.includes('@'));
        }}
      />
      <Popover open={open} onOpenChange={setOpen} anchor={ref.current} label="Entities">
        <div role="listbox" aria-label="Entities">
          <div role="option" aria-selected="true">
            @Table.Row
          </div>
        </div>
      </Popover>
    </>
  );
}

describe('Popover', () => {
  it('FX-04 (partial: primitive only) opens anchored to an editor without taking its focus, and Escape closes it', async () => {
    render(<Host />);
    const editor = screen.getByLabelText('Editor');
    await userEvent.click(editor);
    await userEvent.type(editor, '=@');
    expect(await screen.findByRole('listbox', { name: 'Entities' })).toBeInTheDocument();
    expect(editor).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
  });

  it('opens from a trigger and reports open changes', async () => {
    const onOpenChange = vi.fn();
    function Triggered() {
      const [open, setOpen] = useState(false);
      return (
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            onOpenChange(o);
          }}
          keepFocus={false}
          trigger={<button type="button">Forms</button>}
        >
          <p>Concat, Sum, list</p>
        </Popover>
      );
    }
    render(<Triggered />);
    await userEvent.click(screen.getByRole('button', { name: 'Forms' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(await screen.findByText('Concat, Sum, list')).toBeInTheDocument();
  });

  it('MENU-05 with keepFocus off: focus moves to the first control on open, Tab reaches the rest, Escape closes and returns focus to `returnFocusTo`', async () => {
    function Panel() {
      const [open, setOpen] = useState(false);
      const home = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button type="button" ref={home}>
            Home
          </button>
          <Popover
            open={open}
            onOpenChange={setOpen}
            label="Filter Country"
            keepFocus={false}
            returnFocusTo={home.current}
            trigger={<button type="button">Filter</button>}
          >
            <label>
              Contains <input />
            </label>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
              }}
            >
              Apply
            </button>
          </Popover>
        </>
      );
    }
    render(<Panel />);
    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(await screen.findByRole('dialog', { name: 'Filter Country' })).toBeInTheDocument();
    expect(screen.getByLabelText('Contains')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toHaveFocus();
  });
});
