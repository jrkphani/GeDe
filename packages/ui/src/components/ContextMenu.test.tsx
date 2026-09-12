import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu, isContextMenuKey } from './ContextMenu.js';

function Fixture({ disabled = false, onCopy = () => undefined }) {
  return (
    <ContextMenu
      label="Cell menu"
      disabled={disabled}
      entries={[
        { kind: 'item', id: 'copy', label: 'Copy', onSelect: onCopy, shortcut: '⌘C' },
        { kind: 'separator', id: 's1' },
        {
          kind: 'item',
          id: 'magic',
          label: 'Magic fill',
          onSelect: () => undefined,
          disabledReason: 'not implemented in this release',
        },
      ]}
      trigger={
        <div data-testid="scope">
          <button type="button">B5</button>
        </div>
      }
    />
  );
}

describe('ContextMenu', () => {
  it('MENU-02 MENU-05 opens at the pointer on right-click, shows disabled items with a reason, Escape closes and focus returns to the element that had it', async () => {
    const onCopy = vi.fn();
    render(<Fixture onCopy={onCopy} />);
    const cell = screen.getByRole('button', { name: 'B5' });
    cell.focus();
    fireEvent.contextMenu(cell, { clientX: 40, clientY: 30 });
    const menu = await screen.findByRole('menu', { name: 'Cell menu' });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Copy/ })).toHaveTextContent('⌘C');
    const magic = screen.getByRole('menuitem', { name: /Magic fill/ });
    expect(magic).toHaveAttribute('aria-disabled', 'true');
    expect(magic).toHaveAttribute('title', 'not implemented in this release');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(cell).toHaveFocus();
  });

  it('KEYS Shift+F10 and the ContextMenu key open it from the keyboard, resolved by event.code', async () => {
    render(<Fixture />);
    const cell = screen.getByRole('button', { name: 'B5' });
    cell.focus();
    fireEvent.keyDown(cell, { code: 'F10', key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    fireEvent.keyDown(cell, { code: 'ContextMenu', key: 'ContextMenu' });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(isContextMenuKey({ code: 'F10', shiftKey: false })).toBe(false);
    expect(isContextMenuKey({ code: 'KeyF', shiftKey: true })).toBe(false);
  });

  it('MENU-05 a press outside the menu closes it even when the pressed content stops the event from bubbling (#131)', async () => {
    render(
      <ContextMenu
        label="Cell menu"
        entries={[{ kind: 'item', id: 'copy', label: 'Copy', onSelect: () => undefined }]}
        trigger={
          <div data-testid="scope">
            <button type="button">B5</button>
            {/* A graph object: its press must not pan the canvas, so it never bubbles. */}
            <div
              data-testid="graph"
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
            >
              Graph
            </div>
          </div>
        }
      />,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: 'B5' }), { clientX: 5, clientY: 5 });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId('graph'), { button: 0 });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    // A press inside the menu is the menu's own.
    fireEvent.contextMenu(screen.getByRole('button', { name: 'B5' }), { clientX: 5, clientY: 5 });
    const item = await screen.findByRole('menuitem', { name: 'Copy' });
    fireEvent.pointerDown(item, { button: 0 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('RESP-02 disabled: nothing opens on right-click or from the keyboard', () => {
    render(<Fixture disabled />);
    const cell = screen.getByRole('button', { name: 'B5' });
    fireEvent.contextMenu(cell, { clientX: 40, clientY: 30 });
    fireEvent.keyDown(cell, { code: 'F10', shiftKey: true });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('MENU-05 selecting an item runs it and closes the menu', async () => {
    const onCopy = vi.fn();
    render(<Fixture onCopy={onCopy} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'B5' }), { clientX: 5, clientY: 5 });
    await userEvent.click(await screen.findByRole('menuitem', { name: /Copy/ }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});
