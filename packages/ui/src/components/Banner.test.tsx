import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Banner } from './Banner.js';
import { Button } from './Button.js';

describe('Banner', () => {
  it('states cause and remedy with a warning glyph, as a status', () => {
    render(
      <Banner
        cause="Working offline."
        remedy="Edits are saved on this device and sync when you reconnect."
        action={<Button size="sm">Retry</Button>}
      />,
    );
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Working offline.');
    expect(banner).toHaveTextContent('sync when you reconnect');
    expect(banner.querySelector('svg[data-name="warning"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('A11Y-04 danger tone carries icon and role alert, not hue alone', () => {
    render(<Banner tone="danger" cause="Sync failed." />);
    expect(screen.getByRole('alert').querySelector('svg[data-name="error"]')).not.toBeNull();
  });
});
