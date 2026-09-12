import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Tooltip, TooltipProvider } from './Tooltip.js';

describe('Tooltip', () => {
  it('shows on keyboard focus and names the icon-only button', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip content="Filter rows">
          <Button aria-label="Filter" icon={<Icon name="filter" />} />
        </Tooltip>
      </TooltipProvider>,
    );
    const b = screen.getByRole('button', { name: 'Filter' });
    await userEvent.tab();
    expect(b).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Filter rows');
  });
});
