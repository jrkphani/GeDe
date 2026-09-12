/**
 * Recursive-descent parser for the formula grammar in `ast.ts`. Never throws:
 * every failure is a `ParseError` with the span the editor should underline.
 */
import { columnIndex, normaliseRange, type CellRef } from '../address.js';
import { err, ok, type Result } from '../result.js';
import {
  isMethodName,
  type Ast,
  type BoundRef,
  type CallExpr,
  type PlaceholderRef,
  type EntityRef,
  type Expr,
  type FunctionName,
  type ListExpr,
  type MethodArg,
  type MethodCall,
  type ParseError,
  type Reference,
  type Separator,
  type Span,
} from './ast.js';
import { chipOf } from './methods.js';
import { tokenize, type Token } from './tokenizer.js';

const ADDRESS_RE = /^([A-Za-z]{1,3})([1-9][0-9]{0,6})$/;
const LETTERS_RE = /^[A-Za-z]{1,3}$/;

const FUNCTION_NAMES: ReadonlyMap<string, FunctionName> = new Map([
  ['concat', 'Concat'],
  ['sum', 'Sum'],
]);

class ParseFailure extends Error {
  constructor(readonly parseError: ParseError) {
    super(parseError.message);
  }
}

function fail(message: string, span: Span): never {
  throw new ParseFailure({ message, span });
}

