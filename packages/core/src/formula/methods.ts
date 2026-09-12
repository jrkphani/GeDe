/**
 * The text-algebra methods a reference can carry (PRD §2 Replace, §3
 * format-aware Extract, §4 Split, §20 "Split, Replace, Extract, Concat",
 * §22 Format presets; REF-04, HIER-07). One cell's rich text in — marks and
 * all, so `Extract(Style="Highlight")` can read them — a value out. The
 * algebra itself lives in `text/algebra.ts`; this module only maps method
 * arguments onto it. Regular expressions are checked with `isRe2Safe`
 * before they run, and they run where the evaluator runs — in the Worker.
 * `Format` case presets go through `Intl` for the active locale.
 *
 * Errors are values (`invalid-argument`), never exceptions.
 */
import { err, ok, type Result } from '../result.js';
import {
  concat as concatDocs,
  extract,
  format,
  replace,
  split,
  type Pattern,
  type TextPreset,
} from '../text/algebra.js';
import { CHIP_IDS, chipRegExp, isRe2Safe, type ChipId } from '../text/chips.js';
import {
  HIGHLIGHT_TOKENS,
  isToggleMark,
  plainText,
  richFromText,
  type Mark,
  type RichDoc,
} from '../text/types.js';
import type { MethodName } from './ast.js';
import type { CellValue, FormulaError } from './evaluate.js';

/** An argument as the evaluator hands it over: its value and, when written `Name=…`, its name. */
export interface MethodArgValue {
  readonly value: string | number;
  readonly name?: string | undefined;
}

/** What the inspector shows for each method: argument labels and a hint (REF-04). */
export interface MethodSignature {
  readonly name: MethodName;
  readonly hint: string;
  readonly args: readonly { readonly label: string; readonly placeholder: string }[];
}

export const METHOD_SIGNATURES: readonly MethodSignature[] = [
  {
    name: 'Extract',
    hint: 'Matching text into a new column: a chip name, a /pattern/, literal text, or a style',
    args: [{ label: 'Pattern', placeholder: 'Country, /\\(([^)]*)\\)/ or "Ltd"' }],
  },
  {
    name: 'Split',
    hint: 'Cut at a delimiter; the pieces render as child rows',
    args: [{ label: 'Delimiter', placeholder: '", " or ". "' }],
  },
  {
    name: 'Replace',
    hint: 'Substitute every occurrence of a target',
    args: [
      { label: 'Target', placeholder: 'text to find' },
      { label: 'Replacement', placeholder: 'text to insert' },
    ],
  },
  {
    name: 'Format',
    hint: 'Case and whitespace presets, in the active locale',
    args: [{ label: 'Preset', placeholder: 'Title Case, UPPERCASE, lowercase or Trimmed' }],
  },
  {
    name: 'Concat',
    hint: 'Join the cell with literal text, end to end',
    args: [{ label: 'Text', placeholder: '" (draft)"' }],
  },
];

export const FORMAT_PRESETS: readonly { readonly label: string; readonly kind: TextPreset }[] = [
  { label: 'Title Case', kind: 'titleCase' },
  { label: 'UPPERCASE', kind: 'upper' },
  { label: 'lowercase', kind: 'lower' },
  { label: 'Trimmed', kind: 'trimmed' },
];

/** The styles `Extract(Style=…)` understands: a highlight (any tint, or one) or an inline mark. */
export const EXTRACT_STYLES = [
  'Highlight',
  'Highlight:amber',
  'Highlight:forest',
  'Highlight:slate',
  'Bold',
  'Italic',
  'Underline',
  'Strikethrough',
] as const;

function presetOf(arg: string): TextPreset | null {
  const wanted = arg.trim().toLowerCase().replace(/\s+/gu, '');
  for (const p of FORMAT_PRESETS) {
    if (p.kind.toLowerCase() === wanted || p.label.toLowerCase().replace(/\s+/gu, '') === wanted) {
      return p.kind;
    }
  }
  return null;
}

/** A chip by name, case-insensitively (`afterDash`, `AfterDash` and the parser's `afterdash` all count). */
export function chipOf(arg: string): ChipId | null {
  const wanted = arg.trim().toLowerCase();
  return CHIP_IDS.find((id) => id.toLowerCase() === wanted) ?? null;
}

/** `/…/` or `/…/flags` → a regex; a chip name → its pattern; anything else → literal text. */
export function patternOf(arg: string): Result<Pattern, FormulaError> {
  const m = /^\/(.+)\/([a-z]*)$/su.exec(arg);
  if (m !== null) {
    const source = m[1] ?? '';
    const flags = (m[2] ?? '').replace(/[gd]/gu, '');
    const check = isRe2Safe(source, flags.includes('u') ? flags : `${flags}u`);
    if (!check.ok) return err({ kind: 'invalid-argument', message: check.reason });
    return ok(new RegExp(source, flags.includes('u') ? flags : `${flags}u`));
  }
  const chip = chipOf(arg);
  if (chip !== null) return ok(chipRegExp(chip));
  if (arg === '') return err({ kind: 'invalid-argument', message: 'Extract needs a pattern' });
  return ok(arg);
}

