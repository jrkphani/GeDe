import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { documentMeta, setTitle, type GedeDoc, type PresenceState } from '@gede/core';
import { BrandMark, Icon } from '@gede/ui';

import { ApiError } from '../../api/client.js';
import { renameDocument } from '../../api/documents.js';
import { rememberLastDocument } from '../../last-document.js';
import { useYVersion } from '../../doc/use-y.js';
import type { SyncSnapshot } from '../../doc/sync-client.js';
import { SharedIndicator } from './share/SharedIndicator.js';

export interface TitleBarProps {
  docId: string;
  gd: GedeDoc;
  /** The server's last known title; the fallback when the document title is emptied. */
  serverTitle: string;
  /** Owner-side "shared" flags from the library record. */
  sharedFlag: boolean;
  /** Other participants currently in the room (SHARE-05 avatars). */
  participants: readonly PresenceState[];
  /**
   * The sharing controls for the row (SHARE-01, SHARE-05): the Shared pill,
   * the Share button and its sheet. When given, it replaces the pill drawn
   * here from `sharedFlag` and `participants`.
   */
  shareSlot?: ReactNode | undefined;
  sync: SyncSnapshot;
  /** Until the document is ready, the field shows the record's title and does not edit. */
  ready: boolean;
  phone: boolean;
  editable: boolean;
  focusTitle: boolean;
  onRenameError: (message: string | null) => void;
  /**
   * ONB-01 / LIB-D10: the guided sample keeps its name. When set, the title
   * field is read-only and the reason is its tooltip; the service refuses a
   * rename of a sample with 409 `sample` regardless.
   */
  renameLocked?: string | undefined;
}

/** What the field says when the service refuses a rename for the sample (409 `sample`). */
export const SAMPLE_RENAME_REASON = 'The guided sample keeps its name';

function errorCode(error: ApiError): string | null {
  const body = error.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const inner = (body as { error?: unknown }).error;
  if (typeof inner !== 'object' || inner === null || !('code' in inner)) return null;
  const code = (inner as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Milliseconds of quiet after the last keystroke before the title PATCHes. */
export const TITLE_SAVE_DEBOUNCE_MS = 800;

const STATUS_LABEL: Record<SyncSnapshot['status'], string> = {
  connecting: 'Connecting',
  synced: 'Synced',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

/**
 * DOC-01: the mark returns to the library; the title is bound to `meta.title`
 * in the document and mirrored to the REST record behind a debounce; Shared
 * shows stacked avatars while any participant exists (SHARE-05); on phone the
 * chrome states "View only on phone" (RESP-02).
 */
export function TitleBar({
  docId,
  gd,
  serverTitle,
  sharedFlag,
  participants,
  shareSlot,
  sync,
  ready,
  phone,
  editable,
  focusTitle,
  onRenameError,
  renameLocked,
}: TitleBarProps) {
  useYVersion(gd.meta);
  const title = documentMeta(gd).title;
  const titleRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const lastSaved = useRef(serverTitle);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    lastSaved.current = serverTitle;
  }, [serverTitle]);

  // LIB-06: a freshly created workscape places the caret in the title.
  useEffect(() => {
    if (focusTitle && editable && ready) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [focusTitle, editable, ready]);

  const save = (next: string) => {
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === lastSaved.current) return;
    setSaving(true);
    renameDocument(docId, trimmed)
      .then(() => {
        lastSaved.current = trimmed;
        rememberLastDocument({ id: docId, title: trimmed });
        onRenameError(null);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 409 && errorCode(error) === 'sample') {
          // An editor of someone's sample: the name goes back and the reason is said once.
          setTitle(gd, lastSaved.current);
          onRenameError(SAMPLE_RENAME_REASON);
          return;
        }
        onRenameError('The new name did not save. Retry when you are back online.');
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const scheduleSave = (next: string) => {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      save(next);
    }, TITLE_SAVE_DEBOUNCE_MS);
  };
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  const onChange = (next: string) => {
    if (renameLocked !== undefined) return;
    setTitle(gd, next); // the document is the state; every keystroke is a (merged) undo step
    scheduleSave(next);
  };

  const commitNow = () => {
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
    }
    if (title.trim() === '') {
      setTitle(gd, lastSaved.current);
      return;
    }
    save(title);
  };

  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // I18N-01
    if (e.code === 'Enter') e.currentTarget.blur();
    if (e.code === 'Escape') {
      setTitle(gd, lastSaved.current);
      e.currentTarget.blur();
    }
  };

  return (
    <header className="gd-doc__titlebar">
      <Link
        to="/"
        className="gd-doc__home"
        aria-label="Back to my workscapes"
        title="My workscapes"
      >
        <BrandMark size={24} />
      </Link>
      {editable ? (
        <span className="gd-doc__title-wrap" aria-busy={saving || undefined}>
          <input
            ref={titleRef}
            className="gd-doc__title"
            aria-label="Workscape title"
            // The record is the source of truth until the document reconciles with it (M6).
            value={ready ? title : serverTitle}
            disabled={!ready}
            readOnly={renameLocked !== undefined}
            aria-readonly={renameLocked !== undefined || undefined}
            title={renameLocked}
            data-testid={renameLocked === undefined ? undefined : 'title-locked'}
            onChange={(e) => {
              onChange(e.target.value);
            }}
            onBlur={commitNow}
            onKeyDown={onTitleKey}
            spellCheck={false}
          />
          {saving && (
            <span className="gd-doc__saving" role="status">
              <Icon name="loading" size={13} className="gd-doc__spinner" /> Saving…
            </span>
          )}
        </span>
      ) : (
        // The static title truncates with an ellipsis (#124); the full name is one hover away
        // for a viewer or a read-only sync at any width (the accessible name is never cut).
        <h1 className="gd-doc__title-static" title={title === '' ? serverTitle : title}>
          {title === '' ? serverTitle : title}
        </h1>
      )}
      {/* Secondary controls: one row with the title from md up; below md the bar is two
          lines (DS §5 "two-line chrome bar") and these take the second, so the title, the
          mark and the read-only note always fit the first (#124). */}
      <div className="gd-doc__title-controls">
        <span className="gd-doc__shared" data-slot="shared">
          {shareSlot ?? <SharedIndicator sharedFlag={sharedFlag} participants={participants} />}
        </span>
        <span
          className={`gd-doc__sync gd-doc__sync--${sync.status}`}
          data-status={sync.status}
          data-testid="sync-status"
        >
          <span className="gd-doc__sync-dot" aria-hidden="true" />
          {STATUS_LABEL[sync.status]}
        </span>
      </div>
      {phone && (
        <span className="gd-doc__readonly" role="status">
          <Icon name="locked" size={13} /> View only on phone
        </span>
      )}
      {!phone && !editable && (
        <span className="gd-doc__readonly" role="status">
          <Icon name="locked" size={13} /> View only
        </span>
      )}
    </header>
  );
}
