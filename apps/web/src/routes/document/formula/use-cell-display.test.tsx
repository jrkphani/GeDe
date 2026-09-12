import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { setLocale } from '../../../locale.js';
import { testDoc } from '../../../test/formula-doc.js';
import { FormulaCellContent } from './FormulaCellContent.js';
import { formatCellValue, useCellDisplay } from './use-cell-display.js';

describe('useCellDisplay', () => {
  it('FX-07 a formula cell reports its value, expression and badge once the engine answers; a text cell its text', async () => {
    const d = testDoc();
    d.set(0, 0, '1200');
    d.set(1, 0, '34');
    d.set(2, 0, `=Sum(${d.addr(0, 0)}:${d.addr(1, 0)})`);
    const { result } = renderHook(() => useCellDisplay(d.table, d.key(2, 0)));
    expect(result.current.isFormula).toBe(true);
    expect(result.current.formula).toBe(`=Sum(${d.addr(0, 0)}:${d.addr(1, 0)})`);
    expect(result.current.pending).toBe(true);
    await act(() => d.settled());
    expect(result.current.pending).toBe(false);
    expect(result.current.value).toBe('1,234');
    expect(result.current.badge).toBe('ƒ1');
    expect(result.current.error).toBeNull();
    expect(result.current.operands.map((o) => o.label)).toEqual([
      `${d.addr(0, 0)}:${d.addr(1, 0)}`,
    ]);

    const text = renderHook(() => useCellDisplay(d.table, d.key(0, 0)));
    expect(text.result.current).toMatchObject({
      isFormula: false,
      value: '1200',
      formula: null,
      badge: null,
    });
  });

  it('FX-06 editing a referenced cell updates the dependent display', async () => {
    const d = testDoc();
    d.set(0, 0, '1');
    d.set(1, 0, `=Sum(${d.addr(0, 0)})`);
    const { result } = renderHook(() => useCellDisplay(d.table, d.key(1, 0)));
    await act(() => d.settled());
    expect(result.current.value).toBe('1');
    act(() => {
      d.set(0, 0, '2');
    });
    await act(() => d.settled());
    expect(result.current.value).toBe('2');
  });

  it('FX-02 A11Y-04 an error carries a label and a message, and the value is empty', async () => {
    const d = testDoc();
    d.set(0, 0, 'Base camp');
    d.set(1, 0, `=Sum(${d.addr(0, 0)})`);
    const { result } = renderHook(() => useCellDisplay(d.table, d.key(1, 0)));
    await act(() => d.settled());
    expect(result.current.error).toEqual({
      label: '⚠ text in range',
      message: `${d.addr(0, 0)} holds text, so it cannot be summed`,
    });
    expect(result.current.value).toBe('');
  });

  it('I18N-04 values format through Intl for the active locale', () => {
    setLocale('en-IN');
    expect(formatCellValue('en-IN', { kind: 'number', value: 1234567.5 })).toBe('12,34,567.5');
    expect(formatCellValue('en-US', { kind: 'currency', value: 15, code: 'SGD' })).toMatch(
      /SGD|S\$/,
    );
    expect(formatCellValue('en-GB', { kind: 'date', iso: '2026-09-12' })).toBe('12 Sept 2026');
    expect(formatCellValue('en-US', { kind: 'blank' })).toBe('');
    setLocale('en-US');
  });
});

describe('FormulaCellContent', () => {
  it('FX-07 A11Y-04 renders value, reference badge and expression; an error shows icon and text', async () => {
    const d = testDoc();
    d.set(0, 0, '5');
    d.set(0, 1, '6');
    d.set(1, 0, `=Sum(${d.addr(0, 0)}, ${d.addr(0, 1)})`);
    function Host() {
      const display = useCellDisplay(d.table, d.key(1, 0));
      return <FormulaCellContent display={display} />;
    }
    render(<Host />);
    await waitFor(() => {
      expect(screen.getByText('11')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Formula, 2 references')).toHaveTextContent('ƒ2');
    expect(screen.getByText(`=Sum(${d.addr(0, 0)}, ${d.addr(0, 1)})`)).toBeInTheDocument();

    act(() => {
      d.set(0, 1, 'six');
    });
    await waitFor(() => {
      expect(screen.getByText('text in range')).toBeInTheDocument();
    });
    const error = screen.getByRole('img', {
      name: `${d.addr(0, 1)} holds text, so it cannot be summed`,
    });
    expect(error.querySelector('svg')).not.toBeNull();
  });
});
