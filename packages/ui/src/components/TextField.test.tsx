import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TextField } from './TextField.js';

describe('TextField', () => {
  it('labels the input and passes inputMode/autoComplete through', () => {
    render(<TextField label="Email" inputMode="email" autoComplete="email" type="email" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('inputmode', 'email');
    expect(input).toHaveAttribute('autocomplete', 'email');
  });

  it('describes the input with hint and error, and marks it invalid', () => {
    render(<TextField label="Email" hint="Work address" error="Enter a valid email address" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Work address Enter a valid email address');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address');
  });

  it('is reachable by Tab and accepts typing', async () => {
    render(<TextField label="Name" />);
    await userEvent.tab();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await userEvent.keyboard('Meena');
    expect(screen.getByLabelText('Name')).toHaveValue('Meena');
  });

  it('disabled input is skipped by Tab', async () => {
    render(<TextField label="Name" disabled />);
    await userEvent.tab();
    expect(screen.getByLabelText('Name')).not.toHaveFocus();
  });
});
