import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import clsx from 'clsx';
import {
  AlertDialog,
  Banner,
  Button,
  Collapsible,
  EmptyState,
  Icon,
  SegmentedControl,
  Skeleton,
  TextField,
  Toast,
  Tooltip,
  Wordmark,
  type IconName,
  type MenuEntry,
} from '@gede/ui';
import { announce } from '../../announce.js';
import { ApiError } from '../../api/client.js';
import {
  archiveDocument,
  createDocument,
  deleteAllDocuments,
  deleteDocument,
  deletionModeOf,
  listDocuments,
  permissionOf,
  recoverAllDocuments,
  recoverDocument,
  unarchiveDocument,
  type DocumentsView,
  type DocumentSummary,
} from '../../api/documents.js';
import { useSession } from '../../auth/session.js';
import { collator } from '../../intl.js';
import { useLocale } from '../../locale.js';
import { usePhone } from '../../breakpoint.js';
import { useMediaQuery } from '../../use-media-query.js';
import { useTourAutoStart } from '../tour/TourController.js';
import { AccountMenu } from './AccountMenu.js';
import { HelpMenu } from './HelpMenu.js';
import { LibraryTable } from './LibraryTable.js';
import { ParticipantsSheet } from './ParticipantsSheet.js';
import { LIBRARY_REFRESH_MS, useLibraryRefresh } from './refresh.js';
import {
  filterByQuery,
  flattenGroups,
  groupDocuments,
  orderDocuments,
  type SortKey,
} from './select.js';
import { readSortPreference, writeSortPreference } from './sort-preference.js';

/** Sidebar order (prototype, PROTOTYPE-CHANGES §2.1): Recents · Browse · Shared · Archived · Recently Deleted. */
export const LIBRARY_VIEWS = [
  'recents',
  'browse',
  'shared',
  'archived',
  'deleted',
] as const satisfies readonly DocumentsView[];
export type LibraryView = DocumentsView;

const VIEW_META: Record<LibraryView, { label: string; icon: IconName }> = {
  recents: { label: 'Recents', icon: 'sheet' },
  browse: { label: 'Browse', icon: 'table' },
  shared: { label: 'Shared', icon: 'people' },
  archived: { label: 'Archived', icon: 'archive' },
  deleted: { label: 'Recently Deleted', icon: 'delete' },
};

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date' },
];

/**
 * Toolbar and toast copy (LIB-D2, LIB-D9, LIB-D10; PROTOTYPE-CHANGES §2.3, §2.5,
 * verbatim where the prototype has the string). Names are set in curly quotes.
 */
export const COPY = {
  archiveTip: 'Archive — shared workscapes cannot be deleted',
  sampleTip: 'The guided sample cannot be deleted',
  deleted: (name: string) => `“${name}” moved to Recently Deleted`,
  archived: (name: string) => `“${name}” archived — participants keep their access`,
  unarchived: (name: string) => `“${name}” unarchived`,
  recovered: (name: string) => `“${name}” recovered`,
  recoveredAll: (n: number) => `Recovered ${plural(n)}`,
  purgedOne: 'Deleted permanently — this one cannot be undone',
  purgedMany: (n: number) => `Deleted ${plural(n)} permanently — this cannot be undone`,
  phone: 'View only on phone',
} as const;

function plural(n: number): string {
  return `${n} ${n === 1 ? 'workscape' : 'workscapes'}`;
}

function isView(v: string | null): v is LibraryView {
  return v !== null && (LIBRARY_VIEWS as readonly string[]).includes(v);
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; documents: DocumentSummary[] }
  | { status: 'error'; error: unknown };

/** Same rows in the same order: a silent refresh then leaves the state alone (no re-render). */
function sameDocuments(a: readonly DocumentSummary[], b: readonly DocumentSummary[]): boolean {
  return a.length === b.length && a.every((doc, i) => JSON.stringify(doc) === JSON.stringify(b[i]));
}

/** A background action failed: say what, and why, with the reference for support. */
interface Failure {
  cause: string;
  remedy: string;
  /** Re-run the action that failed, when it can simply be tried again. */
  retry?: (() => void) | undefined;
}

