/**
 * Formula grammar (PRD §13, §22; FX-01..FX-03).
 *
 *   formula   := '=' (call | list)
 *   call      := name '(' [arg (',' arg)*] ')'          name ∈ { Concat, Sum }
 *   arg       := string | number | call | reference
 *   list      := (reference | separator)+               at least one reference
 *   reference := address | range | column | entity | bound
 *   bound     := '{' … '}'                             id-bound token, see bound.ts
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

export type Reference = AddressRef | RangeRef | ColumnRefNode | EntityRef | BoundRef;

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

export type Expr = Reference | StringLiteral | NumberLiteral | CallExpr;

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

export type Ast = CallExpr | ListExpr;

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
    node.kind === 'bound'
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
    }
  };
  if (ast.kind === 'call') {
    for (const arg of ast.args) visit(arg);
  } else {
    for (const item of ast.items) visit(item);
  }
  return out;
}
