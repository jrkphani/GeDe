import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import * as Collapsible from '@radix-ui/react-collapsible';
import clsx from 'clsx';
import {
  Button,
  EmptyState,
  Icon,
  Menu,
  Skeleton,
  TextField,
  Wordmark,
  type IconName,
} from '@gede/ui';
import { announce } from '../../announce.js';
import { createDocument, listDocuments, type DocumentSummary } from '../../api/documents.js';
import { useSession } from '../../auth/session.js';
import { formatBytes, formatDate, useLocale } from '../../locale.js';
import { useMediaQuery } from '../../use-media-query.js';

export const LIBRARY_VIEWS = ['recents', 'browse', 'shared', 'deleted'] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

const VIEW_META: Record<LibraryView, { label: string; icon: IconName }> = {
  recents: { label: 'Recents', icon: 'sheet' },
  browse: { label: 'Browse', icon: 'table' },
  shared: { label: 'Shared', icon: 'people' },
  deleted: { label: 'Recently Deleted', icon: 'delete' },
};

function isView(v: string | null): v is LibraryView {
  return v !== null && (LIBRARY_VIEWS as readonly string[]).includes(v);
}

/** LIB-01 views over one collection; LIB-04 search filters the active view by name. */
export function selectDocuments(
  all: readonly DocumentSummary[],
  view: LibraryView,
  query: string,
): DocumentSummary[] {
  const q = query.trim().toLocaleLowerCase();
  const live = all.filter((d) => d.deletedAt === null || d.deletedAt === undefined);
  let rows: DocumentSummary[];
  switch (view) {
    case 'recents':
      rows = [...live].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      break;
    case 'browse':
      rows = [...live].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );
      break;
    case 'shared':
      rows = live
        .filter((d) => d.sharedBy !== undefined || d.sharedWithOthers === true)
        .sort(
          (a, b) =>
            (a.sharedBy ?? '').localeCompare(b.sharedBy ?? '') || a.title.localeCompare(b.title),
        );
      break;
    case 'deleted':
      rows = all
        .filter((d) => typeof d.deletedAt === 'string')
        .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
      break;
  }
  return q === '' ? rows : rows.filter((d) => d.title.toLocaleLowerCase().includes(q));
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; documents: DocumentSummary[] }
  | { status: 'error'; error: unknown };

export function Library() {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [locale] = useLocale();
  const view: LibraryView = isView(params.get('view'))
    ? (params.get('view') as LibraryView)
    : 'recents';
  const [query, setQuery] = useState('');
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [creating, setCreating] = useState(false);
  const narrow = useMediaQuery('(max-width: 899.98px)');
  const [navOpen, setNavOpen] = useState(false);

  const fetchDocuments = useCallback(() => {
    setLoad({ status: 'loading' });
    listDocuments()
      .then((documents) => {
        setLoad({ status: 'ready', documents });
      })
      .catch((error: unknown) => {
        setLoad({ status: 'error', error });
      });
  }, []);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // Route errors render the catalogue page; the boundary is the router's.
  if (load.status === 'error') throw load.error;

  const rows = useMemo(
    () => (load.status === 'ready' ? selectDocuments(load.documents, view, query) : []),
    [load, view, query],
  );
  const total = load.status === 'ready' ? load.documents.length : 0;

  const setView = (next: LibraryView) => {
    setParams(next === 'recents' ? {} : { view: next }, { replace: true });
    setNavOpen(false);
    announce(`${VIEW_META[next].label} view`);
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

  const user = session.state.status === 'signed-in' ? session.state.user : null;
  const signOut = () => {
    session
      .signOut()
      .catch(() => undefined)
      .finally(() => {
        void navigate('/signed-out', { replace: true });
      });
  };

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
        <Menu
          align="end"
          label="Account"
          trigger={
            <Button
              variant="ghost"
              icon={<Icon name="people" size={15} />}
              aria-label={user ? `Account: ${user.name ?? user.email}` : 'Account'}
            />
          }
          entries={[
            {
              kind: 'item',
              id: 'who',
              label: user?.email ?? '',
              onSelect: () => undefined,
              disabledReason: 'Signed in as this account',
            },
            { kind: 'separator', id: 's' },
            { kind: 'item', id: 'signout', label: 'Sign out', onSelect: signOut },
          ]}
        />
      </header>

      {narrow ? (
        // LIB-10: below 900 px the sidebar hides behind a control.
        <Collapsible.Root open={navOpen} onOpenChange={setNavOpen} className="gd-lib__collapsible">
          <Collapsible.Trigger asChild>
            <Button icon={<Icon name="collapse-rail" size={15} />} aria-expanded={navOpen}>
              {VIEW_META[view].label}
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content>{nav}</Collapsible.Content>
        </Collapsible.Root>
      ) : (
        <aside className="gd-lib__sidebar">{nav}</aside>
      )}

      <main className="gd-lib__main" aria-labelledby="gd-lib-title">
        <h1 id="gd-lib-title" className="gd-lib__title">
          {VIEW_META[view].label}
        </h1>
        <Skeleton active={load.status === 'loading'} rows={6} statusLabel="Loading your workscapes">
          {rows.length === 0 ? (
            <LibraryEmpty
              view={view}
              total={total}
              query={query}
              onCreate={create}
              creating={creating}
            />
          ) : (
            <table className="gd-lib__table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  {!narrow && <th scope="col">Kind</th>}
                  <th scope="col" className="gd-lib__num">
                    Size
                  </th>
                  <th scope="col">Modified</th>
                  {!narrow && <th scope="col">Shared</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr
                    key={d.id}
                    className="gd-lib__row"
                    onDoubleClick={() => {
                      void navigate(`/d/${d.id}`);
                    }}
                  >
                    <td>
                      <a
                        href={`/d/${d.id}`}
                        className="gd-lib__name"
                        onClick={(e) => {
                          e.preventDefault();
                          void navigate(`/d/${d.id}`);
                        }}
                      >
                        <Icon name="table" size={15} />
                        {d.title}
                      </a>
                    </td>
                    {!narrow && <td className="gd-lib__muted">Workscape</td>}
                    <td className="gd-lib__num gd-lib__muted">
                      {d.sizeBytes !== undefined ? formatBytes(locale, d.sizeBytes) : '—'}
                    </td>
                    <td className="gd-lib__muted">
                      <time dateTime={d.updatedAt}>
                        {formatDate(locale, d.updatedAt, narrow ? 'numeric' : 'long')}
                      </time>
                    </td>
                    {!narrow && (
                      <td className="gd-lib__muted">
                        {d.sharedBy ?? (d.sharedWithOthers ? 'Shared by me' : '—')}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Skeleton>
      </main>
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
  if (query.trim() !== '') {
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
  // AUTH-10 / LIB-01: first run.
  if (total === 0) {
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
  return <EmptyState label={VIEW_META[view].label.toLowerCase()} title="Nothing here yet" />;
}
