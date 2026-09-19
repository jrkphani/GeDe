import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { setColumnFormat, setTableTitle, type Id } from '@gede/core';

import { testDoc, type TestDoc } from '../../../test/formula-doc.js';
import {
  FormulaEditorAdornments,
  type FormulaEditorAdornmentsHandle,
} from './FormulaEditorAdornments.js';
import { useFormulaAdornments } from './use-formula-adornments.js';

/**
 * A minimal editor host, the shape the grid editor will take: a textarea whose
 * value and caret feed the hook, and which the hook writes back through onReplace.
 */
function Host({
  d,
  colId,
  onClickAddress,
  initial = '',
}: {
  d: TestDoc;
  colId: Id;
  onClickAddress?: ((insert: (address: string) => void) => void) | undefined;
  initial?: string;
}) {
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState({ start: initial.length, end: initial.length });
  const ref = useRef<HTMLTextAreaElement>(null);
  const [anchor, setAnchor] = useState<Element | null>(null);
  const [cancelled, setCancelled] = useState(0);
  const a = useFormulaAdornments({
    table: d.table,
    colId,
    text,
    selectionStart: caret.start,
    selectionEnd: caret.end,
    anchor,
    onReplace: ({ text: next, caret: at }) => {
      setText(next);
      setCaret({ start: at, end: at });
      queueMicrotask(() => {
        ref.current?.setSelectionRange(at, at);
      });
    },
  });
  onClickAddress?.(a.onCellClickWhileEditing);
  return (
    <>
      <textarea
        ref={(el) => {
          ref.current = el;
          setAnchor(el);
        }}
        aria-label="Edit"
        value={text}
        {...a.inputProps}
        onChange={(e) => {
          setText(e.target.value);
          setCaret({ start: e.target.selectionStart, end: e.target.selectionEnd });
        }}
        onSelect={(e) => {
          setCaret({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd });
        }}
        onKeyDown={(e) => {
          if (a.onKeyDown(e.nativeEvent)) return;
          if (e.code === 'Escape') setCancelled((n) => n + 1);
        }}
      />
      {a.element}
      <output data-testid="open">{a.open ?? 'none'}</output>
      <output data-testid="cancelled">{String(cancelled)}</output>
    </>
  );
}

