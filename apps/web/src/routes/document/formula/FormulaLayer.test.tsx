import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LATTICE, parseAddress, setRowWrapped } from '@gede/core';

import { testDoc } from '../../../test/formula-doc.js';
import { FormulaLayer } from './FormulaLayer.js';
import { ReferenceOutlines, referenceColourVar } from './ReferenceOutlines.js';
import { operandsOfDraft } from './workbook.js';

function px(units: number, axis: 'col' | 'row'): string {
  return `${String(units * LATTICE[axis])}px`;
}

describe('ReferenceOutlines', () => {
  it('FX-08 A11Y-04 outlines each operand at its lattice block in the colour of its index, with the index as a badge; a range is one block', () => {
    const d = testDoc(5, 3);
    const range = `${d.addr(0, 0)}:${d.addr(2, 0)}`;
    const single = d.addr(1, 2);
    const operands = operandsOfDraft(d.gd, d.sheetId, `=Sum(${range}, ${single})`);
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

  it('FX-08 colours cycle after six operands; the badge keeps them apart', () => {
    expect(referenceColourVar(5)).toBe('var(--reference-6)');
    expect(referenceColourVar(6)).toBe('var(--reference-1)');
  });

  it('GRID-09 a wrapped row makes the outlined block two lattice rows tall', () => {
    const d = testDoc(3, 1);
    setRowWrapped(d.gd, d.tableId, d.rowId(1), true);
    const operands = operandsOfDraft(d.gd, d.sheetId, `=${d.addr(1, 0)}`);
    expect(operands[0]?.rect).toMatchObject({ rows: 2, cols: 1 });
  });
});

describe('FormulaLayer', () => {
  it('FX-07 FX-08 shows every formula cell with value, badge and expression, outlines the selected formula, and clears on deselect', async () => {
    const d = testDoc(4, 2);
    d.set(0, 0, '10');
    d.set(1, 0, '20');
    d.set(2, 0, `=Sum(${d.addr(0, 0)}:${d.addr(1, 0)})`);
    const cell = { tableId: d.tableId, rowId: d.rowId(2), colId: d.colId(0) };
    const view = render(
      <FormulaLayer
        gd={d.gd}
        sheetId={d.sheetId}
        tier="micro"
        zoom={1}
        selected={null}
        editing={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('30')).toBeInTheDocument();
    });
    const overlay = screen.getByTestId('formula-overlay');
    const start = parseAddress(d.addr(2, 0));
    if (!start.ok) throw new Error('bad address');
    expect(overlay.style.left).toBe(px(start.value.col, 'col'));
    expect(overlay.style.top).toBe(px(start.value.row, 'row'));
    expect(screen.getByLabelText('Formula, 1 reference')).toBeInTheDocument();
    // A compact row has no second line: the expression is the tooltip until the row wraps (GRID-09).
    const expression = `=Sum(${d.addr(0, 0)}:${d.addr(1, 0)})`;
    expect(screen.queryByLabelText(/^Expression/)).not.toBeInTheDocument();
    expect(screen.getByTestId('formula-cell')).toHaveAttribute('title', expression);
    act(() => {
      setRowWrapped(d.gd, d.tableId, d.rowId(2), true);
    });
    expect(overlay.style.height).toBe(px(2, 'row'));
    expect(screen.getByLabelText(`Expression ${expression}`)).toBeInTheDocument();
    expect(screen.queryByTestId('reference-outlines')).not.toBeInTheDocument();

    view.rerender(
      <FormulaLayer
        gd={d.gd}
        sheetId={d.sheetId}
        tier="micro"
        zoom={1}
        selected={cell}
        editing={null}
      />,
    );
    expect(screen.getByTestId('reference-outlines').querySelectorAll('.gd-outline')).toHaveLength(
      1,
    );
    expect(overlay).toHaveClass('gd-formula-overlay--selected');

    // Editing the cell hides its overlay (the editor shows through) and outlines follow the draft.
    view.rerender(
      <FormulaLayer
        gd={d.gd}
        sheetId={d.sheetId}
        tier="micro"
        zoom={1}
        selected={cell}
        editing={cell}
        draft={`=Sum(${d.addr(0, 0)}, ${d.addr(1, 1)})`}
      />,
    );
    expect(screen.queryByTestId('formula-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('reference-outlines').querySelectorAll('.gd-outline')).toHaveLength(
      2,
    );

    view.rerender(
      <FormulaLayer
        gd={d.gd}
        sheetId={d.sheetId}
        tier="micro"
        zoom={1}
        selected={null}
        editing={null}
      />,
    );
    expect(screen.queryByTestId('reference-outlines')).not.toBeInTheDocument();
  });

  it('FX-06 the overlay re-renders when a referenced cell changes remotely', async () => {
    const d = testDoc(3, 1);
    d.set(0, 0, '1');
    d.set(1, 0, `=Sum(${d.addr(0, 0)})`);
    render(
      <FormulaLayer
        gd={d.gd}
        sheetId={d.sheetId}
        tier="micro"
        zoom={1}
        selected={null}
        editing={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('1')).toBeInTheDocument();
    });
    act(() => {
      d.set(0, 0, '7');
    });
    await waitFor(() => {
      expect(screen.getByText('7')).toBeInTheDocument();
    });
  });

  it('DOC-05 nothing is overlaid in the meso and macro tiers', () => {
    const d = testDoc(2, 1);
    d.set(0, 0, '=Concat("a")');
    render(
      <FormulaLayer
        gd={d.gd}
        sheetId={d.sheetId}
        tier="macro"
        zoom={0.2}
        selected={null}
        editing={null}
      />,
    );
    expect(screen.queryByTestId('formula-overlay')).not.toBeInTheDocument();
  });
});
