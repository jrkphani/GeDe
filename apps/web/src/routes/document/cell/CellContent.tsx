import clsx from 'clsx';
import { memo, type ReactNode } from 'react';
import type { CellFormat, FormatLocale, Mark, RichDoc } from '@gede/core';
import { Icon } from '@gede/ui';

import { INVALID_LABELS, layoutCell, type CellLayout, type Run } from './layout.js';

export interface CellContentProps {
  /** The cell's rich text, or its plain text (a formula's result, a Wave 1 string). */
  content: RichDoc | string;
  /** A layout the caller already computed (for its `aria-label` and `title`); skips computing it again. */
  layout?: CellLayout | undefined;
  /** Effective format of the cell (column, or its override). */
  format: CellFormat;
  locale: FormatLocale;
  /** Extra class on the root, e.g. the grid's own text class. */
  className?: string | undefined;
  /** Where the invalid glyph's text goes for AT: an id the grid's `aria-describedby` can point at. */
  describedById?: string | undefined;
}

/** Mark → element. Order fixes nesting so the same document always yields the same DOM. */
const MARK_ORDER: readonly Mark['type'][] = [
  'link',
  'highlight',
  'textColour',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'superscript',
  'subscript',
];

function wrap(node: ReactNode, mark: Mark, key: string): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong key={key}>{node}</strong>;
    case 'italic':
      return <em key={key}>{node}</em>;
    case 'underline':
      return <u key={key}>{node}</u>;
    case 'strikethrough':
      return <s key={key}>{node}</s>;
    case 'superscript':
      return <sup key={key}>{node}</sup>;
    case 'subscript':
      return <sub key={key}>{node}</sub>;
    case 'link':
      // A link inside a cell is not a tab stop: the cell is (A11Y-01). ⌘-click follows it.
      return (
        <a key={key} href={mark.attrs.href} rel="noopener noreferrer" tabIndex={-1}>
          {node}
        </a>
      );
    case 'textColour':
      return (
        <span key={key} data-ink={mark.attrs.token}>
          {node}
        </span>
      );
    case 'highlight':
      return (
        <mark key={key} data-highlight={mark.attrs.token}>
          {node}
        </mark>
      );
  }
}

function renderRun(run: Run, key: string): ReactNode {
  let node: ReactNode = run.text;
  // Innermost first, so the outermost element is the first of MARK_ORDER.
  const marks = [...run.marks].sort(
    (a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type),
  );
  for (const mark of marks) node = wrap(node, mark, `${key}-${mark.type}`);
  return node;
}

/**
 * A cell's text at rest: marks laid out as plain DOM (no ProseMirror), the
 * value formatted for the column's data format and locale, right-aligned
 * for numbers, tinted plus a warning glyph and text when invalid (FMT-05,
 * A11Y-04), `lang` set for Indic scripts (I18N-03). Memoised by props so a
 * table of 10,000 cells re-renders only the cells whose text changed.
 */
export const CellContent = memo(function CellContent({
  content,
  format,
  locale,
  className,
  describedById,
  layout: precomputed,
}: CellContentProps) {
  const layout = precomputed ?? layoutCell(content, format, locale);
  return (
    <span
      className={clsx(
        'gd-rich',
        `gd-rich--${layout.align}`,
        { 'gd-rich--invalid': layout.invalid !== null, 'gd-rich--indic': layout.lang !== null },
        className,
      )}
      lang={layout.lang ?? undefined}
      title={layout.text === '' ? undefined : layout.text}
      data-invalid={layout.invalid ?? undefined}
    >
      {layout.paragraphs.map((runs, pi) => (
        <span className="gd-rich__p" key={pi}>
          {runs.map((run, ri) => renderRun(run, `${String(pi)}.${String(ri)}`))}
        </span>
      ))}
      {layout.invalid !== null && (
        <span className="gd-rich__warn" id={describedById}>
          <Icon name="warning" size={13} />
          <span className="gd-visually-hidden">{INVALID_LABELS[layout.invalid]}</span>
        </span>
      )}
    </span>
  );
});
