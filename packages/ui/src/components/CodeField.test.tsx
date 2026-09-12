import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CodeField, isCodeComplete, normaliseCode } from './CodeField.js';

function Harness() {
  const [v, setV] = useState('');
  const [done, setDone] = useState(false);
  return (
    <>
      <CodeField
        value={v}
        onChange={(next, complete) => {
          setV(next);
          setDone(complete);
        }}
      />
      <output data-testid="complete">{String(done)}</output>
    </>
  );
}

describe('CodeField', () => {
  it('AUTH-06 uses numeric input mode and one-time-code autocomplete; the cap is applied after stripping, not by maxLength', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Six-digit code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).not.toHaveAttribute('maxlength');
  });

  it('AUTH-06 a pasted "123 456" becomes 123456 (digits stripped before the six-digit cap)', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Six-digit code');
    await userEvent.click(input);
    await userEvent.paste('123 456');
    expect(input).toHaveValue('123456');
    expect(screen.getByTestId('complete')).toHaveTextContent('true');
  });

  it('AUTH-06 CodeField strips non-digits and caps at six', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Six-digit code');
    await userEvent.type(input, '12a-3 4');
    expect(input).toHaveValue('1234');
    await userEvent.paste('56789');
    expect(input).toHaveValue('123456');
  });

  it('AUTH-06 exposes the complete state at exactly six digits', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Six-digit code');
    await userEvent.type(input, '12345');
    expect(screen.getByTestId('complete')).toHaveTextContent('false');
    await userEvent.type(input, '6');
    expect(screen.getByTestId('complete')).toHaveTextContent('true');
    expect(input).toHaveAttribute('data-complete', 'true');
  });

  it('helpers normalise and detect completion', () => {
    expect(normaliseCode(' 1 2 3 4 5 6 7 ')).toBe('123456');
    expect(isCodeComplete('12345')).toBe(false);
    expect(isCodeComplete('123456')).toBe(true);
  });
});
