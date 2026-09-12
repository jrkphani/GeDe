import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button, Icon, Menu, type MenuEntry } from '@gede/ui';
import type { DocumentsView, DocumentSummary } from '../../api/documents.js';
import { formatBytes, formatDate } from '../../intl.js';
import type { Locale } from '../../locale.js';
import { flattenGroups, SHARED_BY_ME, SHARED_WITH_ME, type DocumentGroup } from './select.js';

export interface LibraryTableProps {
  groups: readonly DocumentGroup[];
  view: DocumentsView;
  locale: Locale;
  /** LIB-10: Kind and Shared columns drop and the date is numeric. */
  narrow: boolean;
  selectedId: string | null;
  onSelect: (doc: DocumentSummary) => void;
  onOpen: (doc: DocumentSummary) => void;
  /** LIB-03: the row overflow menu, revealed on the selected row. */
  rowMenu: (doc: DocumentSummary) => readonly MenuEntry[];
  /**
   * LIB-D6 / LIB-D7: a per-row action shown on every row of a view — Unarchive
   * in Archived, Recover in Recently Deleted. Rendered in the actions column
   * beside the overflow control; absent on phone, where the library is read-only.
   */
  rowAction?: ((doc: DocumentSummary) => ReactNode) | undefined;
}

const KIND_LABEL = { workscape: 'Workscape' } as const;

/** LIB-D10 / ONB-01: the guided sample is flagged in the Shared column, as the prototype does. */
export const SAMPLE_LABEL = 'Sample';

function sharerOf(doc: DocumentSummary): string {
  if (doc.sample === true) return SAMPLE_LABEL;
  if (doc.sharedBy !== undefined) return doc.sharedBy.name ?? SHARED_WITH_ME;
  return doc.sharedWithOthers === true ? SHARED_BY_ME : '—';
}

const DATE_LABEL: Record<DocumentsView, string> = {
  recents: 'Modified',
  browse: 'Modified',
  shared: 'Modified',
  deleted: 'Deleted',
  archived: 'Archived',
};

/** The date the view is about: deletion in Recently Deleted, archiving in Archived, else the edit. */
function dateOf(view: DocumentsView, d: DocumentSummary): string {
  if (view === 'deleted') return d.deletedAt ?? d.updatedAt;
  if (view === 'archived') return d.archivedAt ?? d.updatedAt;
  return d.updatedAt;
}

/**
 * LIB-02/03: one row per workscape — icon, name, kind, size, modified,
 * sharer. Single click selects, double click opens, Enter opens the
 * selection; arrows move the selection. Exactly one row selects at a time.
 */
