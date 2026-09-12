// FAKES, labelled: the documents REST API is a vi.fn() returning the server's
// real shape; the search Worker is absent under jsdom, so the client's
// main-thread fallback (the same engine) runs — that path is what this file
// tests. The document is a real in-memory Yjs document.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  addRow,
  cellText,
  createSheet,
  createTable,
  openDocument,
  setCellText,
  tableById,
  type GedeDoc,
  type SearchMatch,
} from '@gede/core';

import { LiveRegion } from '../../../announce.js';
import type * as DocumentsApi from '../../../api/documents.js';
import { withConfig } from '../../../test/helpers.js';
import { ToastProvider, TooltipProvider } from '@gede/ui';
import { FindBar } from './FindBar.js';
import { MatchHighlights } from './MatchHighlights.js';
import { createSearchClient, MAX_RESTARTS, type SearchClientEvent } from './search-client.js';
import { counterText, useFind, type FindNavigation } from './useFind.js';

vi.mock('../../../api/documents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentsApi>();
  return { ...actual, listDocuments: vi.fn(() => Promise.resolve([])) };
});
const docs = await import('../../../api/documents.js');

const DOC_ID = '6f1b2c3d-0000-4000-8000-0000000f1nd0';

interface Fixture {
  gd: GedeDoc;
  sheet1: string;
  sheet2: string;
  table1: string;
  table2: string;
  ids: { rows: readonly string[]; cols: readonly string[] };
}

/** Two sheets, two tables: cities on sheet 1, a formula and a currency on it, one city on sheet 2. */
function fixture(): Fixture {
  const gd = openDocument(new Y.Doc());
  const sheet1 = createSheet(gd, { label: 'Trek' });
  const sheet2 = createSheet(gd, { label: 'Budget' });
  const table1 = createTable(gd, { sheetId: sheet1, at: { col: 1, row: 1 }, columns: 2, rows: 4 });
  const t1 = tableById(gd, table1)!;
  const [c1, c2] = t1.columns.map((c) => c.id) as [string, string];
  const [r1, r2, r3, r4] = t1.rows as [string, string, string, string];
  setCellText(gd, table1, r1, c1, 'Singapore');
  setCellText(gd, table1, r1, c2, 'S$ 1,200');
  setCellText(gd, table1, r2, c1, 'Sngapore office');
  setCellText(gd, table1, r2, c2, '2026-09-12');
  setCellText(gd, table1, r3, c1, 'Mumbai');
  setCellText(gd, table1, r4, c1, '=Concat(@Trek.Singapore, " hub")');
  const table2 = createTable(gd, { sheetId: sheet2, at: { col: 3, row: 40 }, columns: 1, rows: 1 });
  const t2 = tableById(gd, table2)!;
  setCellText(gd, table2, t2.rows[0]!, t2.columns[0]!.id, 'Singapore budget');
  return { gd, sheet1, sheet2, table1, table2, ids: { rows: [r1, r2, r3, r4], cols: [c1, c2] } };
}

interface HarnessProps {
  gd: GedeDoc;
  editable?: boolean;
  phone?: boolean;
  navigation: FindNavigation;
  sheetId: string;
  onFind?: (find: ReturnType<typeof useFind>) => void;
}

/** The Find bar, the highlights and a button standing in for the toolbar magnifier. */
function Harness({
  gd,
  editable = true,
  phone = false,
  navigation,
  sheetId,
  onFind,
}: HarnessProps) {
  const find = useFind({ gd, docId: DOC_ID, editable, navigation });
  onFind?.(find);
  return (
    <TooltipProvider>
      <ToastProvider>
        <LiveRegion />
        <button
          type="button"
          onClick={() => {
            find.actions.open();
          }}
        >
          Find
        </button>
        <button
          type="button"
          onClick={() => {
            find.actions.open({ replace: true });
          }}
        >
          Find and replace
        </button>
        <div data-testid="layer">
          <MatchHighlights
            gd={gd}
            matches={find.state.matches}
            current={find.state.current}
            sheetId={sheetId}
          />
        </div>
        <FindBar gd={gd} find={find} editable={editable} phone={phone} />
      </ToastProvider>
    </TooltipProvider>
  );
}