/** The service's stable `error.code` from a parsed error body, when there is one. */
function errorCode(err: ApiError): string | undefined {
  const body: unknown = err.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const { error } = body;
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * `conflict` names what a 409 means for this action ("It is no longer in
 * Recently Deleted"); the two LIB-D refusals carry their own wording.
 */
function describeFailure(cause: string, err: unknown, conflict: string): Failure {
  if (err instanceof ApiError) {
    const ref = err.requestId !== undefined ? ` (ref ${err.requestId.slice(0, 6)})` : '';
    if (err.status === 404)
      return { cause, remedy: `This action is not available on the service yet${ref}.` };
    if (err.status === 403)
      return { cause, remedy: `You do not have permission to do that${ref}.` };
    if (err.status === 409) {
      const code = errorCode(err);
      if (code === 'shared')
        return {
          cause,
          remedy: `It has been shared, so it can be archived but not deleted${ref}.`,
        };
      if (code === 'sample')
        return { cause, remedy: `The guided sample cannot be deleted or archived${ref}.` };
      return { cause, remedy: `${conflict}${ref}. The view has been refreshed.` };
    }
    return {
      cause,
      remedy: `The service answered ${err.status} after ${err.attempts} ${err.attempts === 1 ? 'attempt' : 'attempts'}${ref}. Retry in a moment.`,
    };
  }
  return { cause, remedy: 'Retry in a moment.' };
}

/**
 * LIB-D9: every delete, archive, recover and unarchive raises one of these.
 * Reversible actions carry `undo`, which reverses through the API; permanent
 * ones say in `title` that they cannot be undone and carry none.
 */
interface Notice {
  title: string;
  undo?: (() => void) | undefined;
}

export function Library() {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [locale] = useLocale();
  const view: LibraryView = isView(params.get('view'))
    ? (params.get('view') as LibraryView)
    : 'recents';
  const user = session.state.status === 'signed-in' ? session.state.user : null;
  const sub = user?.sub ?? '';

  const [query, setQuery] = useState('');
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>(() => readSortPreference(sub));
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState<number | null>(null);
  const [sheetDoc, setSheetDoc] = useState<DocumentSummary | null>(null);
  // MENU-05 / A11Y-01: the sheet hands focus back to what opened it. A toolbar
  // button is still there when it closes; a row menu item is not, so the row
  // itself is the return point in that case.
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const rowElement = (id: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.gd-lib__row[data-id="${id}"]`);
  const [notice, setNotice] = useState<Notice | null>(null);
  // ONB-02: the first arrival at the library after sign-in starts the tour.
  useTourAutoStart();
  const narrow = useMediaQuery('(max-width: 899.98px)');
  // RESP-02 / non-negotiable 5: on a phone the product is read-only — no delete,
  // archive, recover or purge affordance renders in the library either (ADR-031;
  // the predicate and its fine-pointer exception are ADR-039).
  const phone = usePhone();
  const canManage = !phone;
  const [navOpen, setNavOpen] = useState(false);

  const fetchDocuments = useCallback(() => {
    setLoad({ status: 'loading' });
    listDocuments(view)
      .then((documents) => {
        setLoad({ status: 'ready', documents });
      })
      .catch((error: unknown) => {
        setLoad({ status: 'error', error });
      });
  }, [view]);

  useEffect(() => {
    fetchDocuments();
    setSelectedId(null);
  }, [fetchDocuments]);

  // LIB-D11: the same view, re-read silently on a cadence and when the tab
  // comes back, so a state change made by another client of this account —
  // an archive, a delete, a recover — appears without a reload. Only a
  // changed list replaces the state; a failed read is retried on the next tick.
  const inFlight = useRef(false);
  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    listDocuments(view)
      .then((documents) => {
        setLoad((prev) =>
          prev.status === 'ready' && !sameDocuments(prev.documents, documents)
            ? { status: 'ready', documents }
            : prev,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false;
      });
  }, [view]);
  useLibraryRefresh(refresh, {
    intervalMs: LIBRARY_REFRESH_MS,
    enabled: load.status === 'ready' && busy === null,
  });

  // LIB-05: the sort choice follows the signed-in user — the device's copy first,
  // then the account's (`users.library_sort`, #133) as soon as the profile answers.
  useEffect(() => {
    setSort(readSortPreference(sub));
  }, [sub]);
  const accountSort = session.profile?.librarySort ?? null;
  useEffect(() => {
    if (accountSort === null || sub === '') return;
    setSort(accountSort);
    writeSortPreference(sub, accountSort);
  }, [accountSort, sub]);

  // Route errors render the catalogue page; the boundary is the router's.
  if (load.status === 'error') throw load.error;

  const collate = useMemo(() => collator(locale), [locale]);
  const groups = useMemo(() => {
    if (load.status !== 'ready') return [];
    const ordered = orderDocuments(filterByQuery(load.documents, query), view, sort, collate);
    return groupDocuments(ordered, view, collate);
  }, [load, query, view, sort, collate]);
  const visible = useMemo(() => flattenGroups(groups), [groups]);
  const shown = visible.length;
  const total = load.status === 'ready' ? load.documents.length : 0;
  // LIB-03/LIB-04: selection is a row on screen. A search that hides the selected row drops
  // it, so the count never reads "1 of 0 selected" and the toolbar never acts on a row the
  // user cannot see.
  const selected = visible.find((d) => d.id === selectedId) ?? null;
  useEffect(() => {
    if (load.status === 'ready' && selectedId !== null && selected === null) setSelectedId(null);
  }, [load.status, selectedId, selected]);

  const setView = (next: LibraryView) => {
    setParams(next === 'recents' ? {} : { view: next }, { replace: true });
    setNavOpen(false);
    announce(`${VIEW_META[next].label} view`);
  };

  const changeSort = (next: SortKey) => {
    setSort(next);
    if (sub !== '') writeSortPreference(sub, next);
    announce(`Sorted by ${next}`);
    // LIB-05: per account. The row is sorted already; only the saving can fail, and then
    // the device keeps the choice until the next sign-in from a device that has it.
    session.updateProfile({ librarySort: next }).catch(() => {
      announce('Sort saved on this device only; the account could not be updated');
    });
  };

  const select = (doc: DocumentSummary) => {
    if (doc.id === selectedId) return;
    setSelectedId(doc.id);
    announce(`Selected ${doc.title}`);
  };

  const open = (doc: DocumentSummary) => {
    void navigate(`/d/${doc.id}`);
  };

  // LIB-06: + creates an untitled workscape and opens it immediately. The
  // library still works if it fails, so the failure is a banner with Retry
  // (§3 placement), not the full-page cell.
  const create = () => {
    setCreating(true);
    setFailure(null);
    createDocument()
      .then((doc) => {
        void navigate(`/d/${doc.id}?new=1`);
      })
      .catch((error: unknown) => {
        setCreating(false);
        setFailure({
          ...describeFailure('Could not create a workscape', error, 'It already exists'),
          retry: create,
        });
      });
  };

  /**
   * Run an action, refetch on success, surface a banner on failure. A 409 also
   * refetches: the state moved under this client (LIB-D11), so the view is
   * brought up to date along with the explanation.
   */
  const run = <T,>(
    id: string,
    cause: string,
    conflict: string,
    action: () => Promise<T>,
    done?: (result: T) => void,
  ) => {
    setBusy(id);
    setFailure(null);
    setNotice(null);
    action()
      .then((result) => {
        done?.(result);
        fetchDocuments();
      })
      .catch((err: unknown) => {
        setFailure(describeFailure(cause, err, conflict));
        if (err instanceof ApiError && err.status === 409) fetchDocuments();
      })
      .finally(() => {
        setBusy(null);
      });
  };

  /** LIB-D9: the confirmation toast; `undo` reverses through the API. */
  const notify = (title: string, undo?: () => void) => {
    announce(undo === undefined ? title : `${title}. Undo is available`);
    setNotice({ title, undo });
  };

  const remove = (doc: DocumentSummary) => {
    run(
      `delete-${doc.id}`,
      `Could not delete ${doc.title}`,
      'It is not there any more',
      () => deleteDocument(doc.id),
      () => {
        notify(COPY.deleted(doc.title), () => {
          run(
            `recover-${doc.id}`,
            `Could not recover ${doc.title}`,
            'It is no longer in Recently Deleted',
            () => recoverDocument(doc.id),
          );
        });
      },
    );
  };

  const archive = (doc: DocumentSummary) => {
    run(
      `archive-${doc.id}`,
      `Could not archive ${doc.title}`,
      'It is already archived',
      () => archiveDocument(doc.id),
      () => {
        notify(COPY.archived(doc.title), () => {
          run(
            `unarchive-${doc.id}`,
            `Could not unarchive ${doc.title}`,
            'It is not archived any more',
            () => unarchiveDocument(doc.id),
          );
        });
      },
    );
  };

  const unarchive = (doc: DocumentSummary) => {
    run(
      `unarchive-${doc.id}`,
      `Could not unarchive ${doc.title}`,
      'It is not archived any more',
      () => unarchiveDocument(doc.id),
      () => {
        notify(COPY.unarchived(doc.title), () => {
          run(`archive-${doc.id}`, `Could not archive ${doc.title}`, 'It is already archived', () =>
            archiveDocument(doc.id),
          );
        });
      },
    );
  };

  const recover = (doc: DocumentSummary) => {
    run(
      `recover-${doc.id}`,
      `Could not recover ${doc.title}`,
      'It is no longer in Recently Deleted',
      () => recoverDocument(doc.id),
      () => {
        notify(COPY.recovered(doc.title), () => {
          run(`delete-${doc.id}`, `Could not delete ${doc.title}`, 'It is not there any more', () =>
            deleteDocument(doc.id),
          );
        });
      },
    );
  };

  const recoverAll = () => {
    run(
      'recover-all',
      'Could not recover the deleted workscapes',
      'Nothing is in Recently Deleted',
      recoverAllDocuments,
      ({ count, ids }) => {
        // Undo deletes each recovered workscape again; the server answers
        // 409 for any that was shared meanwhile, and the banner says so.
        notify(
          COPY.recoveredAll(count),
          ids.length === 0
            ? undefined
            : () => {
                run(
                  'recover-all-undo',
                  'Could not move the recovered workscapes back',
                  'One of them is not there any more',
                  () => Promise.all(ids.map((id) => deleteDocument(id))),
                );
              },
        );
      },
    );
  };

  const deleteAll = () => {
    setConfirmDeleteAll(null);
    run(
      'delete-all',
      'Could not delete the deleted workscapes',
      'Nothing is in Recently Deleted',
      deleteAllDocuments,
      (n) => {
        notify(n === 1 ? COPY.purgedOne : COPY.purgedMany(n));
      },
    );
  };

  const signOut = () => {
    // Leave first: once the session flips to signed-out, RequireAuth would
    // send this route to /sign-in instead of the signed-out screen.
    void navigate('/signed-out', { replace: true });
    void session.signOut();
  };

  const noSelection = 'Select a workscape first';
  const ownerOnly = (doc: DocumentSummary, verb: string) =>
    permissionOf(doc) === 'owner' ? undefined : `Only the owner can ${verb} it`;

  /**
   * The fourth toolbar slot and the matching row-menu item (LIB-D1, LIB-D2,
   * LIB-D10; PROTOTYPE-CHANGES §2.3): Delete for a workscape nobody else
   * holds, Archive once someone does, neither for the guided sample. `reason`
   * is set when the action is unavailable and says why; `tip` otherwise.
   */
  const slot = (doc: DocumentSummary | null) => {
    const mode = doc === null ? 'delete' : deletionModeOf(doc);
    const label = mode === 'archive' ? 'Archive' : 'Delete';
    const icon: IconName = mode === 'archive' ? 'archive' : 'delete';
    const reason =
      doc === null
        ? noSelection
        : mode === 'sample'
          ? COPY.sampleTip
          : ownerOnly(doc, label.toLowerCase());
    const tip = mode === 'archive' ? COPY.archiveTip : label;
    const act = () => {
      if (doc === null || reason !== undefined) return;
      if (mode === 'archive') archive(doc);
      else remove(doc);
    };
    const busyId = doc === null ? '' : `${mode === 'archive' ? 'archive' : 'delete'}-${doc.id}`;
    return { mode, label, icon, reason, tip, act, busyId };
  };

  // LIB-03: the row overflow carries the same commands as the toolbar (MENU-02:
  // disabled, never hidden — except on phone, where none of them exist).
  const rowMenu = (doc: DocumentSummary): MenuEntry[] => {
    if (view === 'deleted') {
      return canManage
        ? [
            {
              kind: 'item',
              id: 'recover',
              label: 'Recover',
              onSelect: () => {
                recover(doc);
              },
              disabledReason: ownerOnly(doc, 'recover'),
            },
          ]
        : [];
    }
    const openItem: MenuEntry = {
      kind: 'item',
      id: 'open',
      label: 'Open',
      onSelect: () => {
        open(doc);
      },
      shortcut: 'Enter',
    };
    if (view === 'archived') {
      return canManage
        ? [
            openItem,
            {
              kind: 'item',
              id: 'unarchive',
              label: 'Unarchive',
              onSelect: () => {
                unarchive(doc);
              },
              disabledReason: ownerOnly(doc, 'unarchive'),
            },
          ]
        : [openItem];
    }
    const entries: MenuEntry[] = [
      openItem,
      {
        kind: 'item',
        id: 'share',
        label: 'Participants',
        onSelect: () => {
          setOpener(rowElement(doc.id));
          setSheetDoc(doc);
        },
      },
    ];
    if (canManage) {
      const s = slot(doc);
      entries.push(
        { kind: 'separator', id: 's' },
        {
          kind: 'item',
          id: s.mode === 'archive' ? 'archive' : 'delete',
          label: s.label,
          onSelect: s.act,
          disabledReason: s.reason,
        },
      );
    }
    return entries;
  };

  /** LIB-D6 / LIB-D7: the per-row Unarchive and Recover, on every row of those views. */
  const rowAction =
    canManage && (view === 'archived' || view === 'deleted')
      ? (doc: DocumentSummary) => {
          const isRecover = view === 'deleted';
          const verb = isRecover ? 'Recover' : 'Unarchive';
          const reason = ownerOnly(doc, verb.toLowerCase());
          const id = `${isRecover ? 'recover' : 'unarchive'}-${doc.id}`;
          return (
            <Button
              size="sm"
              icon={<Icon name="recover" size={13} />}
              className="gd-lib__row-action"
              aria-label={`${verb} ${doc.title}`}
              title={reason}
              disabled={reason !== undefined || busy !== null}
              loading={busy === id}
              loadingLabel={isRecover ? 'Recovering…' : 'Unarchiving…'}
              onClick={(e) => {
                e.stopPropagation();
                if (isRecover) recover(doc);
                else unarchive(doc);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
              }}
            >
              {verb}
            </Button>
          );
        }
      : undefined;

  const nav = (
    <nav className="gd-lib__nav" aria-label="Library views">
      {LIBRARY_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          className={clsx('gd-lib__navitem', { 'gd-lib__navitem--active': v === view })}
          aria-current={v === view ? 'page' : undefined}
          onClick={() => {
            setView(v);
          }}
        >
          <Icon name={VIEW_META[v].icon} size={15} />
          {VIEW_META[v].label}
        </button>
      ))}
    </nav>
  );

  const openButton = (
    <Button
      onClick={() => {
        if (selected) open(selected);
      }}
      disabled={selected === null}
      title={selected === null ? noSelection : undefined}
    >
      Open
    </Button>
  );

  const phoneNote = <p className="gd-lib__phone-note">{COPY.phone}</p>;

  const slotButton = () => {
    const s = slot(selected);
    const unavailable = s.reason !== undefined;
    return (
      <Tooltip content={unavailable ? s.reason : s.tip}>
        <Button
          icon={<Icon name={s.icon} size={15} />}
          onClick={s.act}
          // aria-disabled, not disabled: the control stays focusable so its
          // tooltip can say why (LIB-D2, LIB-D10), as the document toolbar does.
          aria-disabled={unavailable || undefined}
          data-mode={s.mode}
          loading={busy === s.busyId && s.busyId !== ''}
          loadingLabel={s.mode === 'archive' ? 'Archiving…' : 'Deleting…'}
          disabled={busy !== null}
        >
          {s.label}
        </Button>
      </Tooltip>
    );
  };

  const toolbar = (
    <div className="gd-lib__toolbar" role="toolbar" aria-label={`${VIEW_META[view].label} actions`}>
      {view === 'deleted' ? (
        !canManage ? (
          phoneNote
        ) : (
          <>
            <Button
              icon={<Icon name="recover" size={15} />}
              onClick={() => {
                if (selected) recover(selected);
              }}
              disabled={selected === null || busy !== null}
              title={selected === null ? noSelection : undefined}
              loading={busy === `recover-${selectedId ?? ''}`}
              loadingLabel="Recovering…"
            >
              Recover
            </Button>
            <span className="gd-lib__toolbar-gap" />
            {/* LIB-08: both disabled when the view is empty. */}
            <Button
              onClick={recoverAll}
              disabled={total === 0 || busy !== null}
              title={
                total === 0
                  ? 'Nothing to recover'
                  : 'Recover everything deleted in the last 30 days'
              }
              loading={busy === 'recover-all'}
              loadingLabel="Recovering…"
            >
              Recover All
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDeleteAll(total);
              }}
              disabled={total === 0 || busy !== null}
              title={total === 0 ? 'Nothing to delete' : undefined}
              loading={busy === 'delete-all'}
              loadingLabel="Deleting…"
            >
              Delete All
            </Button>
          </>
        )
      ) : view === 'archived' ? (
        <>
          {openButton}
          {canManage ? (
            <Button
              icon={<Icon name="recover" size={15} />}
              onClick={() => {
                if (selected) unarchive(selected);
              }}
              disabled={
                selected === null || ownerOnly(selected, 'unarchive') !== undefined || busy !== null
              }
              title={selected === null ? noSelection : ownerOnly(selected, 'unarchive')}
              loading={busy === `unarchive-${selectedId ?? ''}`}
              loadingLabel="Unarchiving…"
            >
              Unarchive
            </Button>
          ) : (
            phoneNote
          )}
        </>
      ) : (
        <>
          {/* One primary per view (DS): the first-run state owns it, so the toolbar is secondary. */}
          {openButton}
          <Button
            icon={<Icon name="people" size={15} />}
            onClick={(e) => {
              setOpener(e.currentTarget);
              setSheetDoc(selected);
            }}
            disabled={selected === null}
            title={selected === null ? noSelection : undefined}
          >
            Participants
          </Button>
          {canManage ? slotButton() : phoneNote}
          {view !== 'recents' && (
            <>
              <span className="gd-lib__toolbar-gap" />
              <SegmentedControl<SortKey>
                label="Sort by"
                options={SORT_OPTIONS}
                value={sort}
                onChange={changeSort}
                className="gd-lib__sort"
              />
            </>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className={clsx('gd-lib', { 'gd-lib--narrow': narrow })}>
      <header className="gd-lib__header">
        <Wordmark size={24} />
        <TextField
          label="Search workscapes"
          hideLabel
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          className="gd-lib__search"
          autoComplete="off"
        />
        <HelpMenu />
        {/* LIB-06: the + control. RESP-02 / non-negotiable 5: creating is an edit
            affordance, so nothing renders below 768 px (#134). */}
        {canManage && (
          <Button
            icon={<Icon name="plus" size={15} />}
            aria-label="New workscape"
            title="New workscape"
            onClick={create}
            loading={creating}
            loadingLabel="Creating…"
          />
        )}
        {user && <AccountMenu user={user} onSignOut={signOut} />}
      </header>

      {narrow ? (
        // LIB-10: below 900 px the sidebar hides behind a control.
        <Collapsible
          open={navOpen}
          onOpenChange={setNavOpen}
          className="gd-lib__collapsible"
          trigger={
            <Button icon={<Icon name="collapse-rail" size={15} />}>{VIEW_META[view].label}</Button>
          }
        >
          {nav}
        </Collapsible>
      ) : (
        <aside className="gd-lib__sidebar">{nav}</aside>
      )}

      <main className="gd-lib__main" aria-labelledby="gd-lib-title">
        <div className="gd-lib__heading">
          <h1 id="gd-lib-title" className="gd-lib__title">
            {VIEW_META[view].label}
          </h1>
          {load.status === 'ready' && (
            <p className="gd-lib__count">
              {selected !== null && !narrow
                ? `1 of ${shown} selected`
                : `${shown} ${shown === 1 ? 'item' : 'items'}`}
            </p>
          )}
          {load.status === 'ready' && view === 'deleted' && total > 0 && (
            // LIB-08: the 30-day retention is stated where the rows are, not only in the
            // empty state or a button's tooltip (#143).
            <p className="gd-lib__retention">
              Anything deleted stays here for 30 days, then is removed for good.
            </p>
          )}
        </div>
        {toolbar}
        {failure !== null && (
          <Banner
            tone="danger"
            cause={failure.cause}
            remedy={failure.remedy}
            className="gd-lib__banner"
            action={
              <>
                {failure.retry !== undefined && (
                  <Button size="sm" onClick={failure.retry} disabled={creating}>
                    Retry
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => {
                    setFailure(null);
                  }}
                >
                  Dismiss
                </Button>
              </>
            }
          />
        )}
        <Skeleton active={load.status === 'loading'} rows={6} statusLabel="Loading your workscapes">
          {groups.length === 0 ? (
            <LibraryEmpty
              view={view}
              total={total}
              query={query}
              onCreate={create}
              creating={creating}
              canCreate={canManage}
            />
          ) : (
            <LibraryTable
              groups={groups}
              view={view}
              locale={locale}
              narrow={narrow}
              selectedId={selectedId}
              onSelect={select}
              onOpen={open}
              rowMenu={rowMenu}
              rowAction={rowAction}
            />
          )}
        </Skeleton>
      </main>

      <ParticipantsSheet
        document={sheetDoc}
        viewerId={user?.sub}
        viewerEmail={user?.email}
        returnFocusTo={opener}
        onClose={() => {
          setSheetDoc(null);
        }}
      />

      {/* LIB-D8: Delete All is permanent, and says so before proceeding. */}
      <AlertDialog
        open={confirmDeleteAll !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDeleteAll(null);
        }}
        title={`Permanently delete ${plural(confirmDeleteAll ?? 0)}?`}
        description="Everything in Recently Deleted is removed for good. This cannot be undone."
        actionLabel="Delete All"
        onAction={deleteAll}
      />

      <Toast
        open={notice !== null}
        onOpenChange={(o) => {
          if (!o) setNotice(null);
        }}
        title={notice?.title ?? ''}
        undo={notice?.undo !== undefined ? { onUndo: notice.undo } : undefined}
      />
    </div>
  );
}

function LibraryEmpty({
  view,
  total,
  query,
  onCreate,
  creating,
  canCreate,
}: {
  view: LibraryView;
  total: number;
  query: string;
  onCreate: () => void;
  creating: boolean;
  /** RESP-02: no create affordance below 768 px (#134). */
  canCreate: boolean;
}) {
  // LIB-04: a search with no matches never shows a blank page.
  if (query.trim() !== '' && total > 0) {
    return (
      <EmptyState
        label={VIEW_META[view].label.toLowerCase()}
        title="No workscapes match"
        description={`Nothing in ${VIEW_META[view].label} is named like “${query.trim()}”.`}
      />
    );
  }
  // LIB-08: Recently Deleted empty state.
  if (view === 'deleted') {
    return (
      <EmptyState
        label="recently deleted"
        title="No items"
        description="Anything you delete stays here for 30 days."
      />
    );
  }
  // LIB-D6: Archived empty state (prototype copy).
  if (view === 'archived') {
    return (
      <EmptyState
        label="archived"
        title="Nothing archived"
        description="Archived workscapes stay here, with their participants, until you unarchive them."
      />
    );
  }
  if (view === 'shared') {
    return (
      <EmptyState
        label="shared"
        title="Nothing shared yet"
        description="Workscapes people share with you, and the ones you share, appear here."
      />
    );
  }
  // AUTH-10 / LIB-01: first run — one primary action; on phone, the read-only note instead.
  if (!canCreate) {
    return (
      <EmptyState
        label={VIEW_META[view].label.toLowerCase()}
        title="No workscapes yet"
        description={`Tables, formulas and context graphs on one shared sheet. ${COPY.phone}: create one from a larger screen.`}
      />
    );
  }
  return (
    <EmptyState
      label={VIEW_META[view].label.toLowerCase()}
      title="Create your first workscape"
      description="Tables, formulas and context graphs on one shared sheet."
      action={
        <Button
          variant="primary"
          size="lg"
          onClick={onCreate}
          loading={creating}
          loadingLabel="Creating…"
        >
          Create workscape
        </Button>
      }
    />
  );
}
