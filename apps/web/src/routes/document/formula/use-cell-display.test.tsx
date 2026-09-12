import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { setColumnFormat } from '@gede/core';

import { setLocale } from '../../../locale.js';
import { testDoc } from '../../../test/formula-doc.js';
import { FormulaCellContent } from './FormulaCellContent.js';
import { formatCellValue, renderResult, useCellDisplay } from './use-cell-display.js';

describe('useCellDisplay', () => {
  it('FX-07 a formula cell reports its value, expression and badge once the engine answers; a text cell its text', async () => {
    const d = testDoc();
    d.set(0, 0, '1200');
    d.set(1, 0, '34');
    d.set(2, 0, `=Sum(${d.addr(0, 0)}:${d.addr(1, 0)})`);
    const { result } = renderHook(() => useCellDisplay(d.table, d.key(2, 0)));
    expect(result.current.isFormula).toBe(true);
    // The stored source is id-bound; the display projects it to today's addresses (PRD §20).
    expect(d.stored(2, 0)).toMatch(/^=Sum\(\{r:/);
    expect(result.current.formula).toBe(`=Sum(${d.addr(0, 0)}:${d.addr(1, 0)})`);
    expect(result.current.pending).toBe(true);
    await act(() => d.settled());
    expect(result.current.pending).toBe(false);
    expect(result.current.value).toBe('1,234');
    expect(result.current.badge).toBe('ƒ1');
    expect(result.current.error).toBeNull();
    expect(result.current.operands.map((o) => o.kind)).toEqual(['range']);

    const text = renderHook(() => useCellDisplay(d.table, d.key(0, 0)));
    expect(text.result.current).toMatchObject({
      isFormula: false,
      value: '1200',
      formula: null,
      badge: null,
    });
  });

  it('FX-07 a newly committed expression is pending until the Worker answers for it — never a stale value', async () => {
    const d = testDoc();
    d.set(0, 0, '1');
    d.set(1, 0, `=Sum(${d.addr(0, 0)})`);
    const { result } = renderHook(() => useCellDisplay(d.table, d.key(1, 0)));
    await act(() => d.settled());
    expect(result.current.value).toBe('1');
    act(() => {
      d.set(1, 0, `=Concat("x")`);
    });
    // The result for the old source is still the last one the engine sent.
    expect(result.current.pending).toBe(true);
    expect(result.current.value).toBe('');
    expect(result.current.formula).toBe('=Concat("x")');
    await act(() => d.settled());
    expect(result.current.value).toBe('x');
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

  it('FX-06 A11Y-04 a positional operand is counted and named in the badge label and tooltip', async () => {
    const d = testDoc(3, 1);
    d.set(0, 0, '4');
    d.set(1, 0, `=Sum(${d.addr(0, 0)}, H20)`);
    function Host() {
      const display = useCellDisplay(d.table, d.key(1, 0));
      return <FormulaCellContent display={display} />;
    }
    render(<Host />);
    await waitFor(() => {
      expect(screen.getByText('4')).toBeInTheDocument();
    });
    expect(
      screen.getByLabelText('Formula, 2 references — 1 reference is not anchored to a cell'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('formula-cell')).toHaveAttribute('data-positional', '1');
    expect(screen.getByTestId('formula-cell').title).toMatch(/not anchored to a cell$/);
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

  it('FMT-03 FMT-02 a result "takes the operands’ format": a Sum in a Currency column renders SGD 2,554.50 right-aligned with the column’s decimals; Number decimals apply', async () => {
    const d = testDoc(5, 2);
    setColumnFormat(d.gd, d.tableId, d.colId(0), 'currency', { currency: 'SGD', decimals: 2 });
    d.set(0, 0, '100');
    d.set(1, 0, '-45.5');
    d.set(2, 0, '2500');
    d.set(3, 0, `=Sum(${d.addr(0, 0)}:${d.addr(2, 0)})`);
    const { result } = renderHook(() => useCellDisplay(d.table, d.key(3, 0)));
    await act(() => d.settled());
    expect(result.current.value).toBe('SGD\u00a02,554.50');
    expect(result.current.align).toBe('right');
    // A negative total takes accounting parentheses like a typed cell (FMT-03).
    act(() => {
      d.set(2, 0, '-100');
    });
    await act(() => d.settled());
    expect(result.current.value).toBe('(SGD\u00a045.50)');
    expect(result.current.align).toBe('right');
    // A Number column's decimals apply to its result.
    setColumnFormat(d.gd, d.tableId, d.colId(1), 'number', { decimals: 6 });
    d.set(0, 1, '1,234.50');
    d.set(1, 1, '-45');
    d.set(2, 1, `=Sum(${d.addr(0, 1)}:${d.addr(1, 1)})`);
    const number = renderHook(() => useCellDisplay(d.table, d.key(2, 1)));
    await act(() => d.settled());
    expect(number.result.current.value).toBe('1,189.500000');
    expect(number.result.current.align).toBe('right');
    // The explicit format is passed by the grid; the hook reads the same one when it is not.
    const passed = renderHook(() =>
      useCellDisplay(d.table, d.key(2, 1), { kind: 'number', opts: { decimals: 0 } }),
    );
    expect(passed.result.current.value).toBe('1,190');
  });

  it('FMT-01 FMT-04 a result in an Automatic column keeps the inferred rendering; a Date column formats per locale; a mixed-currency Sum shows its label', async () => {
    const d = testDoc(4, 3);
    d.set(0, 0, '1200');
    d.set(1, 0, '34.5');
    d.set(2, 0, `=Sum(${d.addr(0, 0)}:${d.addr(1, 0)})`);
    const auto = renderHook(() => useCellDisplay(d.table, d.key(2, 0)));
    await act(() => d.settled());
    expect(auto.result.current.value).toBe('1,234.5');
    expect(auto.result.current.align).toBe('right');
    // A Date column: the listed value reads as the date the column shows, per its pattern (FMT-04).
    setColumnFormat(d.gd, d.tableId, d.colId(1), 'date', { datePattern: 'DD/MM/YYYY' });
    d.set(0, 1, '12/9/2026');
    d.set(1, 1, `=${d.addr(0, 1)}`);
    const date = renderHook(() => useCellDisplay(d.table, d.key(1, 1)));
    await act(() => d.settled());
    expect(date.result.current.value).toBe('12/09/2026');
    expect(date.result.current.align).toBe('left');
    // Mixed currencies through formats (the audit's step 4): SGD column plus USD column.
    setColumnFormat(d.gd, d.tableId, d.colId(0), 'currency', { currency: 'SGD' });
    setColumnFormat(d.gd, d.tableId, d.colId(2), 'currency', { currency: 'USD' });
    d.set(0, 2, '10');
    d.set(1, 2, `=Sum(${d.addr(0, 0)}, ${d.addr(0, 2)})`);
    const mixed = renderHook(() => useCellDisplay(d.table, d.key(1, 2)));
    await act(() => d.settled());
    expect(mixed.result.current.error).toEqual({
      label: '⚠ mixed currencies',
      message: `${d.addr(0, 2)} is in USD; the sum so far is in SGD`,
    });
    expect(mixed.result.current.value).toBe('');
  });

  it('FMT-05 FX-01 I18N-04 a text result in a Number column is text, left, never invalid; a numeric result follows the locale', async () => {
    const number = { kind: 'number' as const, opts: { decimals: 2 } };
    // Concat in a Number column: the result is text, not an unparsable number (no tint, no glyph).
    expect(renderResult('en-US', { kind: 'text', text: 'camp fee' }, number)).toEqual({
      text: 'camp fee',
      align: 'left',
    });
    // A list result stays the inferred rendering under any format.
    expect(
      renderResult('en-US', { kind: 'list', items: [{ kind: 'number', value: 1 }] }, number).align,
    ).toBe('left');
    // The locale groups and spells digits for the result as it does for a typed cell.
    expect(renderResult('ta-IN', { kind: 'number', value: 1234567 }, number).text).toBe(
      '12,34,567.00',
    );
    expect(
      renderResult('en-IN', { kind: 'currency', value: 1234567, code: 'INR' }, number).text,
    ).toBe('₹12,34,567.00');
    const d = testDoc(3, 1);
    setColumnFormat(d.gd, d.tableId, d.colId(0), 'number', { decimals: 0 });
    d.set(0, 0, '1234567');
    d.set(1, 0, `=Sum(${d.addr(0, 0)})`);
    const { result } = renderHook(() => useCellDisplay(d.table, d.key(1, 0)));
    await act(() => d.settled());
    expect(result.current.value).toBe('1,234,567');
    act(() => {
      setLocale('ta-IN');
    });
    expect(result.current.value).toBe('12,34,567');
    act(() => {
      setLocale('en-US');
    });
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
