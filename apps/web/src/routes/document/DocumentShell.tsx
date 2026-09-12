import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import clsx from 'clsx';
import { lattice } from '@gede/tokens';
import { Banner, BrandMark, Button, Icon, Skeleton, Switch, Tabs } from '@gede/ui';
import { announce } from '../../announce.js';
import { getDocument, renameDocument, type DocumentSummary } from '../../api/documents.js';
import { rememberLastDocument } from '../../auth/session.js';
import { useMediaQuery } from '../../use-media-query.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; document: DocumentSummary }
  | { status: 'error'; error: unknown };

/** Column letters A…Z, AA…: computed, never stored. */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5] as const;

/**
 * Document shell — chrome only: title row, sheet strip, an empty canvas with
 * rulers on the 160 × 22 lattice. Below 768 px the product is read-only.
 */
export function DocumentShell() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const phone = useMediaQuery('(max-width: 767.98px)');
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [title, setTitle] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [gridlines, setGridlines] = useState(true);
  const [zoomIndex, setZoomIndex] = useState(2);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoad({ status: 'loading' });
    getDocument(id)
      .then((document) => {
        setLoad({ status: 'ready', document });
        setTitle(document.title);
        rememberLastDocument({ id: document.id, title: document.title });
        announce(`Opened ${document.title}`);
      })
      .catch((error: unknown) => {
        setLoad({ status: 'error', error });
      });
  }, [id]);

  // LIB-06: a freshly created workscape places the caret in the title.
  useEffect(() => {
    if (load.status === 'ready' && params.get('new') === '1' && !phone) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [load.status, params, phone]);

  if (load.status === 'error') throw load.error;

  const commitTitle = () => {
    if (load.status !== 'ready') return;
    const next = title.trim() === '' ? load.document.title : title.trim();
    setTitle(next);
    if (next === load.document.title) return;
    renameDocument(id, next)
      .then(() => {
        setLoad({ status: 'ready', document: { ...load.document, title: next } });
        rememberLastDocument({ id, title: next });
        setRenameError(null);
      })
      .catch(() => {
        setRenameError('The new name did not save. Retry when you are back online.');
      });
  };

  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // I18N-01
    if (e.code === 'Enter') e.currentTarget.blur();
    if (e.code === 'Escape' && load.status === 'ready') {
      setTitle(load.document.title);
      e.currentTarget.blur();
    }
  };

  const zoom = ZOOMS[zoomIndex] ?? 1;
  const doc = load.status === 'ready' ? load.document : null;

  return (
    <div className={clsx('gd-doc', { 'gd-doc--phone': phone })}>
      <header className="gd-doc__titlebar">
        <Link
          to="/"
          className="gd-doc__home"
          aria-label="Back to my workscapes"
          title="My workscapes"
        >
          <BrandMark size={24} />
        </Link>
        {phone ? (
          <h1 className="gd-doc__title-static">{doc?.title ?? ''}</h1>
        ) : (
          <input
            ref={titleRef}
            className="gd-doc__title"
            aria-label="Workscape title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
            onBlur={commitTitle}
            onKeyDown={onTitleKey}
            disabled={doc === null}
            spellCheck={false}
          />
        )}
        <span className="gd-doc__shared" data-slot="shared">
          {doc?.sharedBy !== undefined || doc?.sharedWithOthers === true ? (
            <span className="gd-doc__badge">
              <Icon name="people" size={13} /> Shared
            </span>
          ) : null}
        </span>
        {phone && (
          <span className="gd-doc__readonly" role="status">
            <Icon name="locked" size={13} /> View only on phone
          </span>
        )}
      </header>

      {!phone && (
        <div className="gd-doc__toolbar" role="toolbar" aria-label="View">
          <Switch label="Gridlines" checked={gridlines} onCheckedChange={setGridlines} />
          <span className="gd-doc__toolgap" />
          <Button
            size="sm"
            icon={<Icon name="zoom-in" size={13} />}
            aria-label="Zoom in"
            title="Zoom in (⌘+)"
            onClick={() => {
              setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1));
            }}
            disabled={zoomIndex === ZOOMS.length - 1}
          />
          <span className="gd-mono gd-doc__zoom" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            size="sm"
            icon={<Icon name="fit" size={13} />}
            aria-label="Actual size"
            title="Actual size (⌘0)"
            onClick={() => {
              setZoomIndex(2);
            }}
            disabled={zoomIndex === 2}
          />
        </div>
      )}

      {renameError !== null && (
        <div className="gd-doc__banner">
          <Banner
            cause="Rename not saved."
            remedy={renameError}
            action={
              <Button size="sm" onClick={commitTitle}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      <Skeleton
        active={doc === null}
        rows={8}
        statusLabel={`Loading workscape`}
        className="gd-doc__skeleton"
      >
        <div
          className={clsx('gd-canvas', { 'gd-canvas--gridlines': gridlines })}
          style={{ '--gd-zoom': zoom } as React.CSSProperties}
          aria-label="Canvas"
        >
          <div className="gd-canvas__corner" aria-hidden="true" />
          <div className="gd-canvas__cols" aria-hidden="true">
            {Array.from({ length: 26 }, (_, i) => (
              <span key={i} style={{ width: `${lattice.col}px` }}>
                {columnLetter(i)}
              </span>
            ))}
          </div>
          <div className="gd-canvas__rows" aria-hidden="true">
            {Array.from({ length: 60 }, (_, i) => (
              <span key={i} style={{ height: `${lattice.row}px` }}>
                {i + 1}
              </span>
            ))}
          </div>
          <div className="gd-canvas__sheet" />
        </div>
      </Skeleton>

      <footer className={clsx('gd-doc__sheets', { 'gd-doc__sheets--bottom': phone })}>
        <Tabs
          label="Sheets"
          value="sheet-1"
          onChange={() => undefined}
          items={[
            {
              value: 'sheet-1',
              label: (
                <span className="gd-doc__sheet">
                  <span className="gd-mono">1°</span> Sheet 1
                </span>
              ),
            },
          ]}
        />
      </footer>
    </div>
  );
}
