import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import {
  cellFormat,
  docNode,
  paragraphNode,
  richFromText,
  textNode,
  type Mark,
  type RichDoc,
} from '@gede/core';

import { CellContent } from './CellContent.js';
import { layoutCell } from './layout.js';

const bold: Mark = { type: 'bold' };
const italic: Mark = { type: 'italic' };

function rich(...runs: [string, Mark[]][]): RichDoc {
  return docNode([paragraphNode(runs.map(([t, m]) => textNode(t, m)))]);
}

describe('CellContent (DOM-first renderer)', () => {
  test('INSP-06 (partial) marks lay out as semantic elements without ProseMirror', () => {
    const { container } = render(
      <CellContent
        content={rich(
          ['a', [bold]],
          ['b', [italic]],
          ['c', [{ type: 'underline' }]],
          ['d', [{ type: 'strikethrough' }]],
          ['e', [{ type: 'superscript' }]],
          ['f', [{ type: 'subscript' }]],
          ['g', [{ type: 'link', attrs: { href: 'https://gede.work' } }]],
          ['h', [{ type: 'textColour', attrs: { token: 'danger' } }]],
          ['i', [{ type: 'highlight', attrs: { token: 'amber' } }]],
        )}
        format={cellFormat('auto')}
        locale="en-US"
      />,
    );
    const root = container.querySelector('.gd-rich')!;
    expect(root.querySelector('strong')?.textContent).toBe('a');
    expect(root.querySelector('em')?.textContent).toBe('b');
    expect(root.querySelector('u')?.textContent).toBe('c');
    expect(root.querySelector('s')?.textContent).toBe('d');
    expect(root.querySelector('sup')?.textContent).toBe('e');
    expect(root.querySelector('sub')?.textContent).toBe('f');
    const link = root.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://gede.work');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.tabIndex).toBe(-1);
    expect(root.querySelector('[data-ink="danger"]')?.textContent).toBe('h');
    expect(root.querySelector('mark[data-highlight="amber"]')?.textContent).toBe('i');
    expect(root.querySelector('.ProseMirror')).toBeNull();
    expect(root.textContent).toBe('abcdefghi');
  });

  test('nesting order is deterministic: link outside highlight outside colour outside weight', () => {
    const html = renderToStaticMarkup(
      <CellContent
        content={rich([
          'x',
          [
            bold,
            { type: 'highlight', attrs: { token: 'forest' } },
            { type: 'link', attrs: { href: 'https://a' } },
          ],
        ])}
        format={cellFormat('auto')}
        locale="en-US"
      />,
    );
    expect(html).toContain(
      '<a href="https://a" rel="noopener noreferrer" tabindex="-1"><mark data-highlight="forest"><strong>x</strong></mark></a>',
    );
  });

  test('FMT-02 a number renders grouped, with the decimals asked for, right-aligned, keeping its marks', () => {
    const { container } = render(
      <CellContent
        content={rich(['1234.5', [bold]])}
        format={cellFormat('number', { decimals: 2 })}
        locale="en-US"
      />,
    );
    const root = container.querySelector('.gd-rich')!;
    expect(root).toHaveClass('gd-rich--right');
    expect(root.querySelector('strong')?.textContent).toBe('1,234.50');
    expect(root.getAttribute('title')).toBe('1,234.50');
  });

  test('FMT-03 a negative currency renders in accounting parentheses', () => {
    const { container } = render(
      <CellContent
        content="-1250"
        format={cellFormat('currency', { currency: 'SGD' })}
        locale="en-GB"
      />,
    );
    const root = container.querySelector('.gd-rich')!;
    expect(root.getAttribute('title')).toBe('(SGD\u00a01,250.00)');
    expect(root).toHaveClass('gd-rich--right');
  });

  test('FMT-04 a date renders per locale from its stored ISO form', () => {
    const { rerender } = render(
      <CellContent content="2026-09-12" format={cellFormat('date')} locale="en-US" />,
    );
    expect(screen.getByTitle('Sep 12, 2026')).toBeInTheDocument();
    rerender(<CellContent content="2026-09-12" format={cellFormat('date')} locale="en-GB" />);
    expect(screen.getByTitle('12 Sept 2026')).toBeInTheDocument();
  });

  test('FMT-05 A11Y-04 an invalid value keeps its text, tints the cell and shows a warning glyph with text', () => {
    const { container } = render(
      <CellContent
        content="n/a"
        format={cellFormat('number')}
        locale="en-US"
        describedById="warn-1"
      />,
    );
    const root = container.querySelector('.gd-rich')!;
    expect(root).toHaveClass('gd-rich--invalid');
    expect(root).not.toHaveClass('gd-rich--right');
    expect(root.getAttribute('data-invalid')).toBe('number');
    expect(root.textContent).toContain('n/a');
    expect(root.querySelector('.gd-rich__warn svg[data-name="warning"]')).not.toBeNull();
    expect(screen.getByText('Not a number')).toHaveClass('gd-visually-hidden');
    expect(root.querySelector('#warn-1')).not.toBeNull();
    expect(root.textContent).not.toContain('0');
  });

  test('FMT-01 Automatic infers from the text and leaves what it cannot parse alone', () => {
    const { container, rerender } = render(
      <CellContent content="1234" format={cellFormat('auto')} locale="en-IN" />,
    );
    expect(container.querySelector('.gd-rich')?.textContent).toBe('1,234');
    rerender(<CellContent content="Meena" format={cellFormat('auto')} locale="en-IN" />);
    expect(container.querySelector('.gd-rich')?.textContent).toBe('Meena');
    expect(container.querySelector('.gd-rich--invalid')).toBeNull();
  });

  test('Text presets apply at render time and keep marks', () => {
    const { container } = render(
      <CellContent
        content={rich(['meena ', [bold]], ['kumar', []])}
        format={cellFormat('text', { textCase: 'titleCase' })}
        locale="en-US"
      />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Meena ');
    expect(container.querySelector('.gd-rich')?.textContent).toBe('Meena Kumar');
  });

  test('I18N-03 Indic text sets lang on the cell so the Noto fallback and 1.7 line-height apply', () => {
    const { container, rerender } = render(
      <CellContent content="வணக்கம்" format={cellFormat('auto')} locale="en-US" />,
    );
    const root = container.querySelector('.gd-rich')!;
    expect(root.getAttribute('lang')).toBe('ta');
    expect(root).toHaveClass('gd-rich--indic');
    rerender(<CellContent content="नमस्ते" format={cellFormat('auto')} locale="en-US" />);
    expect(container.querySelector('.gd-rich')?.getAttribute('lang')).toBe('hi');
    rerender(<CellContent content="నమస్కారం" format={cellFormat('auto')} locale="en-US" />);
    expect(container.querySelector('.gd-rich')?.getAttribute('lang')).toBe('te');
    rerender(<CellContent content="Hello" format={cellFormat('auto')} locale="ta-IN" />);
    expect(container.querySelector('.gd-rich')?.hasAttribute('lang')).toBe(false);
  });

  test('paragraphs render as blocks; an empty cell renders one empty paragraph and no title', () => {
    const { container } = render(
      <CellContent content={richFromText('a\nb')} format={cellFormat('auto')} locale="en-US" />,
    );
    expect(container.querySelectorAll('.gd-rich__p')).toHaveLength(2);
    const { container: empty } = render(
      <CellContent content="" format={cellFormat('auto')} locale="en-US" />,
    );
    expect(empty.querySelector('.gd-rich')?.hasAttribute('title')).toBe(false);
  });
});

describe('renderer budget (PRD §20: 10,000 cells on the sheet at 60 fps)', () => {
  const cells: RichDoc[] = Array.from({ length: 2000 }, (_, i) =>
    docNode([
      paragraphNode([
        textNode(`Item ${String(i)} `, [bold]),
        textNode('draft', [italic, { type: 'highlight', attrs: { token: 'amber' } }]),
        textNode(` ${String(i * 3)}`, []),
      ]),
    ]),
  );
  const format = cellFormat('auto');

  test('laying out 2,000 marked cells takes under 50 ms', () => {
    layoutCell(cells[0]!, format, 'en-US'); // warm the Intl caches
    const t0 = performance.now();
    for (const doc of cells) layoutCell(doc, format, 'en-US');
    const ms = performance.now() - t0;
    console.log(`layoutCell × 2000: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(50);
  });

  test('rendering 2,000 marked cells to markup stays within budget', () => {
    renderToStaticMarkup(<CellContent content={cells[0]!} format={format} locale="en-US" />);
    const t0 = performance.now();
    const html = renderToStaticMarkup(
      <>
        {cells.map((doc, i) => (
          <CellContent key={i} content={doc} format={format} locale="en-US" />
        ))}
      </>,
    );
    const ms = performance.now() - t0;
    // React's development build (what vitest loads) validates every element and is
    // roughly ten times slower than production: 106 ms vs 10 ms measured on the
    // reference machine. The 50 ms budget is the production one; the development
    // run keeps a proportionate ceiling so a regression still fails here.
    const production = process.env.NODE_ENV === 'production';
    console.log(
      `CellContent × 2000 (static markup, ${production ? 'production' : 'development'} React): ${ms.toFixed(1)} ms, ${String(html.length)} chars`,
    );
    expect(html).toContain('<strong>Item 1999 </strong>');
    expect(ms).toBeLessThan(production ? 50 : 400);
  });
});
