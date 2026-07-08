// Test-first plan item 2 (issue 049): the SELECT-only guard is the single
// most important test file in this feature — it is the last line of defense
// (alongside the read-only transaction, guard #2) between an operator's
// pasted SQL and the live RDS instance. Every known bypass vector gets its
// own case; a plain SELECT/WITH…SELECT must still pass.
import { describe, expect, it } from 'vitest'
import { guardSelectOnlySql } from './sqlGuard'

describe('guardSelectOnlySql — accepts plain read-only statements', () => {
  it('accepts a simple SELECT', () => {
    const result = guardSelectOnlySql('SELECT * FROM projects')
    expect(result.ok).toBe(true)
  })

  it('accepts SELECT with a single trailing semicolon', () => {
    const result = guardSelectOnlySql('SELECT * FROM projects;')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.sql).toBe('SELECT * FROM projects')
  })

  it('accepts a WITH…SELECT (non-mutating CTE)', () => {
    const result = guardSelectOnlySql(
      "WITH recent AS (SELECT * FROM projects WHERE updated_at > now() - interval '1 day') SELECT * FROM recent",
    )
    expect(result.ok).toBe(true)
  })

  it('accepts WITH RECURSIVE …SELECT', () => {
    const result = guardSelectOnlySql(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT * FROM t',
    )
    expect(result.ok).toBe(true)
  })

  it('accepts case-insensitive select/with', () => {
    expect(guardSelectOnlySql('select * from projects').ok).toBe(true)
    expect(guardSelectOnlySql('Select * From projects').ok).toBe(true)
  })

  it('accepts a string literal that itself contains a semicolon (not a real statement separator)', () => {
    const result = guardSelectOnlySql("SELECT * FROM projects WHERE name = 'a;b'")
    expect(result.ok).toBe(true)
  })

  it('accepts a trailing line comment after a valid SELECT', () => {
    const result = guardSelectOnlySql('SELECT * FROM projects -- just a comment')
    expect(result.ok).toBe(true)
  })

  it('accepts a block comment inside a valid SELECT', () => {
    const result = guardSelectOnlySql('SELECT /* all columns */ * FROM projects')
    expect(result.ok).toBe(true)
  })

  it('accepts a dollar-quoted string literal containing keyword-looking text', () => {
    const result = guardSelectOnlySql("SELECT $$ this looks like an INSERT DROP DELETE $$ AS note")
    expect(result.ok).toBe(true)
  })

  it('accepts a double-quoted identifier that happens to spell a forbidden keyword', () => {
    const result = guardSelectOnlySql('SELECT "delete" FROM projects')
    expect(result.ok).toBe(true)
  })
})

describe('guardSelectOnlySql — rejects non-SELECT statements outright', () => {
  it.each([
    ['INSERT', "INSERT INTO projects (id, name) VALUES ('1', 'x')"],
    ['UPDATE', "UPDATE projects SET name = 'x' WHERE id = '1'"],
    ['DELETE', "DELETE FROM projects WHERE id = '1'"],
    ['DROP', 'DROP TABLE projects'],
    ['ALTER', 'ALTER TABLE projects ADD COLUMN x text'],
    ['TRUNCATE', 'TRUNCATE projects'],
    ['GRANT', 'GRANT SELECT ON projects TO PUBLIC'],
    ['CREATE', 'CREATE TABLE evil (id text)'],
    ['COPY', "COPY projects TO '/tmp/out.csv'"],
    ['CALL', 'CALL some_procedure()'],
    ['VACUUM', 'VACUUM projects'],
    ['EXECUTE', 'EXECUTE some_prepared_stmt'],
    ['SET', "SET statement_timeout = 0"],
    ['BEGIN', 'BEGIN'],
  ])('rejects a bare %s statement', (_label, sql) => {
    const result = guardSelectOnlySql(sql)
    expect(result.ok).toBe(false)
  })
})

