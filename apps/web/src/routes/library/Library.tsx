import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import clsx from 'clsx';
import {
  Banner,
  Button,
  Collapsible,
  Dialog,
  EmptyState,
  Icon,
  SegmentedControl,
  Skeleton,
  TextField,
  Toast,
  Wordmark,
  type IconName,
  type MenuEntry,
} from '@gede/ui';
import { announce } from '../../announce.js';
import { ApiError } from '../../api/client.js';
import {
  createDocument,
  deleteAllDocuments,
  deleteDocument,
  listDocuments,
  permissionOf,
  recoverAllDocuments,
  recoverDocument,
  type DocumentsView,
  type DocumentSummary,
} from '../../api/documents.js';
import { useSession } from '../../auth/session.js';
import { collator } from '../../intl.js';
import { useLocale } from '../../locale.js';
import { useMediaQuery } from '../../use-media-query.js';
import { AccountMenu } from './AccountMenu.js';
import { LibraryTable } from './LibraryTable.js';
import { ParticipantsSheet } from './ParticipantsSheet.js';
import { filterByQuery, groupDocuments, orderDocuments, type SortKey } from './select.js';
import { readSortPreference, writeSortPreference } from './sort-preference.js';

export const LIBRARY_VIEWS = [
  'recents',
  'browse',
  'shared',
  'deleted',
] as const satisfies readonly DocumentsView[];
export type LibraryView = DocumentsView;

const VIEW_META: Record<LibraryView, { label: string; icon: IconName }> = {
  recents: { label: 'Recents', icon: 'sheet' },
  browse: { label: 'Browse', icon: 'table' },
  shared: { label: 'Shared', icon: 'people' },
  deleted: { label: 'Recently Deleted', icon: 'delete' },
};

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date' },
];

function isView(v: string | null): v is LibraryView {
  return v !== null && (LIBRARY_VIEWS as readonly string[]).includes(v);
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; documents: DocumentSummary[] }
  | { status: 'error'; error: unknown };

/** A background action failed: say what, and why, with the reference for support. */
interface Failure {
  cause: string;
  remedy: string;
}

function describeFailure(cause: string, err: unknown): Failure {
  if (err instanceof ApiError) {
    const ref = err.requestId !== undefined ? ` (ref ${err.requestId.slice(0, 6)})` : '';
    if (err.status === 404)
      return { cause, remedy: `This action is not available on the service yet${ref}.` };
    if (err.status === 403)
      return { cause, remedy: `You do not have permission to do that${ref}.` };
    if (err.status === 409)
      return { cause, remedy: `It is no longer in Recently Deleted${ref}. Refresh the view.` };
    return {
      cause,
      remedy: `The service answered ${err.status} after ${err.attempts} ${err.attempts === 1 ? 'attempt' : 'attempts'}${ref}. Retry in a moment.`,
    };
  }
  return { cause, remedy: 'Retry in a moment.' };
}

type Confirm = { kind: 'delete'; doc: DocumentSummary } | { kind: 'delete-all'; count: number };

interface Undo {
  title: string;
  onUndo: () => void;
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
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [sheetDoc, setSheetDoc] = useState<DocumentSummary | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const narrow = useMediaQuery('(max-width: 899.98px)');
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

  // LIB-05: the sort choice follows the signed-in user.
  useEffect(() => {
    setSort(readSortPreference(sub));
  }, [sub]);

  // Route errors render the catalogue page; the boundary is the router's.
  if (load.status === 'error') throw load.error;

  const collate = useMemo(() => collator(locale), [locale]);
  const groups = useMemo(() => {
    if (load.status !== 'ready') return [];
    const ordered = orderDocuments(filterByQuery(load.documents, query), view, sort, collate);
    return groupDocuments(ordered, view, collate);
  }, [load, query, view, sort, collate]);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const total = load.status === 'ready' ? load.documents.length : 0;
  const selected =
    load.status === 'ready' ? (load.documents.find((d) => d.id === selectedId) ?? null) : null;

  const setView = (next: LibraryView) => {
    setParams(next === 'recents' ? {} : { view: next }, { replace: true });
    setNavOpen(false);
    announce(`${VIEW_META[next].label} view`);
  };

  const changeSort = (next: SortKey) => {
    setSort(next);
    if (sub !== '') writeSortPreference(sub, next);
    announce(`Sorted by ${next}`);
  };

  const select = (doc: DocumentSummary) => {
    if (doc.id === selectedId) return;
    setSelectedId(doc.id);
    announce(`Selected ${doc.title}`);
  };

  const open = (doc: DocumentSummary) => {
    void navigate(`/d/${doc.id}`);
  };

  // LIB-06: + creates an untitled workscape and opens it immediately.
  const create = () => {
    setCreating(true);
    createDocument()
      .then((doc) => {
        void navigate(`/d/${doc.id}?new=1`);
      })
      .catch((error: unknown) => {
        setCreating(false);
        setLoad({ status: 'error', error });
      });
  };

