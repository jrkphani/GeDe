import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button.js';
import { EmptyState } from './EmptyState.js';

describe('EmptyState', () => {
  it('renders the mono label, title, prose and one action', () => {
    render(
      <EmptyState
        label="recents"
        title="Create your first workscape"
        description="Tables, formulas and context graphs on one shared sheet."
        action={<Button variant="primary">Create workscape</Button>}
      />,
    );
    expect(screen.getByRole('region', { name: 'Create your first workscape' })).toBeInTheDocument();
    expect(screen.getByText('recents')).toHaveClass('gd-empty__label');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Create your first workscape',
    );
    expect(screen.getByRole('button', { name: 'Create workscape' })).toBeInTheDocument();
  });
});
