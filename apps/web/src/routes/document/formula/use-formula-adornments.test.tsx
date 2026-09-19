import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  createTable,
  setCellText,
  setColumnFormat,
  setTableTitle,
  tableById,
  tableMap,
  type Id,
} from '@gede/core';

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
    expect(forms.querySelectorAll('[role=option]')).toHaveLength(3);

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

  it('REF-01 FX-04 (partial: test host, grid editor not wired) typing @Pri in column 3 offers Priya from column 2 — once per row, the value first and the path beneath — and picking her commits the path as a reference', async () => {
    const d = testDoc(3, 3);
    setTableTitle(d.gd, d.tableId, 'Deliverables');
    d.set(0, 0, 'Onboarding flow');
    d.set(0, 1, 'Priya');
    d.set(1, 0, 'Passkey sign-in');
    d.set(1, 1, 'Priya');
    d.set(2, 0, 'Billing export');
    d.set(2, 1, 'Marcus');
    render(<Host d={d} colId={d.colId(2)} />);
    const editor = screen.getByLabelText('Edit');
    await userEvent.click(editor);
    await userEvent.type(editor, '@Pri');
    const list = await screen.findByRole('listbox', { name: 'Entities' });
    const options = Array.from(list.querySelectorAll('[role=option]'));
    expect(options.map((o) => o.querySelector('.gd-formula-option__value')?.textContent)).toEqual([
      'Priya',
      'Priya',
    ]);
    expect(options.map((o) => o.querySelector('.gd-formula-option__path')?.textContent)).toEqual([
      '@Deliverables."Onboarding flow"."Column 2"',
      '@Deliverables."Passkey sign-in"."Column 2"',
    ]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(editor).toHaveAttribute('aria-activedescendant', options[0]!.id);
    await userEvent.keyboard('{ArrowDown}');
    expect(editor).toHaveAttribute('aria-activedescendant', options[1]!.id);
    await userEvent.keyboard('{Enter}');
    // REF-01: in a plain cell the pick is the whole draft.
    expect(editor).toHaveValue('=@Deliverables."Passkey sign-in"."Column 2"');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    // A row whose first cell is blank is offered by its first text cell.
    d.set(2, 0, '');
    await userEvent.clear(editor);
    await userEvent.type(editor, '@Mar');
    const again = await screen.findByRole('listbox', { name: 'Entities' });
    expect(again.querySelector('.gd-formula-option__value')).toHaveTextContent('Marcus');
    expect(again.querySelector('.gd-formula-option__path')).toHaveTextContent(
      '@Deliverables.Marcus',
    );
  });

  it('FX-04 REF-01 (partial: test host, grid editor not wired) a bare @ lists the edited table first, eight entries at most with the highlight walking them, and the editor is described by how many more there are; a value typed from another table still finds it (ADR-054)', async () => {
    const d = testDoc(4, 4);
    setTableTitle(d.gd, d.tableId, 'Deliverables');
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) d.set(r, c, `D${String(r)}${String(c)}`);
    }
    d.set(1, 2, 'Blocked');
    d.set(3, 2, 'Blocked');
    // A second table, created later (so it sorts after Deliverables in workbook order), is the
    // one being edited: its entries lead the bare list all the same.
    const teamId = createTable(d.gd, {
      sheetId: d.sheetId,
      at: { col: 8, row: 1 },
      columns: 2,
      rows: 2,
      title: 'Team',
    });
    const team = tableById(d.gd, teamId)!;
    setCellText(d.gd, teamId, team.rows[0]!, team.columns[0]!.id, 'Priya');
    setCellText(d.gd, teamId, team.rows[1]!, team.columns[0]!.id, 'Marcus');
    render(<Host d={{ ...d, table: tableMap(d.gd, teamId)! }} colId={team.columns[1]!.id} />);
    const editor = screen.getByLabelText('Edit');
    await userEvent.click(editor);
    await userEvent.type(editor, '=@');
    await screen.findByRole('listbox', { name: 'Entities' });
    const options = () =>
      Array.from(
        screen.getByRole('listbox', { name: 'Entities' }).querySelectorAll('[role=option]'),
      );
    expect(options()).toHaveLength(8);
    expect(options()[0]!.textContent).toContain('@Team.Priya');
    expect(options()[1]!.textContent).toContain('@Team.Priya."Column 2"');
    expect(options()[2]!.textContent).toContain('@Team.Marcus');
    expect(options()[4]!.textContent).toContain('@Deliverables.D00');
    // 4 Team + 16 Deliverables entries, 8 shown; the count describes the editor, not the list.
    const more = screen.getByText('12 more — keep typing');
    expect(more).not.toHaveAttribute('aria-live');
    expect(editor).toHaveAttribute('aria-describedby', more.id);
    expect(editor).toHaveAccessibleDescription('12 more — keep typing');
    for (let i = 0; i < 7; i += 1) await userEvent.keyboard('{ArrowDown}');
    expect(editor).toHaveAttribute('aria-activedescendant', options()[7]!.id);
    expect(options()[7]).toHaveAttribute('aria-selected', 'true');
    // A value in another table's third column is found by its text.
    await userEvent.type(editor, 'Blocked');
    await waitFor(() => {
      expect(options()).toHaveLength(2);
    });
    expect(options().map((o) => o.querySelector('.gd-formula-option__path')?.textContent)).toEqual([
      '@Deliverables.D10."Column 3"',
      '@Deliverables.D30."Column 3"',
    ]);
    expect(screen.queryByText(/more — keep typing/)).toBeNull();
    expect(editor).not.toHaveAttribute('aria-describedby');
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
