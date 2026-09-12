/**
 * E2E harness for the rich cell — NOT part of the application bundle.
 *
 * Built only by `e2e/vite.config.ts` and served at `/e2e/harness/richtext/`.
 * It mounts the real `RichCellEditor` and `CellContent` over a real Yjs
 * document (`@gede/core`'s schema and mutations) inside a minimal grid
 * shell, so Playwright can exercise marks, formats and locales in a real
 * contenteditable — jsdom has no layout and no IME. Nothing is mocked: the
 * document is a local `Y.Doc` with no provider, exactly what an offline
 * replica is.
 */
import { StrictMode, useCallback, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import {
  cellFragment,
  cellRich,
  cellText,
  createSheet,
  createTable,
  CURRENCY_CODES,
  effectiveCellFormat,
  FORMAT_KINDS,
  FORMAT_LOCALES,
  openDocument,
  setCellRich,
  setCellText,
  setColumnFormat,
  tableById,
  tableMap,
  type FormatKind,
  type FormatLocale,
  type RichDoc,
} from '@gede/core';
import '@gede/ui/styles.css';
import '../../styles.css';
import { useYVersion } from '../../doc/use-y.js';
import { CellContent, RichCellEditor } from '../../routes/document/cell/index.js';

const gd = openDocument(new Y.Doc());
const sheetId = createSheet(gd);
const tableId = createTable(gd, {
  sheetId,
  at: { col: 0, row: 0 },
  columns: 1,
  rows: 3,
  title: 'Harness',
});
const record = tableById(gd, tableId);
if (record === null) throw new Error('harness table missing');
const colId = record.columns[0]?.id ?? '';
const rows = record.rows;
setCellText(gd, tableId, rows[0] ?? '', colId, 'Everest trek');
setCellText(gd, tableId, rows[1] ?? '', colId, '1234.5');
setCellText(gd, tableId, rows[2] ?? '', colId, 'வணக்கம்');

function Harness() {
  const table = tableMap(gd, tableId);
  if (table === null) throw new Error('harness table missing');
  const version = useYVersion(table);
  const [editing, setEditing] = useState<string | null>(null);
  const [locale, setLocale] = useState<FormatLocale>('en-US');
  const [kind, setKind] = useState<FormatKind>('auto');
  const [currency, setCurrency] = useState<(typeof CURRENCY_CODES)[number]>('SGD');
  const formatId = useId();
  const localeId = useId();
  const currencyId = useId();

  const applyFormat = useCallback((next: FormatKind, code: (typeof CURRENCY_CODES)[number]) => {
    setKind(next);
    setCurrency(code);
    setColumnFormat(
      gd,
      tableId,
      colId,
      next,
      next === 'currency' ? { currency: code, decimals: 2 } : {},
    );
  }, []);

  return (
    <main style={{ padding: 'var(--space-4)', maxWidth: '40rem' }}>
      <h1 style={{ fontSize: '1rem' }}>Rich cell harness</h1>
      <p>
        <label htmlFor={formatId}>Column format</label>{' '}
        <select
          id={formatId}
          value={kind}
          onChange={(e) => {
            applyFormat(e.target.value as FormatKind, currency);
          }}
        >
          {FORMAT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>{' '}
        <label htmlFor={currencyId}>Currency</label>{' '}
        <select
          id={currencyId}
          value={currency}
          onChange={(e) => {
            applyFormat(kind, e.target.value as (typeof CURRENCY_CODES)[number]);
          }}
        >
          {CURRENCY_CODES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>{' '}
        <label htmlFor={localeId}>Locale</label>{' '}
        <select
          id={localeId}
          value={locale}
          onChange={(e) => {
            setLocale(e.target.value as FormatLocale);
          }}
        >
          {FORMAT_LOCALES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </p>
      <div role="grid" aria-label="Harness" className="gd-table__grid" style={{ width: '20rem' }}>
        {rows.map((rowId, i) => {
          const address = `A${String(i + 1)}`;
          const format = effectiveCellFormat(table, rowId, colId);
          const isEditing = editing === rowId;
          return (
            <div
              role="row"
              key={rowId}
              className="gd-table__row"
              style={{ height: 'var(--lattice-row)' }}
            >
              <div
                role="gridcell"
                tabIndex={0}
                className={`gd-cell${isEditing ? ' gd-cell--editing' : ''}`}
                style={{ width: '20rem' }}
                data-address={address}
                data-version={version}
                onDoubleClick={() => {
                  setEditing(rowId);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.code === 'Enter') {
                    e.preventDefault();
                    setEditing(rowId);
                  }
                }}
              >
                {isEditing ? (
                  <RichCellEditor
                    initial={cellText(table, rowId, colId)}
                    address={address}
                    fragment={cellFragment(table, rowId, colId)}
                    onCommit={(text) => {
                      setCellText(gd, tableId, rowId, colId, text);
                      setEditing(null);
                    }}
                    onCommitRich={(doc: RichDoc) => {
                      setCellRich(gd, tableId, rowId, colId, doc);
                    }}
                    onCancel={() => {
                      setEditing(null);
                    }}
                  />
                ) : (
                  <CellContent
                    content={cellRich(table, rowId, colId)}
                    format={format}
                    locale={locale}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <pre data-testid="fragment-json" style={{ fontSize: '0.75rem' }}>
        {JSON.stringify(cellRich(table, rows[0] ?? '', colId))}
      </pre>
    </main>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('harness index.html has no #root');
createRoot(rootEl).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
