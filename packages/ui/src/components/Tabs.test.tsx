import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Tabs } from './Tabs.js';

type Pane = 'table' | 'cell';

function Harness() {
  const [v, setV] = useState<Pane>('table');
  return (
    <Tabs<Pane>
      label="Inspector"
      value={v}
      onChange={setV}
      items={[
        { value: 'table', label: 'Table', content: <p>Table pane</p> },
        { value: 'cell', label: 'Cell', content: <p>Cell pane</p> },
      ]}
    />
  );
}

describe('Tabs', () => {
  it('renders a tablist and switches panes with arrow keys', async () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Inspector' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Table pane')).toBeVisible();
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Cell' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Cell pane')).toBeVisible();
  });
});