export function LibraryTable({
  groups,
  view,
  locale,
  narrow,
  selectedId,
  onSelect,
  onOpen,
  rowMenu,
  rowAction,
}: LibraryTableProps) {
  const rows = flattenGroups(groups);
  const bodyRef = useRef<HTMLTableElement>(null);
  const columns = narrow ? 4 : 6;
  const dateLabel = DATE_LABEL[view];

  // Keep focus on the selected row when selection moves by keyboard.
  useEffect(() => {
    if (selectedId === null || bodyRef.current === null) return;
    const active = document.activeElement;
    if (active !== null && bodyRef.current.contains(active) && active !== bodyRef.current) {
      bodyRef.current.querySelector<HTMLElement>(`[data-id="${selectedId}"]`)?.focus();
    }
  }, [selectedId]);

  /** The selection, or failing that the focused row, is where arrows move from. */
  const anchorIndex = (): number => {
    if (selectedId !== null) return rows.findIndex((d) => d.id === selectedId);
    const focused = document.activeElement?.closest('[data-id]');
    const id = focused instanceof HTMLElement ? focused.dataset.id : undefined;
    return id === undefined ? -1 : rows.findIndex((d) => d.id === id);
  };

  const move = (delta: number | 'first' | 'last') => {
    if (rows.length === 0) return;
    const index = anchorIndex();
    let next: number;
    if (delta === 'first') next = 0;
    else if (delta === 'last') next = rows.length - 1;
    else next = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + delta));
    const doc = rows[next];
    if (doc !== undefined) onSelect(doc);
  };

  // Shortcuts resolve from `event.code` (I18N-02); nothing here fires while composing.
  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.code) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        return;
      case 'Home':
        e.preventDefault();
        move('first');
        return;
      case 'End':
        e.preventDefault();
        move('last');
        return;
      case 'Enter':
      case 'NumpadEnter': {
        const doc = rows.find((d) => d.id === selectedId);
        if (doc !== undefined) {
          e.preventDefault();
          onOpen(doc);
        }
        return;
      }
      default:
        return;
    }
  };

  const firstId = rows[0]?.id ?? null;

  return (
    <table
      ref={bodyRef}
      role="grid"
      className={clsx('gd-lib__table', {
        'gd-lib__table--narrow': narrow,
        'gd-lib__table--row-action': rowAction !== undefined,
      })}
      aria-label="Workscapes"
      aria-rowcount={rows.length}
      onKeyDown={onKeyDown}
    >
      <thead>
        <tr role="row">
          <th role="columnheader" scope="col">
            Name
          </th>
          {!narrow && (
            <th role="columnheader" scope="col">
              Kind
            </th>
          )}
          <th role="columnheader" scope="col" className="gd-lib__num">
            Size
          </th>
          <th role="columnheader" scope="col">
            {dateLabel}
          </th>
          {!narrow && (
            <th role="columnheader" scope="col">
              Shared
            </th>
          )}
          <th role="columnheader" scope="col" className="gd-lib__actions-col">
            <span className="gd-visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.id}>
          {g.label !== '' && (
            <tr className="gd-lib__group" role="row">
              <th role="rowheader" scope="rowgroup" colSpan={columns}>
                {g.label}
              </th>
            </tr>
          )}
          {g.rows.map((d) => {
            const selected = d.id === selectedId;
            return (
              <tr
                key={d.id}
                role="row"
                data-id={d.id}
                className={clsx('gd-lib__row', { 'gd-lib__row--selected': selected })}
                aria-selected={selected}
                tabIndex={selected || (selectedId === null && d.id === firstId) ? 0 : -1}
                data-tour={d.sample === true ? 'sample' : undefined}
                onClick={() => {
                  onSelect(d);
                }}
                onDoubleClick={() => {
                  onOpen(d);
                }}
              >
                <td role="gridcell" className="gd-lib__name">
                  <span className="gd-lib__name-inner">
                    <Icon name="table" size={15} className="gd-lib__doc-icon" />
                    <span className="gd-lib__title-text" title={d.title}>
                      {d.title}
                    </span>
                  </span>
                </td>
                {!narrow && (
                  <td role="gridcell" className="gd-lib__muted">
                    {KIND_LABEL[d.kind ?? 'workscape']}
                  </td>
                )}
                <td role="gridcell" className="gd-lib__num gd-lib__muted">
                  {d.sizeBytes !== undefined ? formatBytes(locale, d.sizeBytes) : '—'}
                </td>
                <td role="gridcell" className="gd-lib__muted">
                  <time dateTime={dateOf(view, d)}>
                    {formatDate(locale, dateOf(view, d), narrow ? 'numeric' : 'long')}
                  </time>
                </td>
                {!narrow && (
                  <td role="gridcell" className="gd-lib__muted">
                    {sharerOf(d)}
                  </td>
                )}
                <td
                  role="gridcell"
                  className="gd-lib__actions-col"
                  // Keys inside the overflow menu (and its portal) must not move the grid selection.
                  onKeyDown={(e) => {
                    e.stopPropagation();
                  }}
                >
                  {rowAction?.(d)}
                  {selected && (
                    <Menu
                      align="end"
                      label={`Actions for ${d.title}`}
                      entries={rowMenu(d)}
                      trigger={
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Icon name="more" size={15} />}
                          aria-label={`More actions for ${d.title}`}
                          title="More actions"
                          className="gd-lib__more"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                          }}
                        />
                      }
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}
