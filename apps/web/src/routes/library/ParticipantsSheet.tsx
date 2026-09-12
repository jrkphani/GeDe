import { useEffect, useState, type ReactNode } from 'react';
import { Avatar, Badge, Button, Dialog, Icon, Skeleton } from '@gede/ui';
import { ApiError } from '../../api/client.js';
import {
  displayNameOf,
  getDocumentShares,
  type DocumentShares,
  type DocumentSummary,
} from '../../api/documents.js';

export interface ParticipantsSheetProps {
  /** The workscape whose participants to show; null closes the sheet. */
  document: DocumentSummary | null;
  onClose: () => void;
  /**
   * Who is looking, to mark "(you)". The service keys people by its own user
   * id, not the Cognito sub the session holds, so the verified email is what
   * actually matches; the id is honoured when it does.
   */
  viewerId: string | undefined;
  viewerEmail: string | undefined;
}

type SharesState =
  | { status: 'loading' }
  | { status: 'ready'; shares: DocumentShares }
  | { status: 'error'; message: string };

const PERMISSION_LABEL = { edit: 'Can make changes', view: 'View only' } as const;
const LINK_LABEL = {
  none: 'Only people listed here',
  view: 'Anyone with the link can view',
  edit: 'Anyone with the link can make changes',
} as const;

function describeFailure(err: unknown): string {
  if (err instanceof ApiError) {
    const ref = err.requestId !== undefined ? ` (ref ${err.requestId.slice(0, 6)})` : '';
    return err.status === 404
      ? `The participant list is not available yet${ref}.`
      : `The service answered ${err.status}${ref}.`;
  }
  return 'The participant list could not be loaded.';
}

/**
 * LIB-07: everyone with permission on a workscape, the owner labelled and
 * never removable. Fed by `GET /api/documents/:id/shares`; there is no remove
 * endpoint in the wave-1 contract, so Remove renders disabled with the reason.
 */
export function ParticipantsSheet({
  document,
  onClose,
  viewerId,
  viewerEmail,
}: ParticipantsSheetProps) {
  const [state, setState] = useState<SharesState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const id = document?.id;
  const isViewer = (p: { id: string; email: string | null }) =>
    p.id === viewerId || (p.email !== null && viewerEmail !== undefined && p.email === viewerEmail);

  useEffect(() => {
    if (id === undefined) return undefined;
    const controller = new AbortController();
    setState({ status: 'loading' });
    getDocumentShares(id, { signal: controller.signal })
      .then((shares) => {
        setState({ status: 'ready', shares });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', message: describeFailure(err) });
      });
    return () => {
      controller.abort();
    };
  }, [id, attempt]);

  return (
    <Dialog
      variant="sheet"
      open={document !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Participants"
      description={document !== null ? `Everyone with access to ${document.title}.` : undefined}
      className="gd-participants"
      actions={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {state.status === 'error' ? (
        <div className="gd-participants__error" role="alert">
          <Icon name="error" size={15} />
          <p>{state.message}</p>
          <Button
            size="sm"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <Skeleton active={state.status === 'loading'} rows={4} statusLabel="Loading participants">
          {state.status === 'ready' && (
            <>
              <ul className="gd-participants__list" aria-label="People with access">
                <Person
                  person={state.shares.owner}
                  you={isViewer(state.shares.owner)}
                  trailing={<Badge>Owner</Badge>}
                />
                {state.shares.participants.map((p) => {
                  const who = displayNameOf(p) ?? 'this person';
                  return (
                    <Person
                      key={p.userId}
                      person={p}
                      you={isViewer({ id: p.userId, email: p.email })}
                      trailing={
                        <>
                          <span className="gd-participants__permission">
                            {PERMISSION_LABEL[p.permission]}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Icon name="delete" size={13} />}
                            aria-label={`Remove ${who}`}
                            title="Removing people is not available yet"
                            disabled
                          />
                        </>
                      }
                    />
                  );
                })}
              </ul>
              <p className="gd-participants__link">
                <Icon name="link" size={13} />
                {LINK_LABEL[state.shares.linkAccess]}
              </p>
            </>
          )}
        </Skeleton>
      )}
    </Dialog>
  );
}

/** One person: name (or email when they have set none), email beneath, then what they may do. */
function Person({
  person,
  you,
  trailing,
}: {
  person: { name: string | null; email: string | null };
  you: boolean;
  trailing: ReactNode;
}) {
  const shown = displayNameOf(person) ?? 'No name on the account';
  return (
    <li className="gd-participants__person">
      <Avatar name={displayNameOf(person) ?? '?'} size={30} decorative />
      <span className="gd-participants__who">
        <span className="gd-participants__name">
          {shown}
          {you && ' (you)'}
        </span>
        {person.name !== null && person.email !== null && (
          <span className="gd-participants__email">{person.email}</span>
        )}
      </span>
      {trailing}
    </li>
  );
}