function addressOf(text: string): CellRef | null {
  const m = ADDRESS_RE.exec(text);
  if (!m) return null;
  return { col: columnIndex(m[1] ?? ''), row: Number(m[2]) - 1 };
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly text: string,
  ) {}

  private peek(offset = 0): Token {
    const t = this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
    if (t === undefined) throw new Error('token stream is empty');
    return t;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos += 1;
    return t;
  }

  private skipSpace(): void {
    while (this.peek().kind === 'space') this.pos += 1;
  }

  /** The token after any run of spaces, without consuming. */
  private peekPastSpace(from = 0): Token {
    let i = from;
    while (this.peek(i).kind === 'space') i += 1;
    return this.peek(i);
  }

  parseFormula(): Ast {
    const first = this.peek();
    if (first.kind !== 'equals' || first.span.start !== 0) {
      fail('a formula starts with =', { start: 0, end: Math.max(1, first.span.end) });
    }
    this.next();
    this.skipSpace();
    const head = this.peek();
    if (head.kind === 'ident' && this.peekPastSpace(1).kind === 'lparen') {
      const call = this.parseCall();
      this.skipSpace();
      const tail = this.peek();
      if (tail.kind !== 'eof') {
        fail('unexpected text after the closing )', {
          start: tail.span.start,
          end: this.text.length,
        });
      }
      return call;
    }
    if (head.kind === 'eof') {
      fail('type a cell address, an @ reference, or a function', {
        start: 0,
        end: this.text.length,
      });
    }
    // `=@Notes.Extract("x")` / `=B5.Split(", ")`: one reference carrying a method (REF-04).
    const save = this.pos;
    if (this.startsReference()) {
      const ref = this.parseReferenceHead();
      if (this.atMethod()) {
        const method = this.parseMethod(ref);
        this.skipSpace();
        const tail = this.peek();
        if (tail.kind !== 'eof') {
          fail('unexpected text after the closing )', {
            start: tail.span.start,
            end: this.text.length,
          });
        }
        return method;
      }
    }
    this.pos = save;
    return this.parseList();
  }

  /** A reference at the current token (the caller checked `startsReference`). */
  private parseReferenceHead(): Reference {
    const head = this.peek().kind;
    return head === 'at'
      ? this.parseEntity()
      : head === 'bound'
        ? this.parseBound()
        : head === 'placeholder'
          ? this.parsePlaceholder()
          : this.parseCellReference();
  }

  /** `.Method(` follows: the reference carries a text-algebra method. */
  private atMethod(): boolean {
    if (this.peek().kind !== 'dot' || this.peek(1).kind !== 'ident') return false;
    if (!isMethodName(this.peek(1).text)) return false;
    if (this.peekPastSpace(2).kind === 'lparen') return true;
    // `Extract.Date()` — a chip named property-style (PRD §9).
    return (
      this.peek(2).kind === 'dot' &&
      this.peek(3).kind === 'ident' &&
      this.peekPastSpace(4).kind === 'lparen'
    );
  }

  private parseMethod(target: Reference): MethodCall {
    this.next(); // dot
    const nameToken = this.next();
    const name = nameToken.text;
    if (!isMethodName(name)) fail(`unknown method ${name}`, nameToken.span);
    const args: MethodArg[] = [];
    if (this.peek().kind === 'dot') {
      // `Extract.Date()`: the chip is the method's first argument.
      this.next();
      const chip = this.next();
      if (name !== 'Extract')
        fail(`${name} takes no property; only Extract.Chip() does`, chip.span);
      const id = chipOf(chip.text);
      if (id === null) fail(`unknown chip ${chip.text}`, chip.span);
      args.push({ kind: 'string', value: id, span: chip.span });
    }
    this.skipSpace();
    const open = this.next();
    if (open.kind !== 'lparen') fail('expected (', open.span);
    this.skipSpace();
    if (this.peek().kind === 'rparen') {
      const close = this.next();
      return {
        kind: 'method',
        target,
        name,
        args,
        span: { start: target.span.start, end: close.span.end },
      };
    }
    for (;;) {
      this.skipSpace();
      // A named argument: `Style="Highlight:Yellow"`.
      let argName: string | undefined;
      if (this.peek().kind === 'ident' && this.peekPastSpace(1).kind === 'equals') {
        argName = this.next().text;
        this.skipSpace();
        this.next(); // =
        this.skipSpace();
      }
      const t = this.peek();
      const start = argName === undefined ? t.span.start : t.span.start;
      if (t.kind === 'string') {
        this.next();
        args.push({
          kind: 'string',
          value: typeof t.value === 'string' ? t.value : '',
          span: { start, end: t.span.end },
          ...(argName === undefined ? {} : { name: argName }),
        });
      } else if (t.kind === 'number') {
        this.next();
        args.push({
          kind: 'number',
          value: Number(t.value ?? 0),
          span: { start, end: t.span.end },
          ...(argName === undefined ? {} : { name: argName }),
        });
      } else {
        fail(`${name} takes quoted text or a number`, t.span);
      }
      this.skipSpace();
      const sep = this.next();
      if (sep.kind === 'comma') continue;
      if (sep.kind === 'rparen') {
        return {
          kind: 'method',
          target,
          name,
          args,
          span: { start: target.span.start, end: sep.span.end },
        };
      }
      if (sep.kind === 'eof') {
        fail('missing closing )', { start: open.span.start, end: this.text.length });
      }
      fail('expected , or )', sep.span);
    }
  }

  /** A reference argument, with its method when one follows. */
  private parseReferenceArg(): Expr {
    const ref = this.parseReferenceHead();
    return this.atMethod() ? this.parseMethod(ref) : ref;
  }

  private parseCall(): CallExpr {
    const nameToken = this.next();
    const name = FUNCTION_NAMES.get(nameToken.text.toLowerCase());
    if (name === undefined) {
      fail(`unknown function ${nameToken.text}; use Concat or Sum`, nameToken.span);
    }
    this.skipSpace();
    const open = this.next();
    if (open.kind !== 'lparen') fail('expected (', open.span);
    const args: Expr[] = [];
    this.skipSpace();
    if (this.peek().kind === 'rparen') {
      const close = this.next();
      return {
        kind: 'call',
        name,
        args,
        span: { start: nameToken.span.start, end: close.span.end },
      };
    }
    for (;;) {
      this.skipSpace();
      args.push(this.parseArg());
      this.skipSpace();
      const t = this.next();
      if (t.kind === 'comma') continue;
      if (t.kind === 'rparen') {
        return { kind: 'call', name, args, span: { start: nameToken.span.start, end: t.span.end } };
      }
      if (t.kind === 'eof')
        fail('missing closing )', { start: open.span.start, end: this.text.length });
      fail('expected , or )', t.span);
    }
  }

  private parseArg(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case 'string':
        this.next();
        return { kind: 'string', value: typeof t.value === 'string' ? t.value : '', span: t.span };
      case 'number':
        this.next();
        return { kind: 'number', value: Number(t.value ?? 0), span: t.span };
      case 'at':
      case 'bound':
      case 'placeholder':
        return this.parseReferenceArg();
      case 'ident':
        if (this.peekPastSpace(1).kind === 'lparen') return this.parseCall();
        return this.parseReferenceArg();
      case 'other':
        if (t.text === '-' && this.peek(1).kind === 'number') {
          this.next();
          const num = this.next();
          return {
            kind: 'number',
            value: -Number(num.value ?? 0),
            span: { start: t.span.start, end: num.span.end },
          };
        }
        break;
      default:
        break;
    }
    fail('expected a cell address, a range, an @ reference, a quoted string or a number', t.span);
  }

  /** address | range | column, starting at an identifier token. */
  private parseCellReference(): Reference {
    const ident = this.next();
    if (
      LETTERS_RE.test(ident.text) &&
      this.peek().kind === 'colon' &&
      this.peek(1).kind === 'ident'
    ) {
      const other = this.peek(1);
      if (other.text.toUpperCase() === ident.text.toUpperCase()) {
        this.next();
        this.next();
        return {
          kind: 'column',
          col: columnIndex(ident.text),
          span: { start: ident.span.start, end: other.span.end },
        };
      }
    }
    const start = addressOf(ident.text);
    if (start === null) {
      fail(`${ident.text} is not a cell address such as B14`, ident.span);
    }
    if (this.peek().kind === 'colon') {
      const endToken = this.peek(1);
      const end = endToken.kind === 'ident' ? addressOf(endToken.text) : null;
      if (end === null) {
        fail('a range is two addresses such as B2:B14', {
          start: ident.span.start,
          end: endToken.span.end,
        });
      }
      this.next();
      this.next();
      return {
        kind: 'range',
        range: normaliseRange({ start, end }),
        span: { start: ident.span.start, end: endToken.span.end },
      };
    }
    return { kind: 'address', ref: start, span: ident.span };
  }

  private parseEntity(): EntityRef {
    const at = this.next();
    const path: string[] = [];
    let end = at.span.end;
    for (;;) {
      const seg = this.peek();
      if (seg.kind === 'ident') {
        path.push(seg.text);
      } else if (seg.kind === 'string') {
        path.push(typeof seg.value === 'string' ? seg.value : '');
      } else {
        fail(path.length === 0 ? 'expected a name after @' : 'expected a name after .', {
          start: at.span.start,
          end: Math.max(seg.span.end, end),
        });
      }
      this.next();
      end = seg.span.end;
      if (this.peek().kind === 'dot' && !this.atMethod()) {
        this.next();
        continue;
      }
      return { kind: 'entity', path, span: { start: at.span.start, end } };
    }
  }

  private parseBound(): BoundRef {
    const t = this.next();
    const ref = t.value;
    if (typeof ref !== 'object') fail('malformed reference token', t.span);
    return { kind: 'bound', ref, span: t.span };
  }

  private parsePlaceholder(): PlaceholderRef {
    const t = this.next();
    return { kind: 'placeholder', label: t.text === '#REF' ? 'REF' : 'hidden', span: t.span };
  }

  /** In list mode a token starts a reference when it is `@`, a bound token, a placeholder, an address, or a column. */
  private startsReference(): boolean {
    const t = this.peek();
    if (t.kind === 'at' || t.kind === 'bound' || t.kind === 'placeholder') return true;
    if (t.kind !== 'ident') return false;
    if (ADDRESS_RE.test(t.text)) return true;
    return (
      LETTERS_RE.test(t.text) &&
      this.peek(1).kind === 'colon' &&
      this.peek(2).kind === 'ident' &&
      this.peek(2).text.toUpperCase() === t.text.toUpperCase()
    );
  }

  private parseList(): ListExpr {
    const items: (Reference | Separator)[] = [];
    const start = this.peek().span.start;
    let referenceCount = 0;
    let sepStart: number | null = null;

    const flushSeparator = (end: number): void => {
      if (sepStart === null) return;
      items.push({
        kind: 'separator',
        text: this.text.slice(sepStart, end),
        span: { start: sepStart, end },
      });
      sepStart = null;
    };

    while (this.peek().kind !== 'eof') {
      if (this.startsReference()) {
        flushSeparator(this.peek().span.start);
        items.push(this.parseReferenceHead());
        referenceCount += 1;
        continue;
      }
      const t = this.next();
      sepStart ??= t.span.start;
    }
    flushSeparator(this.text.length);

    if (referenceCount === 0) {
      fail('expected a cell address such as A2 or an @ reference', {
        start,
        end: this.text.length,
      });
    }
    return { kind: 'list', items, span: { start, end: this.text.length } };
  }
}

/** Parse a formula. `text` includes the leading `=`. Never throws. */
export function parse(text: string): Result<Ast, ParseError> {
  const tokens = tokenize(text);
  if (!tokens.ok) return err(tokens.error);
  try {
    return ok(new Parser(tokens.tokens, text).parseFormula());
  } catch (e) {
    if (e instanceof ParseFailure) return err(e.parseError);
    throw e;
  }
}
