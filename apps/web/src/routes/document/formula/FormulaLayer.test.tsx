import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { addRow, LATTICE, parseAddress, setRowWrapped } from '@gede/core';

import { testDoc } from '../../../test/formula-doc.js';
import {
  registerFormulaEditor,
  resetFormulaEditingForTests,
  updateFormulaEditor,
} from './editing-store.js';
import { FormulaLayer } from './FormulaLayer.js';
import { ReferenceOutlines, referenceColourVar } from './ReferenceOutlines.js';
import { operandsOf } from './workbook.js';

function px(units: number, axis: 'col' | 'row'): string {
  return `${String(units * LATTICE[axis])}px`;
}

afterEach(() => {
  resetFormulaEditingForTests();
});

describe('ReferenceOutlines', () => {
  it('FX-08 A11Y-04 outlines each operand at its lattice block in the colour of its index, with the index as a badge; a range is one block', () => {
    const d = testDoc(5, 3);
    const range = `${d.addr(0, 0)}:${d.addr(2, 0)}`;
    const single = d.addr(1, 2);
    const operands = operandsOf(d.doc, d.sheetId, `=Sum(${range}, ${single})`);
    render(<ReferenceOutlines operands={operands} zoom={1.5} />);
    const outlines = screen.getByTestId('reference-outlines');
    expect(outlines.style.getPropertyValue('--gd-zoom')).toBe('1.5');
    const blocks = outlines.querySelectorAll<HTMLElement>('.gd-outline');
    expect(blocks).toHaveLength(2);
    const [first, second] = Array.from(blocks);
    const start = parseAddress(d.addr(0, 0));
    if (!start.ok) throw new Error('bad address');
    expect(first).toHaveClass('gd-outline--range');
    expect(first?.style.left).toBe(px(start.value.col, 'col'));
    expect(first?.style.top).toBe(px(start.value.row, 'row'));
    expect(first?.style.width).toBe(px(1, 'col'));
    expect(first?.style.height).toBe(px(3, 'row'));
    expect(first?.style.getPropertyValue('--gd-outline')).toBe(referenceColourVar(0));
    expect(first?.querySelector('.gd-outline__index')).toHaveTextContent('1');
    expect(second?.style.getPropertyValue('--gd-outline')).toBe('var(--reference-2)');
    expect(second?.querySelector('.gd-outline__index')).toHaveTextContent('2');
    expect(second).toHaveAttribute('data-label', single);
  });

  it('FX-08 A11Y-04 an operand of a stored formula that is not bound to a cell is drawn as not anchored, with the reason as text', () => {
    const d = testDoc(3, 1);
    d.set(0, 0, `=Sum(${d.addr(1, 0)}, H20)`);
    const stored = d.stored(0, 0);
    expect(stored).toMatch(/H20\)$/);
    render(<ReferenceOutlines operands={operandsOf(d.doc, d.sheetId, stored, true)} zoom={1} />);
    const blocks = screen
      .getByTestId('reference-outlines')
      .querySelectorAll<HTMLElement>('.gd-outline');
    expect(blocks[0]).toHaveAttribute('data-anchored', 'true');
    expect(blocks[0]).not.toHaveClass('gd-outline--positional');
    expect(blocks[1]).toHaveAttribute('data-anchored', 'false');
    expect(blocks[1]).toHaveClass('gd-outline--positional');
    expect(blocks[1]).toHaveTextContent('not anchored');
    expect(blocks[1]?.title).toMatch(/H20 is not anchored to a cell/);
    // A draft being typed is not flagged: nothing is bound until commit.
    const draft = operandsOf(d.doc, d.sheetId, `=Sum(${d.addr(1, 0)}, H20)`);
    expect(draft.every((o) => o.anchored)).toBe(true);
  });

  it('FX-08 colours cycle after six operands; the badge keeps them apart', () => {
    expect(referenceColourVar(5)).toBe('var(--reference-6)');
    expect(referenceColourVar(6)).toBe('var(--reference-1)');
  });

  it('GRID-09 a wrapped row makes the outlined block two lattice rows tall', () => {
    const d = testDoc(3, 1);
    setRowWrapped(d.gd, d.tableId, d.rowId(1), true);
    const operands = operandsOf(d.doc, d.sheetId, `=${d.addr(1, 0)}`);
    expect(operands[0]?.rect).toMatchObject({ rows: 2, cols: 1 });
  });

  it('FX-08 a stored (id-bound) source outlines the cells it is bound to, wherever they sit now', () => {
    const d = testDoc(4, 1);
    d.set(1, 0, '5');
    d.set(3, 0, `=Sum(${d.addr(1, 0)})`);
    const stored = d.stored(3, 0);
    expect(stored).toMatch(/\{c:/);
    const before = operandsOf(d.doc, d.sheetId, stored);
    expect(before[0]?.label).toBe(d.addr(1, 0));
    // Insert a row above: the bound cell moved down one lattice row, and so does the outline.
    addRow(d.gd, d.tableId, d.rowId(0));
    const after = operandsOf(d.doc, d.sheetId, stored);
    expect(after[0]?.label).toBe(d.addr(2, 0));
    expect(after[0]?.rect?.row).toBe((before[0]?.rect?.row ?? 0) + 1);
    expect(after[0]?.cellIds).toEqual(before[0]?.cellIds);
  });
});

describe('FormulaLayer', () => {
  it('FX-08 outlines the selected formula cell from its stored source, follows the live draft while editing, and clears on deselect', () => {
    const d = testDoc(4, 2);
    d.set(0, 0, '10');
    d.set(1, 0, '20');
    d.set(2, 0, `=Sum(${d.addr(0, 0)}:${d.addr(1, 0)})`);
    const cell = { tableId: d.tableId, rowId: d.rowId(2), colId: d.colId(0) };
    const view = render(
      <FormulaLayer gd={d.gd} sheetId={d.sheetId} zoom={1} selected={null} editing={null} />,
    );
    expect(screen.queryByTestId('reference-outlines')).not.toBeInTheDocument();
    expect(screen.getByTestId('formula-engine')).toHaveAttribute('data-mode', 'inline');

    view.rerender(
      <FormulaLayer gd={d.gd} sheetId={d.sheetId} zoom={1} selected={cell} editing={null} />,
    );
    const block = screen.getByTestId('reference-outlines').querySelector('.gd-outline');
    expect(block).toHaveAttribute('data-label', `${d.addr(0, 0)}:${d.addr(1, 0)}`);

    // Editing: the open editor publishes its draft and the outlines follow it keystroke by keystroke.
    const handle = { state: { ...cell, draft: '=Sum(', formula: true }, insert: () => undefined };
    act(() => {
      registerFormulaEditor(handle);
    });
    view.rerender(
      <FormulaLayer gd={d.gd} sheetId={d.sheetId} zoom={1} selected={cell} editing={cell} />,
    );
    expect(screen.queryByTestId('reference-outlines')).not.toBeInTheDocument(); // no operand yet
    // An unclosed call outlines what it has so far (PRD §22: the outline updates live).
    act(() => {
      updateFormulaEditor(handle, {
        ...cell,
        draft: `=Sum(${d.addr(0, 0)}, ${d.addr(1, 1)}`,
        formula: true,
      });
    });
    expect(screen.getByTestId('reference-outlines').querySelectorAll('.gd-outline')).toHaveLength(
      2,
    );

    view.rerender(
      <FormulaLayer gd={d.gd} sheetId={d.sheetId} zoom={1} selected={null} editing={null} />,
    );
    expect(screen.queryByTestId('reference-outlines')).not.toBeInTheDocument();
  });
});
