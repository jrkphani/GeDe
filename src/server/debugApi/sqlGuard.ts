// The debug/db inspection API's SELECT-only guard (issue 049, Design brief
// guard #1 of three: "an app-layer SELECT-only parser that rejects anything
// that isn't a lone SELECT/WITH…SELECT — no `;`-chained statements, no
// DML/DDL, no comment-smuggled writes"). This is the critical security
// component of the whole feature: it is the ONLY thing standing between an
// operator's pasted SQL and a live RDS connection before guard #2 (the
// read-only transaction, albAdapter.ts) and guard #3 (the row cap,
// operations.ts) even get a chance to matter.
//
// Approach: a small hand-rolled SQL lexer, not a regex pass over the raw
// string. A naive `sql.split(';').length > 1` or `/\b(INSERT|UPDATE)\b/i`
// check is trivially defeated by a semicolon or keyword hidden inside a
// string literal, a quoted identifier, a line comment, a block comment, or a
// dollar-quoted string — all of which are ordinary, legal SQL. `maskSql`
// below walks the input once, turning every character that is NOT "live" SQL
// syntax (comment bodies, string/identifier contents) into a space, while
// preserving the live syntax (keywords, semicolons, punctuation) verbatim and
// at the same character positions. Every check below then runs against that
// masked string, so it can never mistake a semicolon inside `'a;b'` for a
// statement separator, or `-- DROP TABLE` inside a comment for a real DROP.
export type SqlGuardFailureReason =
  | 'empty_statement'
  | 'not_select'
  | 'multiple_statements'
  | 'forbidden_keyword'
  | 'unterminated_literal'

export type SqlGuardResult =
  | { readonly ok: true; readonly sql: string }
  | { readonly ok: false; readonly reason: SqlGuardFailureReason; readonly message: string }

/**
 * Keywords that never belong in a read-only SELECT/WITH statement. Matched
 * as whole tokens against the masked string (see module doc) — never a raw
 * substring match, so e.g. `OFFSET` never false-positives on `SET`, and
 * `assets` never false-positives on `SET`.
 *
 * `INTO` is included because `SELECT ... INTO new_table` is DDL (creates a
 * table) despite starting with the word SELECT. `UPDATE` alone also catches
 * `SELECT ... FOR UPDATE` (a row-locking clause) as a side effect — which is
 * fine, since a read-only inspection query has no legitimate need to take
 * row locks either; guard #2 (the READ ONLY transaction) would reject it at
 * the database level anyway if this guard somehow let it through.
 */
const FORBIDDEN_KEYWORDS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'CREATE',
  'COPY',
  'CALL',
  'MERGE',
  'VACUUM',
  'REINDEX',
  'EXECUTE',
  'PREPARE',
  'DEALLOCATE',
  'LISTEN',
  'NOTIFY',
  'UNLISTEN',
  'SET',
  'RESET',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'START',
  'DO',
  'ANALYZE',
  'ANALYSE',
  'CLUSTER',
  'LOCK',
  'IMPORT',
  'REFRESH',
  'SECURITY',
  'COMMENT',
  'INTO',
  'DISCARD',
  'CHECKPOINT',
])

const ALLOWED_LEADING_KEYWORDS: ReadonlySet<string> = new Set(['SELECT', 'WITH'])

class UnterminatedLiteralError extends Error {}

/**
 * Replaces every character that is not "live" SQL syntax — comment bodies,
 * and the contents of single-quoted strings, double-quoted identifiers, and
 * dollar-quoted strings — with a space, preserving length/position. Throws
 * `UnterminatedLiteralError` if a comment or literal never closes (malformed
 * input — reject rather than guess).
 */
