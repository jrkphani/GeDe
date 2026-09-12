/**
 * What a cell shows at rest, computed without ProseMirror: the marked runs
 * of its text, formatted under the column's data format for the active
 * locale (FMT-01..05, I18N-03/04). Pure, so `CellContent` stays a thin map
 * from this to DOM and the benchmark can measure the two apart.
 */
import {
  detectIndicLang,
  format as formatText,
  marksAt,
  plainText,
  renderValue,
  resolveValue,
  richFromText,
  type CellFormat,
  type FormatLocale,
  type IndicLang,
  type InvalidKind,
  type Mark,
  type RichDoc,
} from '@gede/core';

export interface Run {
  readonly text: string;
  readonly marks: readonly Mark[];
}

export interface CellLayout {
  /** One entry per paragraph; each a list of marked runs. */
  readonly paragraphs: readonly (readonly Run[])[];
  /** Numbers and currencies right (FMT-02, FMT-03); everything else left. */
  readonly align: 'left' | 'right';
  /** FMT-05: text that does not parse under an explicit format. */
  readonly invalid: InvalidKind | null;
  /** I18N-03: set as `lang` on the cell so the Noto fallback and 1.7 line-height apply. */
  readonly lang: IndicLang | null;
  /** The displayed text, for `title` and the accessible name. */
  readonly text: string;
}

const EMPTY_LAYOUT: CellLayout = {
  paragraphs: [[]],
  align: 'left',
  invalid: null,
  lang: null,
  text: '',
};

function runsOf(doc: RichDoc): (readonly Run[])[] {
  return doc.content.map((p) =>
    (p.content ?? []).map((n) => ({ text: n.text, marks: n.marks ?? [] })),
  );
}

export function layoutCell(
  content: RichDoc | string,
  format: CellFormat,
  locale: FormatLocale,
): CellLayout {
  const doc = typeof content === 'string' ? richFromText(content) : content;
  const plain = plainText(doc);
  if (plain === '') return EMPTY_LAYOUT;

  if (format.kind === 'text') {
    const preset = format.opts.textCase;
    const shown = preset === undefined ? doc : formatText(doc, preset, locale);
    const text = plainText(shown);
    return {
      paragraphs: runsOf(shown),
      align: 'left',
      invalid: null,
      lang: detectIndicLang(text),
      text,
    };
  }

  const value = resolveValue(plain, format);
  if (format.kind === 'auto') {
    // FMT-01: Automatic shows the text as typed — `2026` is not `2,026`, `007` is not `7` —
    // and only aligns right when it parses; grouping and decimals are an explicit format's.
    const numeric = value.kind === 'number' || value.kind === 'currency';
    return {
      paragraphs: runsOf(doc),
      align: numeric ? 'right' : 'left',
      invalid: null,
      lang: detectIndicLang(plain),
      text: plain,
    };
  }
  const rendered = renderValue(value, format, locale);
  switch (value.kind) {
    case 'number':
    case 'currency':
    case 'date':
      // The formatted text replaces the typed text; it keeps the marks the text began with.
      return {
        paragraphs: [[{ text: rendered.text, marks: marksAt(doc, 0) }]],
        align: rendered.align,
        invalid: null,
        lang: detectIndicLang(rendered.text),
        text: rendered.text,
      };
    case 'invalid':
      return {
        paragraphs: runsOf(doc),
        align: 'left',
        invalid: value.expected,
        lang: detectIndicLang(plain),
        text: plain,
      };
    default:
      return {
        paragraphs: runsOf(doc),
        align: 'left',
        invalid: null,
        lang: detectIndicLang(plain),
        text: plain,
      };
  }
}

export const INVALID_LABELS: Readonly<Record<InvalidKind, string>> = {
  number: 'Not a number',
  currency: 'Not an amount',
  date: 'Not a date',
};