/** Colour words people write for the highlight tints the design system names. */
const HIGHLIGHT_ALIASES: Readonly<Record<string, string>> = {
  yellow: 'amber',
  amber: 'amber',
  green: 'forest',
  forest: 'forest',
  grey: 'slate',
  gray: 'slate',
  slate: 'slate',
};

/** A predicate over a text node's marks for `Style=…`, or an error for an unknown style. */
function styleOf(style: string): Result<(marks: readonly Mark[]) => boolean, FormulaError> {
  const [kind = '', tint = ''] = style.trim().split(':');
  const wanted = kind.toLowerCase();
  if (wanted === 'highlight') {
    const token = tint === '' ? null : HIGHLIGHT_ALIASES[tint.trim().toLowerCase()];
    if (tint !== '' && token === undefined) {
      return err({
        kind: 'invalid-argument',
        message: `Highlight tints are ${HIGHLIGHT_TOKENS.join(', ')} (yellow, green, grey)`,
      });
    }
    return ok((marks) =>
      marks.some((m) => m.type === 'highlight' && (token === null || m.attrs.token === token)),
    );
  }
  if (isToggleMark(wanted)) return ok((marks) => marks.some((m) => m.type === wanted));
  return err({
    kind: 'invalid-argument',
    message: 'Style takes Highlight, Highlight:Yellow, Bold, Italic, Underline or Strikethrough',
  });
}

/**
 * The runs of text that carry a style, each as its own piece (PRD §3
 * "Extract(Style="Highlight:Yellow") pulls only highlighted terms"). Runs
 * that touch inside one paragraph join; a paragraph break ends a run.
 */
export function extractByStyle(doc: RichDoc, keep: (marks: readonly Mark[]) => boolean): string[] {
  const out: string[] = [];
  for (const p of doc.content) {
    let run = '';
    for (const node of p.content ?? []) {
      if (keep(node.marks ?? [])) {
        run += node.text;
      } else if (run !== '') {
        out.push(run);
        run = '';
      }
    }
    if (run !== '') out.push(run);
  }
  return out.map((r) => r.trim()).filter((r) => r !== '');
}

function positional(args: readonly MethodArgValue[]): (string | number)[] {
  return args.filter((a) => a.name === undefined).map((a) => a.value);
}

function stringAt(values: readonly (string | number)[], i: number): string {
  const v = values[i];
  return v === undefined ? '' : String(v);
}

function named(args: readonly MethodArgValue[], name: string): string | undefined {
  const hit = args.find((a) => a.name?.toLowerCase() === name.toLowerCase());
  return hit === undefined ? undefined : String(hit.value);
}

/**
 * Apply `name(args)` to one cell's rich text. `Split` yields a list (each
 * piece a child row, HIER-07); everything else text.
 */
export function applyMethod(
  name: MethodName,
  args: readonly MethodArgValue[],
  doc: RichDoc,
  locale?: string,
): Result<CellValue, FormulaError> {
  const plain = positional(args);
  switch (name) {
    case 'Extract': {
      const style = named(args, 'Style');
      if (style !== undefined) {
        const keep = styleOf(style);
        if (!keep.ok) return keep;
        return ok({ kind: 'text', text: extractByStyle(doc, keep.value).join(', ') });
      }
      const pattern = patternOf(stringAt(plain, 0));
      if (!pattern.ok) return pattern;
      const pieces = extract(doc, pattern.value).map((d) => plainText(d).trim());
      return ok({ kind: 'text', text: pieces.filter((p) => p !== '').join(', ') });
    }
    case 'Split': {
      const delimiter = stringAt(plain, 0);
      if (delimiter === '') {
        return err({ kind: 'invalid-argument', message: 'Split needs a delimiter' });
      }
      const items: CellValue[] = split(doc, delimiter)
        .map((d) => plainText(d).trim())
        .filter((p) => p !== '')
        .map((p) => ({ kind: 'text', text: p }));
      return ok({ kind: 'list', items });
    }
    case 'Replace': {
      const target = stringAt(plain, 0);
      if (target === '')
        return err({ kind: 'invalid-argument', message: 'Replace needs a target' });
      return ok({ kind: 'text', text: plainText(replace(doc, target, stringAt(plain, 1))) });
    }
    case 'Format': {
      const preset = presetOf(stringAt(plain, 0));
      if (preset === null) {
        return err({
          kind: 'invalid-argument',
          message: 'Format takes Title Case, UPPERCASE, lowercase or Trimmed',
        });
      }
      return ok({ kind: 'text', text: plainText(format(doc, preset, locale)) });
    }
    case 'Concat': {
      const pieces = [doc, ...plain.map((p) => richFromText(String(p)))];
      return ok({ kind: 'text', text: plainText(concatDocs(pieces)) });
    }
  }
}

/** `Method("a", Style="b")` — the signature text the header and the inspector show. */
export function formatMethodCall(name: MethodName, args: readonly MethodArgValue[]): string {
  const rendered = args.map((a) => {
    const value =
      typeof a.value === 'number'
        ? String(a.value)
        : `"${a.value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
    return a.name === undefined ? value : `${a.name}=${value}`;
  });
  return `${name}(${rendered.join(', ')})`;
}
