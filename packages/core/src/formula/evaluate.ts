/**
 * Formula evaluation (FX-01, FX-02, FX-03, FX-06).
 *
 * The evaluator is pure: it reads cell values through a `Resolver` the caller
 * supplies and returns a `Result`. It runs the same in a Web Worker and in
 * Node. Formatting for display (locale digits, currency symbols) is not done
 * here — the renderer owns `Intl`; `Concat` uses the optional `formatValue`
 * hook so a worker can inject the active locale.
 */
import { formatAddress, cellsInRange, type CellRef } from '../address.js';
import { err, ok, type Result } from '../result.js';
import type { Ast, Expr, MethodCall, Reference, Separator } from './ast.js';
import type { BoundReference } from './bound.js';
import { applyMethod } from './methods.js';
import { richFromText, type RichDoc } from '../text/types.js';

export type CellValue =
  /** `rich` carries the cell's marks when it has any, so `Extract(Style=…)` can read them. */
  | { readonly kind: 'text'; readonly text: string; readonly rich?: RichDoc | undefined }
  /** `text` is the cell's own spelling ("1,200") so Concat and lists echo it, not `String(value)`. */
  | { readonly kind: 'number'; readonly value: number; readonly text?: string }
  | {
      readonly kind: 'currency';
      readonly value: number;
      readonly code: string;
      readonly text?: string;
    }
  | { readonly kind: 'date'; readonly iso: string; readonly text?: string }
  | { readonly kind: 'blank' }
  /** `Split()` pieces (HIER-07): each renders as a child row; as text they read joined by `, `. */
  | { readonly kind: 'list'; readonly items: readonly CellValue[] }
  /** A referenced formula cell that is itself in error. Its error propagates (FX-06). */
  | { readonly kind: 'error'; readonly error: FormulaError };

export type FormulaError =
  /** `⚠ text in range` — a Sum operand holds text (or a date). `address` names the offender (FX-02). */
  | { readonly kind: 'text-in-range'; readonly address: string }
  /** `⚠ mixed currencies` — Sum across two currency codes is an error, not a conversion (§22). */
  | {
      readonly kind: 'mixed-currency';
      readonly address: string;
      readonly codes: readonly [string, string];
    }
  /** `⚠ circular` — the depth guard tripped (FX-06). */
  | { readonly kind: 'circular' }
  /** `⚠ unknown reference` — an `@` path resolves to nothing. */
  | { readonly kind: 'unknown-entity'; readonly path: string }
  /** `⚠ reference removed` — a bound cell, row, column or table was deleted (PRD §20 id semantics). */
  | { readonly kind: 'reference-removed'; readonly label: string }
  /** `⚠ invalid argument` — e.g. a quoted string inside Sum. */
  | { readonly kind: 'invalid-argument'; readonly message: string };

/** How the evaluator reads the workbook. Implemented over the Yjs document by the app. */
export interface Resolver {
  /** Value at a lattice address, or `undefined` for a cell that is not inside any table. */
  valueAt(ref: CellRef, depth: number): CellValue | undefined;
  /** Value of an `@` entity path, or `undefined` when the path does not resolve. */
  entity(path: readonly string[], depth: number): CellValue | undefined;
  /** Every populated cell in a lattice column, with its lattice row, for `=Sum(B:B)`. */
  columnValues(
    col: number,
    depth: number,
  ): readonly { readonly row: number; readonly value: CellValue }[];
  /**
   * The cells an id-bound reference reads, each with its current A1 label
   * (for error messages), or `undefined` when a bound target no longer exists.
   */
  bound(ref: BoundReference, depth: number): readonly BoundOperand[] | undefined;
}

export interface BoundOperand {
  /** The cell's current address (or `#REF`-style label), for `text-in-range` messages. */
  readonly address: string;
  readonly value: CellValue;
}