  /** Run an action, refetch on success, surface a banner on failure. */
  const run = <T,>(
    id: string,
    cause: string,
    action: () => Promise<T>,
    done?: (result: T) => void,
  ) => {
    setBusy(id);
    setFailure(null);
    action()
      .then((result) => {
        done?.(result);
        fetchDocuments();
      })
      .catch((err: unknown) => {
        setFailure(describeFailure(cause, err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const remove = (doc: DocumentSummary) => {
    setConfirm(null);
    run(
      `delete-${doc.id}`,
      `Could not delete ${doc.title}`,
      () => deleteDocument(doc.id),
      () => {
        announce(`Deleted ${doc.title}. Undo is available`);
        setUndo({
          title: `${doc.title} moved to Recently Deleted`,
          onUndo: () => {
            setUndo(null);
            run(`recover-${doc.id}`, `Could not recover ${doc.title}`, () =>
              recoverDocument(doc.id),
            );
          },
        });
      },
    );
  };

  const recover = (doc: DocumentSummary) => {
    run(
      `recover-${doc.id}`,
      `Could not recover ${doc.title}`,
      () => recoverDocument(doc.id),
      () => {
        announce(`${doc.title} recovered`);
      },
    );
  };

  const plural = (n: number) => `${n} ${n === 1 ? 'workscape' : 'workscapes'}`;

  const recoverAll = () => {
    run('recover-all', 'Could not recover the deleted workscapes', recoverAllDocuments, (n) => {
      announce(`Recovered ${plural(n)}`);
    });
  };

  const deleteAll = () => {
    setConfirm(null);
    run('delete-all', 'Could not delete the deleted workscapes', deleteAllDocuments, (n) => {
      announce(`Deleted ${plural(n)} permanently`);
    });
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

  // LIB-03: the row overflow carries the same commands as the toolbar (MENU-02: disabled, never hidden).
  const rowMenu = (doc: DocumentSummary): MenuEntry[] =>
    view === 'deleted'
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
      : [
          {
            kind: 'item',
            id: 'open',
            label: 'Open',
            onSelect: () => {
              open(doc);
            },
            shortcut: 'Enter',
          },
          {
            kind: 'item',
            id: 'share',
            label: 'Participants',
            onSelect: () => {
              setSheetDoc(doc);
            },
          },
          { kind: 'separator', id: 's' },
          {
            kind: 'item',
            id: 'delete',
            label: 'Delete',
            onSelect: () => {
              setConfirm({ kind: 'delete', doc });
            },
            disabledReason: ownerOnly(doc, 'delete'),
          },
        ];

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

  const toolbar = (
    <div className="gd-lib__toolbar" role="toolbar" aria-label={`${VIEW_META[view].label} actions`}>
      {view === 'deleted' ? (
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
              total === 0 ? 'Nothing to recover' : 'Recover everything deleted in the last 30 days'
            }
            loading={busy === 'recover-all'}
            loadingLabel="Recovering…"
          >
            Recover All
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirm({ kind: 'delete-all', count: total });
            }}
            disabled={total === 0 || busy !== null}
            title={total === 0 ? 'Nothing to delete' : undefined}
          >
            Delete All
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="primary"
            onClick={() => {
              if (selected) open(selected);
            }}
            disabled={selected === null}
            title={selected === null ? noSelection : undefined}
          >
            Open
          </Button>
          <Button
            icon={<Icon name="people" size={15} />}
            onClick={() => {
              setSheetDoc(selected);
            }}
            disabled={selected === null}
            title={selected === null ? noSelection : undefined}
          >
            Participants
          </Button>
          <Button
            icon={<Icon name="delete" size={15} />}
            onClick={() => {
              if (selected) setConfirm({ kind: 'delete', doc: selected });
            }}
            disabled={
              selected === null || ownerOnly(selected, 'delete') !== undefined || busy !== null
            }
            title={selected === null ? noSelection : ownerOnly(selected, 'delete')}
          >
            Delete
          </Button>
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
        <Button
          variant="primary"
          icon={<Icon name="add-row" size={15} />}
          aria-label="New workscape"
          title="New workscape"
          onClick={create}
          loading={creating}
          loadingLabel="Creating…"
        />
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
        </div>
        {toolbar}
        {failure !== null && (
          <Banner
            tone="danger"
            cause={failure.cause}
            remedy={failure.remedy}
            className="gd-lib__banner"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setFailure(null);
                }}
              >
                Dismiss
              </Button>
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
            />
          )}
        </Skeleton>
      </main>

      <ParticipantsSheet
        document={sheetDoc}
        viewerId={user?.sub}
        onClose={() => {
          setSheetDoc(null);
        }}
      />

      <Dialog
        open={confirm?.kind === 'delete'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title={confirm?.kind === 'delete' ? `Delete ${confirm.doc.title}?` : ''}
        description="It moves to Recently Deleted, where it can be recovered for 30 days."
        actions={
          <>
            <Button
              onClick={() => {
                setConfirm(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirm?.kind === 'delete') remove(confirm.doc);
              }}
            >
              Delete
            </Button>
          </>
        }
      />

      <Dialog
        open={confirm?.kind === 'delete-all'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title={
          confirm?.kind === 'delete-all'
            ? `Permanently delete ${confirm.count} ${confirm.count === 1 ? 'workscape' : 'workscapes'}?`
            : ''
        }
        description="Everything in Recently Deleted is removed for good. This cannot be undone."
        actions={
          <>
            <Button
              onClick={() => {
                setConfirm(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={deleteAll}>
              Delete All
            </Button>
          </>
        }
      />

      <Toast
        open={undo !== null}
        onOpenChange={(o) => {
          if (!o) setUndo(null);
        }}
        title={undo?.title ?? ''}
        undo={undo !== null ? { onUndo: undo.onUndo } : undefined}
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
}: {
  view: LibraryView;
  total: number;
  query: string;
  onCreate: () => void;
  creating: boolean;
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
  if (view === 'shared') {
    return (
      <EmptyState
        label="shared"
        title="Nothing shared yet"
        description="Workscapes people share with you, and the ones you share, appear here."
      />
    );
  }
  // AUTH-10 / LIB-01: first run — one primary action.
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
