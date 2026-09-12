import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';

describe('Button stylesheet', () => {
  const css = readFileSync(resolve(__dirname, 'Button.css'), 'utf8');
  const block = (selector: string) =>
    new RegExp(`${selector.replace(/[.()]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('DS §3 icon-only buttons have a hit area of at least 32 px at every size, whatever the glyph', () => {
    // 2rem = 32 px at the 100 % root; md and lg keep their own larger floors.
    expect(block('.gd-btn--icon-only.gd-btn--sm')).toMatch(/min-width:\s*2rem/);
    expect(block('.gd-btn--icon-only.gd-btn--sm')).toMatch(/min-height:\s*2rem/);
    expect(block('.gd-btn--icon-only.gd-btn--md')).toMatch(/min-width:\s*2\.25rem/);
    expect(block('.gd-btn--icon-only.gd-btn--lg')).toMatch(/min-width:\s*2\.75rem/);
  });

  it('RESP-05 below 1024 px icon-only buttons take the 44 px token in both axes', () => {
    const narrow = /@media \(max-width: 1023\.98px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(
      /\.gd-btn--icon-only\s*\{[^}]*min-width:\s*var\(--hit-target\);[^}]*min-height:\s*var\(--hit-target\)/,
    );
  });

  it('pressed and ghost tints derive from semantic tokens so they hold on the dark theme', () => {
    expect(css).not.toMatch(/--gd-btn-bg:\s*var\(--(slate-200|forest-50|forest-100)\)/);
    expect(block('.gd-btn--ghost:hover:not(:disabled)')).toMatch(
      /color-mix\(in srgb, var\(--link\) \d+%, var\(--surface\)\)/,
    );
  });
});

describe('Button', () => {
  it('renders a real button with the label and variant/size classes', () => {
    render(
      <Button variant="primary" size="lg">
        Share
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Share' });
    expect(b).toHaveAttribute('type', 'button');
    expect(b).toHaveClass('gd-btn--primary', 'gd-btn--lg');
  });

  it('is keyboard reachable and activates on Enter and Space', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Invite</Button>);
    await userEvent.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('LOAD-04 loading keeps the resting label in the DOM, swaps to the participle, sets aria-busy and a status spinner', () => {
    render(
      <Button loading loadingLabel="Inviting…">
        Invite
      </Button>,
    );
    const b = screen.getByRole('button');
    expect(b).toHaveAttribute('aria-busy', 'true');
    expect(b).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Inviting…');
    // width is reserved by the hidden resting label
    expect(b.querySelector('.gd-btn__body')).toHaveTextContent('Invite');
  });

  it('disabled is not-clickable and not tab-reachable', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Delete
      </Button>,
    );
    await userEvent.tab();
    expect(screen.getByRole('button')).not.toHaveFocus();
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