export interface EvaluateOptions {
  /** Nesting depth of this evaluation; a resolver that evaluates a referenced formula passes `depth + 1`. */
  readonly depth?: number;
  /** Depth at which evaluation reports `circular`. */
  readonly maxDepth?: number;
  /** Text form of a value for Concat and lists. Defaults to a locale-neutral rendering. */
  readonly formatValue?: (value: CellValue) => string;
  /** BCP 47 tag of the active locale, for `Format` case presets (I18N). */
  readonly locale?: string | undefined;
}

export const DEFAULT_MAX_DEPTH = 64;

export type EvaluateResult = Result<CellValue, FormulaError>;

/** User-facing label for an error, per PRD §13/§22 wording. */
export function errorLabel(error: FormulaError): string {
  switch (error.kind) {
    case 'text-in-range':
      return '⚠ text in range';
    case 'mixed-currency':
      return '⚠ mixed currencies';
    case 'circular':
      return '⚠ circular';
    case 'unknown-entity':
      return '⚠ unknown reference';
    case 'reference-removed':
      return '⚠ reference removed';
    case 'invalid-argument':
      return '⚠ invalid argument';
  }
}

export function defaultFormatValue(value: CellValue): string {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'number':
      return value.text ?? String(value.value);
    case 'currency':
      return value.text ?? `${value.code} ${String(value.value)}`;
    case 'date':
      return value.text ?? value.iso;
    case 'blank':
      return '';
    case 'list':
      return value.items.map(defaultFormatValue).join(', ');
    case 'error':
      return errorLabel(value.error);
  }
}

class EvalFailure extends Error {
  constructor(readonly formulaError: FormulaError) {
    super(formulaError.kind);
  }
}

function fail(error: FormulaError): never {
  throw new EvalFailure(error);
}

function entityText(path: readonly string[]): string {
  return `@${path.join('.')}`;
}

function boundLabel(ref: BoundReference): string {
  switch (ref.kind) {
    case 'cell':
      return ref.spelling === 'entity' ? 'an @ path' : 'a cell';
    case 'range':
      return 'a range';
    case 'column':
      return 'a column';
  }
}

interface Operand {
  readonly address: string;
  readonly value: CellValue;
}

class Evaluator {
  private readonly depth: number;
  private readonly format: (value: CellValue) => string;
  private readonly locale: string | undefined;

  constructor(
    private readonly resolver: Resolver,
    options: EvaluateOptions,
  ) {
    this.depth = options.depth ?? 0;
    this.format = options.formatValue ?? defaultFormatValue;
    this.locale = options.locale;
  }

  evaluate(ast: Ast): CellValue {
    if (ast.kind === 'call') return this.call(ast);
    if (ast.kind === 'method') return this.method(ast);
    return { kind: 'text', text: ast.items.map((item) => this.listItemText(item)).join('') };
  }

  /**
   * `reference.Method(args)`: the text algebra on the first cell the reference
   * names (REF-04), over its rich text when the cell carries marks.
   */
  private method(node: MethodCall): CellValue {
    const first = this.operands(node.target)[0];
    const value = first === undefined ? { kind: 'blank' as const } : this.unwrap(first.value);
    const doc =
      value.kind === 'text' && value.rich !== undefined
        ? value.rich
        : richFromText(this.format(value));
    const outcome = applyMethod(
      node.name,
      node.args.map((a) => ({ value: a.value, name: a.name })),
      doc,
      this.locale,
    );
    if (!outcome.ok) fail(outcome.error);
    return outcome.value;
  }

  private listItemText(item: Reference | Separator): string {
    if (item.kind === 'separator') return item.text;
    return this.operands(item)
      .map((o) => this.format(this.unwrap(o.value)))
      .join(', ');
  }

  private call(node: Expr & { kind: 'call' }): CellValue {
    switch (node.name) {
      case 'Concat':
        return { kind: 'text', text: node.args.map((arg) => this.textOf(arg)).join('') };
      case 'Sum':
        return this.sum(node.args);
    }
  }

