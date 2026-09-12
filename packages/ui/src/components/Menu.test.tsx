import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';
import { Menu } from './Menu.js';

describe('Menu', () => {
  it('opens on the trigger, shows disabled items with a reason, shortcuts in mono, closes on Escape', async () => {
    const onCopy = vi.fn();
    render(
      <Menu
        trigger={<Button>Column</Button>}
        entries={[
          { kind: 'item', id: 'copy', label: 'Copy', onSelect: onCopy, shortcut: '⌘C' },
          { kind: 'separator', id: 's1' },
          {
            kind: 'check',
            id: 'freeze',
            label: 'Freeze header columns',
            checked: true,
            onCheckedChange: () => undefined,
          },
          {
            kind: 'item',
            id: 'magic',
            label: 'Magic fill',
            onSelect: () => undefined,
            disabledReason: 'Select a column with text first',
          },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Column' });
    await userEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Copy/ })).toHaveTextContent('⌘C');
    expect(screen.getByRole('menuitemcheckbox', { name: /Freeze/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const magic = screen.getByRole('menuitem', { name: /Magic fill/ });
    expect(magic).toHaveAttribute('aria-disabled', 'true');
    expect(magic).toHaveAttribute('title', 'Select a column with text first');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('is keyboard operable: ArrowDown opens, Enter selects', async () => {
    const onCopy = vi.fn();
    render(
      <Menu
        trigger={<Button>Column</Button>}
        entries={[{ kind: 'item', id: 'copy', label: 'Copy', onSelect: onCopy }]}
      />,
    );
    await userEvent.tab();
    await userEvent.keyboard('{ArrowDown}');
    await screen.findByRole('menu');
    await userEvent.keyboard('{Enter}');
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});