function navigation(): FindNavigation & {
  reveals: SearchMatch[];
  opened: string[];
  selected: SearchMatch[];
} {
  const reveals: SearchMatch[] = [];
  const opened: string[] = [];
  const selected: SearchMatch[] = [];
  return {
    reveals,
    opened,
    selected,
    onReveal: (m) => reveals.push(m),
    onOpenDocument: (id) => opened.push(id),
    onSelect: (m) => selected.push(m),
  };
}

async function openAndType(query: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Find' }));
  const field = screen.getByRole('textbox', { name: 'Find' });
  await userEvent.clear(field);
  await userEvent.type(field, query);
  return field;
}

const count = () => screen.getByTestId('find-count').textContent;
const highlights = () =>
  screen.queryAllByTestId('find-highlights').flatMap((h) => Array.from(h.children));

describe('Find', () => {
  beforeEach(() => {
    withConfig();
    vi.mocked(docs.listDocuments).mockResolvedValue([]);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs on the main-thread fallback under jsdom: same engine, asynchronous results', async () => {
    const client = createSearchClient();
    expect(client.mode).toBe('main');
    const received: number[] = [];
    client.subscribe((r) => {
      if (r.type === 'results') received.push(r.id);
    });
    client.post({
      type: 'query',
      id: 7,
      query: 'x',
      options: { fuzzy: true, formulas: true, documents: true },
    });
    expect(received).toEqual([]); // delivered on a microtask, never synchronously
    await Promise.resolve();
    expect(received).toEqual([7]);
    client.dispose();
  });

  it('FIND-01 opening focuses the field and selects any existing query; ⌥⌘F shows replace', async () => {
    const { gd, sheet1 } = fixture();
    const nav = navigation();
    render(<Harness gd={gd} navigation={nav} sheetId={sheet1} />);
    expect(screen.queryByRole('search', { name: 'Find' })).not.toBeInTheDocument();
    await openAndType('Mumbai');
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Find' });
    expect(field).toHaveFocus();
    // Focus wanders (a click on the canvas), ⌘F again: focus returns and the query is selected.
    field.blur();
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('Mumbai'.length);
    expect(screen.queryByRole('textbox', { name: 'Replace with' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Find and replace' }));
    expect(screen.getByRole('textbox', { name: 'Replace with' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
  });

  it('FIND-02 the bar has a gear, the field, an "n of m" counter, previous and next chevrons and Done', async () => {
    const { gd, sheet1 } = fixture();
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    await openAndType('Singapore');
    const bar = screen.getByRole('search', { name: 'Find' });
    expect(within(bar).getByRole('button', { name: 'Find options' })).toBeInTheDocument();
    expect(within(bar).getByRole('textbox', { name: 'Find' })).toBeInTheDocument();
    await waitFor(() => {
      expect(count()).toBe('1 of 4');
    });
    expect(within(bar).getByRole('button', { name: 'Previous match' })).toBeEnabled();
    expect(within(bar).getByRole('button', { name: 'Next match' })).toBeEnabled();
    expect(within(bar).getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(counterText(6, 1, 'x')).toBe('2 of 6');
    expect(counterText(0, -1, 'x')).toBe('No matches');
    expect(counterText(0, -1, '  ')).toBe('');
  });

  it('FIND-03 scope is every table on every sheet: values, formula expressions, reference paths and workscape names as their own group', async () => {
    vi.mocked(docs.listDocuments).mockImplementation((view) =>
      Promise.resolve(
        view === 'browse'
          ? [
              {
                id: DOC_ID,
                title: 'Singapore (this one)',
                createdAt: '',
                updatedAt: '',
                ownerId: 'me',
              },
              {
                id: 'other-1',
                title: 'Singapore budget 2027',
                createdAt: '',
                updatedAt: '',
                ownerId: 'me',
              },
            ]
          : [
              {
                id: 'other-2',
                title: 'Shared Singapore plan',
                createdAt: '',
                updatedAt: '',
                ownerId: 'x',
              },
            ],
      ),
    );
    const { gd, sheet1 } = fixture();
    const nav = navigation();
    render(<Harness gd={gd} navigation={nav} sheetId={sheet1} />);
    await openAndType('Singapore');
    await waitFor(() => {
      expect(count()).toBe('1 of 6');
    });
    await userEvent.click(screen.getByRole('button', { name: /^Results/ }));
    const list = screen.getByTestId('find-results');
    const groups = within(list)
      .getAllByRole('region')
      .map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Cells', 'Workscapes']);
    const cells = within(within(list).getByRole('region', { name: 'Cells' })).getAllByRole(
      'button',
    );
    // Exact hits in document order (sheet 1 then sheet 2), then the fuzzy ones.
    expect(cells.map((b) => b.textContent)).toEqual([
      'B5 in Table 1Singapore',
      'B8 in Table 1=Concat(@Trek.Singapore, " hub")',
      'D44 in Table 1Singapore budget',
      'B6 in Table 1Sngapore office~1',
    ]);
    // The workscape group excludes this document and navigates on click.
    const docsGroup = within(within(list).getByRole('region', { name: 'Workscapes' })).getAllByRole(
      'button',
    );
    expect(docsGroup.map((b) => b.textContent)).toEqual([
      'Singapore budget 2027 (workscape)Singapore budget 2027',
      'Shared Singapore plan (workscape)Shared Singapore plan',
    ]);
    await userEvent.click(docsGroup[0]!);
    expect(nav.opened).toEqual(['other-1']);
    // The gear can leave workscape names out.
    await userEvent.click(screen.getByRole('button', { name: 'Find options' }));
    await userEvent.click(
      await screen.findByRole('menuitemcheckbox', { name: 'Include workscape names' }),
    );
    await waitFor(() => {
      expect(count()).toBe('1 of 4');
    });
  });

  it('FIND-04 col: restricts to a column and is: to the resolved format; bare terms match anywhere', async () => {
    const { gd, sheet1 } = fixture();
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    const field = await openAndType('col:"Column 2" 1,200');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
    await userEvent.clear(field);
    await userEvent.type(field, 'is:date');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
    await userEvent.clear(field);
    await userEvent.type(field, 'is:currency|date');
    await waitFor(() => {
      expect(count()).toBe('1 of 2');
    });
    await userEvent.clear(field);
    await userEvent.type(field, 'office');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
  });

  it('FIND-05 fuzzy is on by default ("Sngapore" finds "Singapore") and the gear turns it off', async () => {
    const { gd, sheet1 } = fixture();
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    await openAndType('Sngapore');
    await waitFor(() => {
      expect(count()).toBe('1 of 4');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Find options' }));
    const fuzzy = await screen.findByRole('menuitemcheckbox', { name: 'Fuzzy matching' });
    expect(fuzzy).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(fuzzy);
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
  });

  it('FIND-06 (partial: not in inspector) matches highlight in place in amber on the active sheet, the current one more strongly, and the list stays in sync', async () => {
    const { gd, sheet1 } = fixture();
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    await openAndType('Singapore');
    await waitFor(() => {
      expect(count()).toBe('1 of 4');
    });
    // Three matches are on sheet 1 (the fourth is on sheet 2); the first is current.
    await waitFor(() => {
      expect(highlights()).toHaveLength(3);
    });
    const [first] = highlights();
    expect(first).toHaveClass('gd-find-hit', 'gd-find-hit--current');
    // B5 of a table at (1,1): title 2 rows + header 1 row → lattice row 4 (0-based), column B.
    expect(first).toHaveStyle({ left: '160px', top: '88px', width: '160px', height: '22px' });
    expect(highlights().filter((h) => h.classList.contains('gd-find-hit--current'))).toHaveLength(
      1,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await waitFor(() => {
      expect(count()).toBe('2 of 4');
    });
    expect(highlights()[1]).toHaveClass('gd-find-hit--current');
    await userEvent.click(screen.getByRole('button', { name: /^Results/ }));
    const current = within(screen.getByTestId('find-results')).getByRole('button', {
      current: true,
    });
    expect(current).toHaveTextContent('B8 in Table 1');
    // Picking a row moves the bar's counter with it.
    const rows = within(screen.getByTestId('find-results')).getAllByRole('button');
    await userEvent.click(rows[3]!);
    await waitFor(() => {
      expect(count()).toBe('4 of 4');
    });
  });

  it('FIND-07 Enter, Shift-Enter and the chevrons step through matches, wrapping, and reveal each one — across sheets', async () => {
    const { gd, sheet1, sheet2, table2 } = fixture();
    const nav = navigation();
    render(<Harness gd={gd} navigation={nav} sheetId={sheet1} />);
    const field = await openAndType('Singapore');
    await waitFor(() => {
      expect(count()).toBe('1 of 4');
    });
    await userEvent.type(field, '{Enter}');
    expect(count()).toBe('2 of 4');
    await userEvent.type(field, '{Enter}');
    expect(count()).toBe('3 of 4');
    expect(nav.reveals.at(-1)?.target).toMatchObject({
      kind: 'cell',
      sheetId: sheet2,
      tableId: table2,
    });
    await userEvent.type(field, '{Shift>}{Enter}{/Shift}');
    expect(count()).toBe('2 of 4');
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(count()).toBe('1 of 4');
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(count()).toBe('4 of 4'); // wraps
    expect(nav.reveals).toHaveLength(5);
    expect(screen.getByTestId('live-region')).toHaveTextContent(/4 of 4, B6 in Table 1/);
  });

  it('FIND-08 Replace rewrites the current match, All rewrites every exact match in scope; read-only matches and fuzzy near misses are left alone with a count', async () => {
    const { gd, sheet1, table1, ids } = fixture();
    // Column 2 becomes derived: its cells are read-only (see isReadOnlyCell's TODO).
    const columns = gd.tables.get(table1)!.get('columns') as Y.Array<Y.Map<unknown>>;
    gd.doc.transact(() => {
      columns.get(1).set('derived', true);
    });
    setCellText(gd, table1, ids.rows[2]!, ids.cols[1]!, 'Singapore fund');
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    await userEvent.click(screen.getByRole('button', { name: 'Find and replace' }));
    const field = screen.getByRole('textbox', { name: 'Find' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Singapore');
    await waitFor(() => {
      expect(count()).toBe('1 of 5');
    });
    await userEvent.type(screen.getByRole('textbox', { name: 'Replace with' }), 'Mumbai');
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
    const t1 = gd.tables.get(table1)!;
    expect(cellText(t1, ids.rows[0]!, ids.cols[0]!)).toBe('Mumbai');
    // The index catches up and the counter drops by one; the next match is now current.
    await waitFor(() => {
      expect(count()).toBe('1 of 4');
    });
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => {
      expect(screen.getByTestId('find-skipped')).toHaveTextContent(
        '1 near match left alone, 1 not editable',
      );
    });
    expect(cellText(t1, ids.rows[3]!, ids.cols[0]!)).toBe('=Concat(@Trek.Mumbai, " hub")');
    // A fuzzy near miss ("Sngapore") is not what was asked for: untouched (FIND-05 × FIND-08).
    expect(cellText(t1, ids.rows[1]!, ids.cols[0]!)).toBe('Sngapore office');
    // Derived: untouched.
    expect(cellText(t1, ids.rows[2]!, ids.cols[1]!)).toBe('Singapore fund');
    await waitFor(() => {
      expect(count()).toBe('1 of 2'); // the near miss and the read-only match remain
    });
    // Replace on a read-only match, then on a near miss: each is left alone and stepped past.
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(screen.getByTestId('find-skipped')).toHaveTextContent('1 not editable');
    expect(count()).toBe('2 of 2');
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(cellText(t1, ids.rows[1]!, ids.cols[0]!)).toBe('Sngapore office');
    expect(screen.getByTestId('find-skipped')).toHaveTextContent('1 near match left alone');
    expect(screen.getByTestId('live-region')).toHaveTextContent(/Left B6 in Table 1 alone/);
    expect(count()).toBe('1 of 2');
    // FIND-10: the bar never closes itself.
    expect(screen.getByRole('search', { name: 'Find' })).toBeInTheDocument();
  });

  it('FIND-08 SHARE-03 a view-only participant sees Replace disabled with the reason; on phone the row is absent', async () => {
    const { gd, sheet1 } = fixture();
    const { unmount } = render(
      <Harness gd={gd} navigation={navigation()} sheetId={sheet1} editable={false} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Find and replace' }));
    const replace = screen.getByRole('button', { name: 'Replace' });
    expect(replace).toHaveAttribute('aria-disabled', 'true');
    expect(replace).toHaveAttribute('title', expect.stringContaining('view-only'));
    unmount();
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} editable={false} phone />);
    await userEvent.click(screen.getByRole('button', { name: 'Find and replace' }));
    expect(screen.queryByRole('textbox', { name: 'Replace with' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument();
  });

  it('FIND-09 Done closes the bar, clears highlighting, selects the current match and keeps the query for the session', async () => {
    const { gd, sheet1 } = fixture();
    const nav = navigation();
    const { unmount } = render(<Harness gd={gd} navigation={nav} sheetId={sheet1} />);
    await openAndType('Mumbai');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
    expect(highlights()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('search', { name: 'Find' })).not.toBeInTheDocument();
    expect(highlights()).toHaveLength(0);
    expect(nav.selected.at(-1)?.text).toBe('Mumbai');
    expect(sessionStorage.getItem(`gede.find.query:${DOC_ID}`)).toBe('Mumbai');
    // A fresh mount in the same session (say, after navigating away and back) keeps the query.
    unmount();
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(screen.getByRole('textbox', { name: 'Find' })).toHaveValue('Mumbai');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
  });

  it('FIND-10 A11Y-05 with no match the counter reads "No matches", the bar stays open, and the live region announces politely', async () => {
    const { gd, sheet1 } = fixture();
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    await openAndType('Singapore');
    await waitFor(() => {
      expect(screen.getByTestId('live-region')).toHaveTextContent('1 of 4');
    });
    const region = screen.getByTestId('live-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // Four keystrokes, each slow enough to run its own query: the region speaks once the
    // results settle, not once per keystroke.
    const spoken: string[] = [];
    const observer = new MutationObserver(() => {
      spoken.push(region.textContent ?? '');
    });
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    await userEvent.type(screen.getByRole('textbox', { name: 'Find' }), 'zzzz', { delay: 60 });
    await waitFor(() => {
      expect(count()).toBe('No matches');
    });
    await waitFor(() => {
      expect(region).toHaveTextContent('No matches');
    });
    observer.disconnect();
    expect(spoken.filter((t) => t.startsWith('No matches'))).toHaveLength(1);
    expect(screen.getByRole('search', { name: 'Find' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled();
  });

  it('FIND-03 the index follows the document while the bar is open: a new cell shows up, a deleted table drops out', async () => {
    const { gd, sheet1, table1, table2, ids } = fixture();
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    await openAndType('Mumbai');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
    act(() => {
      setCellText(gd, table1, ids.rows[0]!, ids.cols[1]!, 'Mumbai desk');
    });
    // The new cell sorts first; the match that was current stays current.
    await waitFor(() => {
      expect(count()).toBe('2 of 2');
    });
    act(() => {
      gd.doc.transact(() => {
        gd.tables.delete(table2);
        gd.tables.delete(table1);
      });
    });
    await waitFor(() => {
      expect(count()).toBe('No matches');
    });
  });

  it('FIND-03 FIND-08 re-indexes every table touched by one transaction even with deeper observers attached (as each TableView is)', async () => {
    const { gd, sheet1, table1, table2, ids } = fixture();
    // TableView observes its own map deeply; Yjs rewrites event.path per observer, so the
    // index must not rely on it.
    const t1 = gd.tables.get(table1)!;
    const t2 = gd.tables.get(table2)!;
    const noop = () => undefined;
    t1.observeDeep(noop);
    t2.observeDeep(noop);
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    await userEvent.click(screen.getByRole('button', { name: 'Find and replace' }));
    const field = screen.getByRole('textbox', { name: 'Find' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Singapore');
    await waitFor(() => {
      expect(count()).toBe('1 of 4');
    });
    await userEvent.type(screen.getByRole('textbox', { name: 'Replace with' }), 'Chennai');
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    // Exact hits in both tables are rewritten in one transaction; the near miss is left alone.
    expect(cellText(t1, ids.rows[0]!, ids.cols[0]!)).toBe('Chennai');
    expect(cellText(t1, ids.rows[3]!, ids.cols[0]!)).toBe('=Concat(@Trek.Chennai, " hub")');
    expect(
      cellText(t2, tableById(gd, table2)!.rows[0]!, tableById(gd, table2)!.columns[0]!.id),
    ).toBe('Chennai budget');
    expect(cellText(t1, ids.rows[1]!, ids.cols[0]!)).toBe('Sngapore office');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
    t1.unobserveDeep(noop);
    t2.unobserveDeep(noop);
  });

  it('FIND-03 a row added with its cells in one transaction, and a fresh table with cells in one transaction, both reach the index', async () => {
    const { gd, sheet1, table1, ids } = fixture();
    // Each TableView observes its own table map deeply, as in the shell.
    const noop = () => undefined;
    gd.tables.get(table1)!.observeDeep(noop);
    render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
    await openAndType('Mumbai');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
    // The row id is new and the cell is set inside the same transaction: the only events
    // are on the existing `rows` array and `cells` map, whose parent chain names the table.
    act(() => {
      gd.doc.transact(() => {
        const rowId = addRow(gd, table1);
        setCellText(gd, table1, rowId, ids.cols[0]!, 'Mumbai annex');
        setCellText(gd, table1, rowId, ids.cols[1]!, 'Mumbai desk');
      }, gd.origin);
    });
    await waitFor(() => {
      expect(count()).toBe('1 of 3');
    });
    // A table created and filled in one transaction is a fresh Y.Map: Yjs fires no event
    // for its own content, only the `tables` key add, which must be enough to index it.
    let table3 = '';
    act(() => {
      gd.doc.transact(() => {
        table3 = createTable(gd, { sheetId: sheet1, at: { col: 8, row: 1 }, columns: 1, rows: 1 });
        const t3 = tableById(gd, table3)!;
        setCellText(gd, table3, t3.rows[0]!, t3.columns[0]!.id, 'Mumbai north');
      }, gd.origin);
    });
    await waitFor(() => {
      expect(count()).toBe('1 of 4');
    });
    gd.tables.get(table1)!.unobserveDeep(noop);
  });

  it('FIND-03 column header labels are indexed as addressable header cells (DOC-06), grouped with cells and never rewritten', async () => {
    const { gd, sheet1, table1 } = fixture();
    const columns = gd.tables.get(table1)!.get('columns') as Y.Array<Y.Map<unknown>>;
    gd.doc.transact(() => {
      columns.get(0).set('label', 'City');
    });
    const nav = navigation();
    render(<Harness gd={gd} navigation={nav} sheetId={sheet1} />);
    await userEvent.click(screen.getByRole('button', { name: 'Find and replace' }));
    const field = screen.getByRole('textbox', { name: 'Find' });
    await userEvent.clear(field);
    await userEvent.type(field, 'City');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
    // The header sits on the table's header row: lattice row 3 of a table at (1,1).
    await waitFor(() => {
      expect(highlights()).toHaveLength(1);
    });
    expect(highlights()[0]).toHaveStyle({ left: '160px', top: '66px', height: '22px' });
    await waitFor(() => {
      expect(screen.getByTestId('live-region')).toHaveTextContent(/1 of 1/);
    });
    await userEvent.click(screen.getByRole('button', { name: /^Results/ }));
    const list = screen.getByTestId('find-results');
    expect(
      within(list)
        .getAllByRole('region')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['Cells']);
    expect(within(list).getByRole('button')).toHaveTextContent('B4 header in Table 1');
    await userEvent.type(screen.getByRole('textbox', { name: 'Replace with' }), 'Town');
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(columns.get(0).get('label')).toBe('City');
    expect(screen.getByTestId('find-skipped')).toHaveTextContent('1 not editable');
  });

  it('LOAD-05 a Worker that errors is restarted with its index re-sent (results kept meanwhile), and after repeated errors Find stops with a notice — never on the main thread', () => {
    // FAKE Worker: a class that fails on demand. jsdom has no Worker, so this stands in.
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
      posted: unknown[] = [];
      terminated = false;
      constructor() {
        workers.push(this);
      }
      postMessage(m: unknown) {
        this.posted.push(m);
      }
      terminate() {
        this.terminated = true;
      }
      fail() {
        this.onerror?.({ message: 'boom', preventDefault: () => undefined });
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    try {
      const client = createSearchClient();
      expect(client.mode).toBe('worker');
      const events: SearchClientEvent[] = [];
      client.subscribe((e) => events.push(e));
      client.post({ type: 'removeTables', tableIds: [] });
      expect(workers).toHaveLength(1);
      workers[0]!.fail();
      expect(workers[0]!.terminated).toBe(true);
      expect(workers).toHaveLength(2); // restarted
      expect(events).toEqual([{ type: 'worker-error', restarted: true, message: 'boom' }]);
      expect(client.stopped).toBe(false);
      client.post({ type: 'removeTables', tableIds: ['x'] });
      expect(workers[1]!.posted).toHaveLength(1); // the new worker receives the traffic
      for (let i = 0; i < MAX_RESTARTS; i += 1) workers.at(-1)!.fail();
      expect(events.at(-1)).toEqual({ type: 'worker-error', restarted: false, message: 'boom' });
      expect(client.stopped).toBe(true);
      expect(workers).toHaveLength(MAX_RESTARTS + 1);
      expect(client.mode).toBe('worker'); // a stopped client never matches on the main thread
      client.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('LOAD-05 the bar keeps the last results across a Worker restart, re-sends the index and shows the toast', async () => {
    const workers: FakeIndexWorker[] = [];
    // FAKE Worker that answers every query with one canned match until told to fail.
    class FakeIndexWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
      posted: { type: string; id?: number }[] = [];
      constructor() {
        workers.push(this);
      }
      postMessage(m: { type: string; id?: number }) {
        this.posted.push(m);
        if (m.type === 'query') {
          const id = m.id ?? 0;
          queueMicrotask(() => {
            this.onmessage?.({
              data: {
                type: 'results',
                id,
                indexed: 1,
                matches: [
                  {
                    id: 'document/d#name',
                    entryId: 'document/d',
                    field: 'name',
                    text: 'Canned',
                    distance: 0,
                    start: 0,
                    end: 6,
                    readOnly: true,
                    target: { kind: 'document', docId: 'd', title: 'Canned' },
                  },
                ],
              },
            });
          });
        }
      }
      terminate() {
        /* nothing to stop */
      }
      fail() {
        this.onerror?.({ message: 'boom', preventDefault: () => undefined });
      }
    }
    vi.stubGlobal('Worker', FakeIndexWorker);
    try {
      const { gd, sheet1 } = fixture();
      render(<Harness gd={gd} navigation={navigation()} sheetId={sheet1} />);
      await openAndType('Canned');
      await waitFor(() => {
        expect(count()).toBe('1 of 1');
      });
      const first = workers[0]!;
      expect(first.posted[0]?.type).toBe('reset');
      act(() => {
        first.fail();
      });
      // A new Worker got the whole index again and the query re-ran; the counter never blanked.
      expect(workers).toHaveLength(2);
      expect(workers[1]!.posted.map((m) => m.type)).toEqual(['reset', 'query']);
      expect(count()).toBe('1 of 1');
      expect(
        await screen.findByText('Find restarted after an error; results refreshed.'),
      ).toBeInTheDocument();
      for (let i = 0; i < MAX_RESTARTS; i += 1) {
        act(() => {
          workers.at(-1)!.fail();
        });
      }
      expect(
        await screen.findByText(
          'Find stopped after repeated errors. Close and reopen Find to try again.',
        ),
      ).toBeInTheDocument();
      expect(count()).toBe('1 of 1'); // last results kept
      // Reopening replaces the stopped client with a fresh one.
      const before = workers.length;
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      await userEvent.click(screen.getByRole('button', { name: 'Find' }));
      expect(workers.length).toBe(before + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('I18N-01 Enter during IME composition does not step', async () => {
    const { gd, sheet1 } = fixture();
    const nav = navigation();
    render(<Harness gd={gd} navigation={nav} sheetId={sheet1} />);
    const field = await openAndType('Singapore');
    await waitFor(() => {
      expect(count()).toBe('1 of 4');
    });
    fireEvent.keyDown(field, { code: 'Enter', key: 'Enter', isComposing: true });
    expect(count()).toBe('1 of 4');
    fireEvent.keyDown(field, { code: 'Enter', key: 'Enter' });
    expect(count()).toBe('2 of 4');
  });
});
