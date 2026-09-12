import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';

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
