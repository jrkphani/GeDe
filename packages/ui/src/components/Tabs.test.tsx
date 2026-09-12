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

  it('DOC-03 a tab without content still controls a real, hidden panel, so aria-controls resolves (WCAG 4.1.2)', () => {
    render(
      <Tabs<Pane>
        label="Sheets"
        value="table"
        onChange={() => undefined}
        items={[
          { value: 'table', label: '1° Sheet 1' },
          { value: 'cell', label: '2° Sheet 2' },
        ]}
      />,
    );
    const active = screen.getByRole('tab', { name: '1° Sheet 1' });
    const panelId = active.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId ?? '');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveClass('gd-tabs__panel--empty');
    expect(panel?.tabIndex).toBe(-1); // not a tab stop: there is nothing in it
    expect(panel).toBeEmptyDOMElement();
  });
});

describe('Tabs without panes', () => {
  it('A11Y-04 a tab with no content still owns a (hidden) panel so its aria-controls resolves', () => {
    render(
      <Tabs
        label="Sheets"
        value="s1"
        onChange={() => undefined}
        items={[
          { value: 's1', label: 'Trek' },
          { value: 's2', label: 'Budget' },
        ]}
      />,
    );
    for (const tab of screen.getAllByRole('tab')) {
      const controls = tab.getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      const panel = document.getElementById(controls ?? '');
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute('hidden');
    }
  });
});
