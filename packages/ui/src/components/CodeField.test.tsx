import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  CodeField,
  MAX_CODE_LENGTH,
  isCodeComplete,
  normaliseCode,
  type CodeLength,
} from './CodeField.js';

const LABEL: Record<CodeLength, string> = { 6: 'Six-digit code', 8: 'Eight-digit code' };

function Harness({ length }: { length: CodeLength }) {
  const [v, setV] = useState('');
  const [done, setDone] = useState(false);
  return (
    <>
      <CodeField
        length={length}
        label={LABEL[length]}
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
    render(<Harness length={8} />);
    const input = screen.getByLabelText('Eight-digit code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('data-length', '8');
    expect(input).not.toHaveAttribute('maxlength');
  });

  it('AUTH-06 the label follows the length the step passes: six digits for a sign-up code, eight for a sign-in code', () => {
    const { unmount } = render(<Harness length={6} />);
    expect(screen.getByLabelText('Six-digit code')).toHaveAttribute('data-length', '6');
    unmount();
    render(<Harness length={8} />);
    expect(screen.getByLabelText('Eight-digit code')).toHaveAttribute('data-length', '8');
  });

  it('AUTH-06 a pasted "1234 5678" becomes 12345678 in the eight-digit field (digits stripped, nothing dropped)', async () => {
    render(<Harness length={8} />);
    const input = screen.getByLabelText('Eight-digit code');
    await userEvent.click(input);
    await userEvent.paste('1234 5678');
    expect(input).toHaveValue('12345678');
    expect(screen.getByTestId('complete')).toHaveTextContent('true');
  });

  it('AUTH-06 regression: an eight-digit paste into the sign-in step keeps all eight digits (the field never truncated to six)', async () => {
    render(<Harness length={8} />);
    const input = screen.getByLabelText('Eight-digit code');
    await userEvent.click(input);
    await userEvent.paste('12345678');
    expect(input).toHaveValue('12345678');
    expect(input).toHaveAttribute('data-complete', 'true');
  });

  it('AUTH-06 a six-digit field never silently drops digits either: a longer code stays visible and is simply not complete', async () => {
    render(<Harness length={6} />);
    const input = screen.getByLabelText('Six-digit code');
    await userEvent.type(input, '12a-3 4');
    expect(input).toHaveValue('1234');
    await userEvent.paste('56');
    expect(input).toHaveValue('123456');
    expect(screen.getByTestId('complete')).toHaveTextContent('true');
    // A seventh and eighth digit are kept (a code Cognito could send), not thrown away;
    // the complete state says the step does not expect them.
    await userEvent.type(input, '78');
    expect(input).toHaveValue('12345678');
    expect(screen.getByTestId('complete')).toHaveTextContent('false');
    // Beyond the longest code Cognito sends, digits are capped.
    await userEvent.type(input, '9');
    expect(input).toHaveValue('12345678');
  });

  it('AUTH-06 exposes the complete state at exactly the expected length', async () => {
    render(<Harness length={8} />);
    const input = screen.getByLabelText('Eight-digit code');
    await userEvent.type(input, '1234567');
    expect(screen.getByTestId('complete')).toHaveTextContent('false');
    expect(input).not.toHaveAttribute('data-complete');
    await userEvent.type(input, '8');
    expect(screen.getByTestId('complete')).toHaveTextContent('true');
    expect(input).toHaveAttribute('data-complete', 'true');
  });

  it('helpers normalise to the longest code and detect completion per length', () => {
    expect(MAX_CODE_LENGTH).toBe(8);
    expect(normaliseCode(' 1 2 3 4 5 6 7 8 9 ')).toBe('12345678');
    expect(normaliseCode('12a-3 4')).toBe('1234');
    expect(isCodeComplete('12345', 6)).toBe(false);
    expect(isCodeComplete('123456', 6)).toBe(true);
    expect(isCodeComplete('123456', 8)).toBe(false);
    expect(isCodeComplete('12345678', 8)).toBe(true);
    expect(isCodeComplete('12345678', 6)).toBe(false);
  });
});