function maskSql(sql: string): string {
  const out: string[] = []
  const n = sql.length
  let i = 0

  while (i < n) {
    const c = sql.charAt(i)
    const next = sql.charAt(i + 1) // '' past the end of the string — never undefined

    // Line comment: `-- ...` through end-of-line (or end of input).
    if (c === '-' && next === '-') {
      while (i < n && sql.charAt(i) !== '\n') {
        out.push(' ')
        i++
      }
      continue
    }

    // Block comment: `/* ... */`, nesting-aware (Postgres nests these).
    if (c === '/' && next === '*') {
      let depth = 1
      out.push(' ', ' ')
      i += 2
      while (i < n && depth > 0) {
        if (sql.charAt(i) === '/' && sql.charAt(i + 1) === '*') {
          depth++
          out.push(' ', ' ')
          i += 2
          continue
        }
        if (sql.charAt(i) === '*' && sql.charAt(i + 1) === '/') {
          depth--
          out.push(' ', ' ')
          i += 2
          continue
        }
        out.push(' ')
        i++
      }
      if (depth > 0) throw new UnterminatedLiteralError('unterminated block comment')
      continue
    }

    // Single-quoted string literal, with '' as an escaped quote.
    if (c === "'") {
      out.push(' ')
      i++
      let closed = false
      while (i < n) {
        if (sql.charAt(i) === "'" && sql.charAt(i + 1) === "'") {
          out.push(' ', ' ')
          i += 2
          continue
        }
        if (sql.charAt(i) === "'") {
          out.push(' ')
          i++
          closed = true
          break
        }
        out.push(' ')
        i++
      }
      if (!closed) throw new UnterminatedLiteralError('unterminated string literal')
      continue
    }

    // Double-quoted identifier, with "" as an escaped quote.
    if (c === '"') {
      out.push(' ')
      i++
      let closed = false
      while (i < n) {
        if (sql.charAt(i) === '"' && sql.charAt(i + 1) === '"') {
          out.push(' ', ' ')
          i += 2
          continue
        }
        if (sql.charAt(i) === '"') {
          out.push(' ')
          i++
          closed = true
          break
        }
        out.push(' ')
        i++
      }
      if (!closed) throw new UnterminatedLiteralError('unterminated quoted identifier')
      continue
    }

    // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty, e.g. $$...$$).
    if (c === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const endIdx = sql.indexOf(tag, i + tag.length)
        if (endIdx === -1) throw new UnterminatedLiteralError('unterminated dollar-quoted string')
        const span = endIdx + tag.length - i
        for (let k = 0; k < span; k++) out.push(' ')
        i += span
        continue
      }
    }

    out.push(c)
    i++
  }

  return out.join('')
}

/**
 * Test-first plan item 2: validates a single `SELECT`/`WITH…SELECT`
 * statement, rejecting DML/DDL, `;`-chained multi-statements, and
 * comment-smuggled writes. Returns the guarded SQL (trailing `;` stripped)
 * on success.
 */
export function guardSelectOnlySql(rawSql: string): SqlGuardResult {
  if (typeof rawSql !== 'string' || rawSql.trim().length === 0) {
    return { ok: false, reason: 'empty_statement', message: 'No SQL statement was provided.' }
  }

  let masked: string
  try {
    masked = maskSql(rawSql)
  } catch {
    return {
      ok: false,
      reason: 'unterminated_literal',
      message: 'The statement has an unterminated string, quoted identifier, dollar-quote, or comment.',
    }
  }

  // Exactly zero top-level semicolons, or exactly one AND nothing but
  // whitespace follows it (a lone trailing terminator) — never more than
  // one, and never anything real after it (catches both `SELECT 1; DROP …`
  // and the comment-smuggled `SELECT 1 -- \n; DELETE …`, since the line
  // comment above is already masked to spaces up to its own newline, leaving
  // the real `; DELETE …` behind for this check to see).
  let semicolonCount = 0
  let firstSemicolonIndex = -1
  for (let i = 0; i < masked.length; i++) {
    if (masked.charAt(i) === ';') {
      semicolonCount++
      if (firstSemicolonIndex === -1) firstSemicolonIndex = i
    }
  }
  if (semicolonCount > 1) {
    return {
      ok: false,
      reason: 'multiple_statements',
      message: 'Only a single statement is allowed — no `;`-chained multiple statements.',
    }
  }
  let trailingSemicolonIndex: number | undefined
  if (semicolonCount === 1) {
    if (masked.slice(firstSemicolonIndex + 1).trim().length > 0) {
      return {
        ok: false,
        reason: 'multiple_statements',
        message: 'Only a single statement is allowed — no `;`-chained multiple statements.',
      }
    }
    trailingSemicolonIndex = firstSemicolonIndex
  }

  const tokens = masked.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  const [firstToken] = tokens
  if (firstToken === undefined) {
    return { ok: false, reason: 'empty_statement', message: 'No SQL statement was provided.' }
  }

  const leading = firstToken.toUpperCase()
  if (!ALLOWED_LEADING_KEYWORDS.has(leading)) {
    return {
      ok: false,
      reason: 'not_select',
      message: 'Only a single SELECT or WITH…SELECT statement is allowed.',
    }
  }

  for (const token of tokens) {
    if (FORBIDDEN_KEYWORDS.has(token.toUpperCase())) {
      return {
        ok: false,
        reason: 'forbidden_keyword',
        message: `The statement contains a forbidden keyword ("${token}") — only read-only SELECT/WITH statements are allowed.`,
      }
    }
  }

  // Return the ORIGINAL sql (not the masked/blanked one — masking exists
  // only for analysis), with a lone trailing terminator dropped so the
  // caller can safely wrap it (e.g. `SELECT * FROM (<this>) AS _q LIMIT n`)
  // without a stray `;` breaking the wrapper.
  const sql = trailingSemicolonIndex !== undefined ? rawSql.slice(0, trailingSemicolonIndex) : rawSql
  return { ok: true, sql: sql.trim() }
}