describe('guardSelectOnlySql — rejects `;`-chained multi-statements', () => {
  it('rejects SELECT followed by a semicolon-chained DROP', () => {
    const result = guardSelectOnlySql('SELECT 1; DROP TABLE projects')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('multiple_statements')
  })

  it('rejects SELECT followed by a semicolon-chained DELETE', () => {
    const result = guardSelectOnlySql('SELECT 1; DELETE FROM projects')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('multiple_statements')
  })

  it('rejects two semicolons even if the tail looks empty', () => {
    const result = guardSelectOnlySql('SELECT 1;;')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('multiple_statements')
  })

  it('rejects two well-formed SELECTs chained by a semicolon', () => {
    const result = guardSelectOnlySql('SELECT 1; SELECT 2')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('multiple_statements')
  })
})

describe('guardSelectOnlySql — rejects comment-smuggled writes (the sharpest bypass vector)', () => {
  it('rejects a line-comment-smuggled DELETE after a real newline-separated semicolon', () => {
    const result = guardSelectOnlySql('SELECT 1 -- \n; DELETE FROM projects')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('multiple_statements')
  })

  it('rejects a line-comment-smuggled DROP on the next physical line', () => {
    const result = guardSelectOnlySql('SELECT 1 --\n; DROP TABLE projects; --')
    expect(result.ok).toBe(false)
  })

  it('does NOT treat a semicolon truly inside a line comment as a statement separator', () => {
    // The whole "; DROP TABLE projects" is on the SAME physical line as the
    // `--`, so it is genuinely all comment — this is one legitimate SELECT.
    const result = guardSelectOnlySql('SELECT 1 -- ; DROP TABLE projects')
    expect(result.ok).toBe(true)
  })

  it('rejects a DELETE hidden inside a block comment that never actually closes before real SQL resumes', () => {
    // Unterminated block comment — must be rejected, not silently swallowed.
    const result = guardSelectOnlySql('SELECT 1 /* unterminated DELETE FROM projects')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unterminated_literal')
  })

  it('rejects a forbidden keyword that appears after a properly closed block comment', () => {
    const result = guardSelectOnlySql('SELECT 1 /* fine */ ; DELETE FROM projects')
    expect(result.ok).toBe(false)
  })

  it('rejects a data-modifying CTE disguised as WITH…SELECT (DELETE inside the CTE body)', () => {
    const result = guardSelectOnlySql('WITH deleted AS (DELETE FROM projects RETURNING *) SELECT * FROM deleted')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('forbidden_keyword')
  })

  it('rejects a data-modifying CTE using INSERT', () => {
    const result = guardSelectOnlySql(
      "WITH inserted AS (INSERT INTO projects (id) VALUES ('x') RETURNING *) SELECT * FROM inserted",
    )
    expect(result.ok).toBe(false)
  })

  it('rejects SELECT ... INTO (creates a table despite starting with SELECT)', () => {
    const result = guardSelectOnlySql('SELECT * INTO new_table FROM projects')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('forbidden_keyword')
  })

  it('rejects SELECT ... FOR UPDATE (row-locking side effect)', () => {
    const result = guardSelectOnlySql('SELECT * FROM projects FOR UPDATE')
    expect(result.ok).toBe(false)
  })
})

describe('guardSelectOnlySql — malformed input', () => {
  it('rejects an empty string', () => {
    const result = guardSelectOnlySql('')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('empty_statement')
  })

  it('rejects a whitespace-only string', () => {
    const result = guardSelectOnlySql('   \n\t  ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('empty_statement')
  })

  it('rejects an unterminated string literal', () => {
    const result = guardSelectOnlySql("SELECT * FROM projects WHERE name = 'unterminated")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unterminated_literal')
  })

  it('rejects a statement that is not SELECT/WITH at all', () => {
    const result = guardSelectOnlySql('projects')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_select')
  })
})