  /** Text of a Concat argument: literal, nested call, or the values a reference yields. */
  private textOf(arg: Expr): string {
    switch (arg.kind) {
      case 'string':
        return arg.value;
      case 'number':
        return this.format({ kind: 'number', value: arg.value });
      case 'call':
        return this.format(this.call(arg));
      case 'method':
        return this.format(this.method(arg));
      default:
        return this.operands(arg)
          .map((o) => this.format(this.unwrap(o.value)))
          .join(', ');
    }
  }

  private sum(args: readonly Expr[]): CellValue {
    // Kept in an object so the closure's writes are visible to the narrowing below.
    const acc: { total: number; code: string | null } = { total: 0, code: null };
    const add = (address: string, value: CellValue): void => {
      switch (value.kind) {
        case 'blank':
          return;
        case 'number':
          acc.total += value.value;
          return;
        case 'currency':
          if (acc.code !== null && acc.code !== value.code) {
            fail({ kind: 'mixed-currency', address, codes: [acc.code, value.code] });
          }
          acc.code = value.code;
          acc.total += value.value;
          return;
        case 'text':
        case 'date':
        case 'list':
          fail({ kind: 'text-in-range', address });
          break;
        case 'error':
          fail(value.error);
      }
    };
    for (const arg of args) {
      switch (arg.kind) {
        case 'number':
          acc.total += arg.value;
          break;
        case 'string':
          fail({
            kind: 'invalid-argument',
            message: 'Sum takes addresses, ranges, columns or @ paths, not text',
          });
          break;
        case 'call':
          add(`${arg.name}(…)`, this.call(arg));
          break;
        case 'method':
          add(`${arg.name}(…)`, this.method(arg));
          break;
        default:
          for (const o of this.operands(arg)) add(o.address, o.value);
      }
    }
    return acc.code === null
      ? { kind: 'number', value: acc.total }
      : { kind: 'currency', value: acc.total, code: acc.code };
  }

  /** A referenced formula cell in error propagates its error. */
  private unwrap(value: CellValue): CellValue {
    if (value.kind === 'error') fail(value.error);
    return value;
  }

  /** Resolve a reference to the (address, value) pairs it covers, in row-major order. */
  private operands(ref: Reference): Operand[] {
    switch (ref.kind) {
      case 'address':
        return [
          {
            address: formatAddress(ref.ref),
            value: this.resolver.valueAt(ref.ref, this.depth) ?? { kind: 'blank' },
          },
        ];
      case 'range':
        return cellsInRange(ref.range).map((cell) => ({
          address: formatAddress(cell),
          value: this.resolver.valueAt(cell, this.depth) ?? { kind: 'blank' },
        }));
      case 'column':
        return this.resolver.columnValues(ref.col, this.depth).map((entry) => ({
          address: formatAddress({ col: ref.col, row: entry.row }),
          value: entry.value,
        }));
      case 'entity': {
        const value = this.resolver.entity(ref.path, this.depth);
        if (value === undefined) fail({ kind: 'unknown-entity', path: entityText(ref.path) });
        return [{ address: entityText(ref.path), value }];
      }
      case 'bound': {
        const operands = this.resolver.bound(ref.ref, this.depth);
        if (operands === undefined) {
          fail({ kind: 'reference-removed', label: boundLabel(ref.ref) });
        }
        return operands.map((o) => ({ address: o.address, value: o.value }));
      }
      case 'placeholder':
        // A placeholder that no stored token stood behind: the target is gone.
        fail({ kind: 'reference-removed', label: 'a cell' });
    }
  }
}

/**
 * Evaluate a parsed formula. Never throws for formula-level failures; resolver
 * exceptions propagate. When `options.depth` exceeds `maxDepth` the result is
 * `circular` — a resolver that evaluates referenced formulas recursively must
 * pass `depth + 1` so a reference loop terminates here.
 */
export function evaluate(
  ast: Ast,
  resolver: Resolver,
  options: EvaluateOptions = {},
): EvaluateResult {
  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (depth > maxDepth) return err({ kind: 'circular' });
  try {
    return ok(new Evaluator(resolver, options).evaluate(ast));
  } catch (e) {
    if (e instanceof EvalFailure) return err(e.formulaError);
    throw e;
  }
}