describe('useFormulaAdornments', () => {
  it('FX-02 typing = opens the menu of forms; Sum is "offered only when the column is Number or Currency" — by the column format, not its contents', async () => {
    const d = testDoc(3, 3);
    // Column 0 holds only numbers but is Automatic: not offered. Column 1 is formatted Number.
    d.set(0, 0, '2860');
    d.set(1, 0, '3440');
    d.set(0, 1, 'Lukla');
    d.set(1, 1, 'Namche');
    setColumnFormat(d.gd, d.tableId, d.colId(1), 'number', { decimals: 2 });
    const view = render(<Host d={d} colId={d.colId(0)} />);
    const editor = screen.getByLabelText('Edit');
    await userEvent.type(editor, '=');
    const forms = await screen.findByRole('listbox', { name: 'Formula forms' });
    expect(editor).toHaveFocus();
    // `aria-expanded` is not allowed on a textbox (axe critical); the open signal is aria-controls.
    expect(editor).not.toHaveAttribute('aria-expanded');
    expect(editor).toHaveAttribute('aria-controls', forms.id);
    const sum = screen.getByRole('option', { name: /Sum/ });
    expect(sum).toHaveAttribute('aria-disabled', 'true');
    expect(sum).toHaveTextContent('Sum is offered on Number or Currency columns');
    // Concat, Sum, the five set operators (FX-09) and the @ path.
    expect(forms.querySelectorAll('[role=option]')).toHaveLength(8);

    view.unmount();
    const numberView = render(<Host d={d} colId={d.colId(1)} />);
    const editor2 = screen.getByLabelText('Edit');
    await userEvent.type(editor2, '=');
    await screen.findByRole('listbox', { name: 'Formula forms' });
    const sum2 = screen.getByRole('option', { name: /Sum/ });
    expect(sum2).not.toHaveAttribute('aria-disabled');
    // ↓ moves the highlight to Sum, Enter inserts it and the editor stays open.
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(editor2).toHaveValue('=Sum(');
    expect(editor2).toHaveFocus();
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    // A Currency column is offered too; a Text column with numbers in it is not.
    numberView.unmount();
    setColumnFormat(d.gd, d.tableId, d.colId(2), 'currency', { currency: 'SGD' });
    const currencyView = render(<Host d={d} colId={d.colId(2)} />);
    await userEvent.type(screen.getByLabelText('Edit'), '=');
    await screen.findByRole('listbox', { name: 'Formula forms' });
    expect(screen.getByRole('option', { name: /Sum/ })).not.toHaveAttribute('aria-disabled');
    currencyView.unmount();
    setColumnFormat(d.gd, d.tableId, d.colId(0), 'text');
    render(<Host d={d} colId={d.colId(0)} />);
    await userEvent.type(screen.getByLabelText('Edit'), '=');
    await screen.findByRole('listbox', { name: 'Formula forms' });
    expect(screen.getByRole('option', { name: /Sum/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('FX-09 the forms menu offers Union, Inter, Diff, Comp and Cross wherever Concat is, each with a hint; picking one inserts the call with the caret inside the parentheses', async () => {
    const d = testDoc(3, 3);
    // An Automatic column: Sum is withheld, the set operators are not gated by format.
    render(<Host d={d} colId={d.colId(0)} />);
    const editor = screen.getByLabelText('Edit');
    await userEvent.type(editor, '=');
    const forms = await screen.findByRole('listbox', { name: 'Formula forms' });
    const labels = Array.from(
      forms.querySelectorAll('[role=option] .gd-formula-option__label'),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      'Concat(a, b, …)',
      'Sum(B2:B14)',
      'Union(a, b)',
      'Inter(a, b)',
      'Diff(a, b)',
      'Comp(a, u)',
      'Cross(a, b)',
      '@Group.Entity',
    ]);
    for (const name of ['Union', 'Inter', 'Diff', 'Comp', 'Cross']) {
      const option = screen.getByRole('option', { name: new RegExp(`^${name}\\(`) });
      expect(option).not.toHaveAttribute('aria-disabled');
      expect(option.querySelector('.gd-formula-option__hint')?.textContent).not.toBe('');
    }
    expect(screen.getByRole('option', { name: /^Union\(/ })).toHaveTextContent(
      'elements in any of the sets',
    );
    // Concat, Sum, Union: two presses of ↓ highlight Union; Enter inserts it and the editor stays open.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(editor).toHaveValue('=Union(');
    expect(editor).toHaveFocus();
    expect((editor as HTMLTextAreaElement).selectionStart).toBe('=Union('.length);
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  it('FX-02 the offer follows a format change while the editor is open', async () => {
    const d = testDoc(2, 1);
    render(<Host d={d} colId={d.colId(0)} />);
    const editor = screen.getByLabelText('Edit');
    await userEvent.type(editor, '=');
    await screen.findByRole('listbox', { name: 'Formula forms' });
    expect(screen.getByRole('option', { name: /Sum/ })).toHaveAttribute('aria-disabled', 'true');
    act(() => {
      setColumnFormat(d.gd, d.tableId, d.colId(0), 'number');
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Sum/ })).not.toHaveAttribute('aria-disabled');
    });
  });

  it('FX-04 (partial: test host, grid editor not wired) @ opens the entity index at the caret, Enter inserts the dotted path and leaves the editor open', async () => {
    const d = testDoc(3, 2);
    setTableTitle(d.gd, d.tableId, 'Everest trek');
    d.set(0, 0, 'Lukla');
    d.set(1, 0, 'Namche');
    d.set(0, 1, '2860');
    render(<Host d={d} colId={d.colId(1)} initial="=Sum(" />);
    const editor = screen.getByLabelText('Edit');
    await userEvent.click(editor);
    await userEvent.type(editor, '@Nam');
    const list = await screen.findByRole('listbox', { name: 'Entities' });
    expect(screen.getByTestId('open')).toHaveTextContent('entities');
    const options = Array.from(list.querySelectorAll('[role=option]')).map((o) => o.textContent);
    expect(options[0]).toContain('@"Everest trek".Namche');
    expect(editor).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(editor).toHaveValue('=Sum(@"Everest trek".Namche');
    expect(editor).toHaveFocus();
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    // Continue the path: a dot re-opens the index for the row's columns.
    await userEvent.type(editor, '.');
    const again = await screen.findByRole('listbox', { name: 'Entities' });
    expect(again.textContent).toContain('@"Everest trek".Namche."Column 2"');
  });

  it('FX-05 (partial: test host, grid editor not wired) a cell clicked while editing lands at the caret with the right separator', async () => {
    const d = testDoc(3, 2);
    let insert: ((address: string) => void) | null = null;
    render(
      <Host
        d={d}
        colId={d.colId(1)}
        initial="=Sum("
        onClickAddress={(fn) => {
          insert = fn;
        }}
      />,
    );
    const editor = screen.getByLabelText('Edit');
    await userEvent.click(editor);
    await waitFor(() => {
      expect(insert).not.toBeNull();
    });
    insert!('B5');
    await waitFor(() => {
      expect(editor).toHaveValue('=Sum(B5');
    });
    insert!('B6');
    await waitFor(() => {
      expect(editor).toHaveValue('=Sum(B5, B6');
    });
  });

  it('KEYS-06 (partial: Escape ordering only, test host) Escape closes an open surface first and does not cancel the edit; the next Escape reaches the host', async () => {
    const d = testDoc(2, 1);
    render(<Host d={d} colId={d.colId(0)} />);
    const editor = screen.getByLabelText('Edit');
    await userEvent.type(editor, '=');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('cancelled')).toHaveTextContent('0');
    expect(editor).toHaveValue('=');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('cancelled')).toHaveTextContent('1');
  });

  it('FX-04 (partial: test host, grid editor not wired) the component form exposes the same handle', async () => {
    const d = testDoc(2, 1);
    d.set(0, 0, 'Lukla');
    function Comp() {
      const handle = useRef<FormulaEditorAdornmentsHandle>(null);
      const [text, setText] = useState('=@');
      return (
        <>
          <textarea
            aria-label="Edit"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
          <FormulaEditorAdornments
            ref={handle}
            table={d.table}
            colId={d.colId(0)}
            text={text}
            selectionStart={text.length}
            selectionEnd={text.length}
            anchor={null}
            onReplace={(r) => {
              setText(r.text);
            }}
          />
          <button
            type="button"
            onClick={() => {
              handle.current?.onCellClickWhileEditing('C3');
            }}
          >
            click cell
          </button>
          <output data-testid="open">{handle.current?.open ?? 'none'}</output>
        </>
      );
    }
    render(<Comp />);
    expect(await screen.findByRole('listbox', { name: 'Entities' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'click cell' }));
    expect(screen.getByLabelText('Edit')).toHaveValue('=@, C3');
  });
});
