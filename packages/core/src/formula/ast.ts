/**
 * Formula grammar (PRD §13, §22; FX-01..FX-03).
 *
 *   formula   := '=' (call | method | list)
 *   call      := name '(' [arg (',' arg)*] ')'          name ∈ { Concat, Sum }
 *   method    := reference '.' method-name [ '.' chip ] '(' [marg (',' marg)*] ')'
 *                                                      method-name ∈ { Extract, Split, Replace,
 *                                                      Format, Concat } — the text algebra on one
 *                                                      cell (PRD §2–§4, §20; REF-04)
 *   chip      := identifier                             `@Row.Extract.Date()` (§9): a Smart Chip
 *                                                      named property-style, same as Extract("date")
 *   marg      := [identifier '='] literal               a named argument: `Extract(Style="Highlight")`
 *   literal   := string | number
 *   arg       := string | number | call | method | reference
 *   list      := (reference | separator)+               at least one reference
 *   reference := address | range | column | entity | bound
 *   bound     := '{' … '}'                             id-bound token, see bound.ts
 *   placeholder := '#REF' | '#hidden'                  a projected reference whose target is gone or
 *                                                      unaddressable; keeps its stored token on re-commit
 *   address   := letters{1,3} digits                     B14
 *   range     := address ':' address                     B2:B14
 *   column    := letters ':' letters                     B:B
 *   entity    := '@' segment ('.' segment)*              @Group.Entity
 *   segment   := identifier | string
 *
 * A *list* is what `=A2, D5` and `=@Group.Entity, @Group.Entity` parse to: the
 * references are evaluated and every run of characters between them is echoed
 * verbatim as separator text (FX-03 "with any typed separator").
 *
 * Every node carries its `span` in the formula text so the editor can outline
 * each operand in its own colour (FX-08) and point at parse errors.
 */
import type { CellRange, CellRef } from '../address.js';
import type { BoundReference } from './bound.js';

export interface Span {
  /** Offset of the first character, counting the leading `=` as offset 0. */
  readonly start: number;
  /** Offset one past the last character. */
  readonly end: number;
}

export interface AddressRef {
  readonly kind: 'address';
  readonly ref: CellRef;
  readonly span: Span;
}

export interface RangeRef {
  readonly kind: 'range';
  readonly range: CellRange;
  readonly span: Span;
}

export interface ColumnRefNode {
  readonly kind: 'column';
  readonly col: number;
  readonly span: Span;
}

export interface EntityRef {
  readonly kind: 'entity';
  /** Dotted path segments, unquoted. `@Group.Entity` → `['Group', 'Entity']`. */
  readonly path: readonly string[];
  readonly span: Span;
}

/** A reference already bound to ids (the stored form; see bound.ts). */
export interface BoundRef {
  readonly kind: 'bound';
  readonly ref: BoundReference;
  readonly span: Span;
}

/**
 * `#REF` / `#hidden` as the editor shows them. On commit the binder swaps a
 * placeholder for the token the cell already held at that operand; one with
 * no token behind it evaluates to `⚠ reference removed`.
 */
export interface PlaceholderRef {
  readonly kind: 'placeholder';
  readonly label: 'REF' | 'hidden';
  readonly span: Span;
}

export type Reference =
  AddressRef | RangeRef | ColumnRefNode | EntityRef | BoundRef | PlaceholderRef;

export interface StringLiteral {
  readonly kind: 'string';
  readonly value: string;
  readonly span: Span;
}

export interface NumberLiteral {
  readonly kind: 'number';
  readonly value: number;
  readonly span: Span;
}

export type FunctionName = 'Concat' | 'Sum';

export interface CallExpr {
  readonly kind: 'call';
  readonly name: FunctionName;
  readonly args: readonly Expr[];
  readonly span: Span;
}

/**
 * The text-algebra methods a reference can carry — the PRD's set (§2 Replace,
 * §3 Extract, §4 Split, §20 "Split, Replace, Extract, Concat", §22 Format
 * presets; REF-04, HIER-07). `Split` yields a list that renders as child rows.
 */
export const METHOD_NAMES = ['Extract', 'Split', 'Replace', 'Format', 'Concat'] as const;
export type MethodName = (typeof METHOD_NAMES)[number];

export function isMethodName(value: string): value is MethodName {
  return (METHOD_NAMES as readonly string[]).includes(value);
}

/** A method argument: a literal, optionally named (`Style="Highlight"`). */
export type MethodArg = (StringLiteral | NumberLiteral) & { readonly name?: string | undefined };

/** `@Notes.Extract("x")`, `B5.Split(", ")` — one reference, one method, literal arguments. */
export interface MethodCall {
  readonly kind: 'method';
  readonly target: Reference;
  readonly name: MethodName;
  readonly args: readonly MethodArg[];
  readonly span: Span;
}

export type Expr = Reference | StringLiteral | NumberLiteral | CallExpr | MethodCall;

export interface Separator {
  readonly kind: 'separator';
  readonly text: string;
  readonly span: Span;
}

export interface ListExpr {
  readonly kind: 'list';
  readonly items: readonly (Reference | Separator)[];
  readonly span: Span;
}

export type Ast = CallExpr | MethodCall | ListExpr;

export interface ParseError {
  readonly message: string;
  readonly span: Span;
}

export function isReference(node: Expr | Separator): node is Reference {
  return (
    node.kind === 'address' ||
    node.kind === 'range' ||
    node.kind === 'column' ||
    node.kind === 'entity' ||
    node.kind === 'bound' ||
    node.kind === 'placeholder'
  );
}

/**
 * Every reference the formula reads, in operand order (depth-first through
 * nested calls). The index in the returned array is the operand index FX-08
 * colours by.
 */
export function references(ast: Ast): Reference[] {
  const out: Reference[] = [];
  const visit = (node: Expr | Separator): void => {
    if (isReference(node)) {
      out.push(node);
    } else if (node.kind === 'call') {
      for (const arg of node.args) visit(arg);
    } else if (node.kind === 'method') {
      out.push(node.target);
    }
  };
  if (ast.kind === 'list') {
    for (const item of ast.items) visit(item);
  } else {
    visit(ast);
  }
  return out;
}
