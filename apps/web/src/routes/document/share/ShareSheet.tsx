import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { Avatar, Badge, Button, Dialog, Icon, Select, Skeleton, TextField } from '@gede/ui';

import { announce } from '../../../announce.js';
import { ApiError } from '../../../api/client.js';
import { displayNameOf, type Participant } from '../../../api/documents.js';
import {
  getShareSheet,
  inviteToDocument,
  resendInvite,
  removeParticipant,
  setLinkAccess,
  setParticipantPermission,
  shareLink,
  stopSharing,
  withdrawInvite,
  type PendingInvite,
  type SharePermission,
  type ShareSheet as SheetModel,
} from '../../../api/shares.js';
import { formatDate } from '../../../intl.js';
import { useLocale } from '../../../locale.js';
import { reportTourInvite } from '../../tour/store.js';

/** #121: the invitation exists; only its mail did not go out. */
export const MAIL_FAILED_NOTICE =
  'Invitation saved — the email could not be sent; share the link or try again';
/** #121: the person already had an account and has access now; only the mail did not go out. */
export const SHARE_MAIL_FAILED_NOTICE =
  'Access given — the email could not be sent; share the link with them';

export interface ShareSheetProps {
  docId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus returns on close (the Share button). */
  returnFocusTo?: HTMLElement | null | undefined;
  /**
   * RESP-02: below 768 px the sheet shows who has access and offers the link,
   * and renders no edit affordance — no invite field, no permission control,
   * no remove, no stop sharing — whatever the caller's permission.
   */
  readOnly: boolean;
  /** The sheet after any change, so the chrome can update its Shared pill. */
  onChanged?: ((sheet: SheetModel) => void) | undefined;
}

type SheetState =
  | { status: 'loading' }
  | { status: 'ready'; sheet: SheetModel }
  | { status: 'error'; message: string };

type Access = 'invited' | 'link';

export const PERMISSION_OPTIONS = [
  { value: 'edit', label: 'Can make changes' },
  { value: 'view', label: 'View only' },
] as const satisfies readonly { value: SharePermission; label: string }[];

export const ACCESS_OPTIONS = [
  {
    value: 'invited',
    label: 'Only people you invite',
    description: 'The link opens for people listed here.',
  },
  {
    value: 'link',
    label: 'Anyone with the link',
    description: 'The link carries a key; anyone who has it gets the permission below.',
  },
] as const satisfies readonly { value: Access; label: string; description: string }[];

const PERMISSION_LABEL: Record<SharePermission, string> = {
  edit: 'Can make changes',
  view: 'View only',
};

/** Milliseconds the Copy link button reads "Link copied" before it reverts. */
export const COPIED_MS = 1400;

/** The `{ error: { message } }` of the error contract, when the body has it. */
function serverMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error = body.error;
  if (typeof error !== 'object' || error === null || !('message' in error)) return null;
  const message = error.message;
  return typeof message === 'string' && message !== '' ? message : null;
}

function describeFailure(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const ref = err.requestId !== undefined ? ` (ref ${err.requestId.slice(0, 6)})` : '';
    const message = serverMessage(err.body);
    if (message !== null) return `${message}${ref}.`;
    return `The service answered ${err.status}${ref}.`;
  }
  return fallback;
}

/**
 * SHARE-01: one sheet — who can access, permission, an invite field, the
 * participant list with per-person permission and remove, copy link, and
 * stop sharing. Built on the design system's Dialog (Radix: focus trapped,
 * Escape closes, focus returns to the Share button). Permission changes,
 * removal, link mode and stop sharing are the owner's; inviting is the
 * owner's and editors'; the service checks all of it again (SHARE-03).
 */
export function ShareSheet({
  docId,
  title,
  open,
  onOpenChange,
  returnFocusTo,
  readOnly,
  onChanged,
}: ShareSheetProps) {
  const [locale] = useLocale();
  const [state, setState] = useState<SheetState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [permission, setPermission] = useState<SharePermission>('edit');
  const [email, setEmail] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  /**
   * #121: an address with an account whose share mail was refused this
   * session. The person has access, so this is a notice and nothing to redo.
   * (An invitation whose mail was refused is read off the sheet itself:
   * `mailSentAt` null — the service keeps it, so a reload shows it too.)
   */
  const [shareMailFailed, setShareMailFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const adopt = useCallback(
    (sheet: SheetModel) => {
      setState({ status: 'ready', sheet });
      // While the link is on, the sheet-level Permission is the link's level.
      if (sheet.linkAccess !== 'none') setPermission(sheet.linkAccess);
      onChanged?.(sheet);
    },
    [onChanged],
  );

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setState({ status: 'loading' });
    setFailure(null);
    setConfirmStop(false);
    getShareSheet(docId, { signal: controller.signal })
      .then(adopt)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: describeFailure(err, 'The sharing settings could not be loaded.'),
        });
      });
    return () => {
      controller.abort();
    };
  }, [open, docId, attempt, adopt]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  /** Run one change against the service; a failure is shown in the sheet, never swallowed. */
  const run = async (what: string, action: () => Promise<SheetModel | undefined>) => {
    setBusy(what);
    setFailure(null);
    try {
      const next = await action();
      if (next !== undefined) adopt(next);
      return true;
    } catch (err) {
      setFailure(describeFailure(err, 'That change did not save. Retry when you are back online.'));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const sheet = state.status === 'ready' ? state.sheet : null;
  const isOwner = sheet?.permission === 'owner';
  const canInvite = !readOnly && sheet !== null && sheet.permission !== 'view';
  const canManage = !readOnly && isOwner;
  const access: Access = sheet !== null && sheet.linkAccess !== 'none' ? 'link' : 'invited';
  // "(you)" matches on the service's user id, which the sheet names as `callerId`
  // (review of #76: a viewer receives no emails, and the session holds only the Cognito sub).
  const isViewer = (p: { id: string }) => sheet !== null && p.id === sheet.callerId;
  // #121: invitations the service never managed to mail; persisted, so a reload shows them.
  const unsent = sheet === null ? [] : sheet.invites.filter((i) => i.mailSentAt === null);
  /** The one unsent invitation the notice can resend itself; with several, each row has Resend. */
  const soleUnsent = unsent.length === 1 ? unsent[0] : undefined;

  const onInvite = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (sheet === null) return;
    const address = email.trim();
    if (address === '' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) {
      setInviteError('Enter an email address, like meena@example.com.');
      emailRef.current?.focus();
      return;
    }
    setInviteError(null);
    setShareMailFailed(null);
    setBusy('invite');
    setFailure(null);
    try {
      const outcome = await inviteToDocument(docId, address, permission);
      adopt(outcome.shares);
      if (outcome.delivery === 'failed') {
        // The invitation (or share) exists; only its mail did not go out. An invitation
        // carries that on its row (`mailSentAt` null), which the sheet renders below.
        if (outcome.kind === 'share') setShareMailFailed(address);
        announce(
          `${outcome.kind === 'share' ? SHARE_MAIL_FAILED_NOTICE : MAIL_FAILED_NOTICE} (${address})`,
        );
      } else {
        announce(
          outcome.kind === 'share'
            ? `${address} now has access`
            : outcome.created
              ? `Invitation sent to ${address}; it is valid for 14 days`
              : `${address} already has a pending invitation`,
        );
      }
      // ONB-05, step 5: the action is the invitation, which now exists (or the address was
      // added on the spot) — whether or not its mail could be delivered (#121).
      reportTourInvite();
      setEmail('');
      emailRef.current?.focus();
    } catch (err) {
      // On the field (aria-invalid, aria-describedby), since it is the field's request that failed.
      setInviteError(
        describeFailure(err, 'The invitation did not save. Retry when you are back online.'),
      );
      emailRef.current?.focus();
    } finally {
      setBusy(null);
    }
  };

  /** #121: send an invitation's mail again; the row and its token stay as they are. */
  const onResend = (invite: { id: string; email: string }) =>
    run(`invite-resend:${invite.id}`, async () => {
      // The row's `mailSentAt` in the answered sheet says what happened; the words say it too.
      const outcome = await resendInvite(docId, invite.id);
      if (outcome.delivery === 'failed') {
        announce(`The email to ${invite.email} could not be sent again; share the link instead`);
      } else {
        announce(`Invitation sent again to ${invite.email}`);
      }
      return outcome.shares;
    });

  const onAccess = (next: Access) => {
    if (sheet === null || next === access) return;
    void run('link', () => setLinkAccess(docId, next === 'link' ? permission : 'none'));
  };

  const onPermission = (next: SharePermission) => {
    setPermission(next);
    // With the link on, the sheet-level permission is what the link grants.
    if (sheet !== null && sheet.linkAccess !== 'none' && next !== sheet.linkAccess) {
      void run('link', () => setLinkAccess(docId, next));
    }
  };

  const onCopyLink = async () => {
    if (sheet === null) return;
    const link = shareLink(window.location.origin, docId, sheet);
    try {
      await navigator.clipboard.writeText(link);
      announce('Link copied');
      setCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        setCopied(false);
      }, COPIED_MS);
    } catch {
      // No clipboard (permissions, insecure context): the link itself is announced and shown.
      setFailure(`The link could not be copied. It is ${link}`);
    }
  };

  const onStop = () =>
    run('stop', async () => {
      const next = await stopSharing(docId);
      announce('Sharing stopped');
      setConfirmStop(false);
      return next;
    });

  const busyLabel = (what: string, label: string) => (busy === what ? label : undefined);

  return (
    <Dialog
      variant="sheet"
      open={open}
      onOpenChange={onOpenChange}
      returnFocusTo={returnFocusTo}
      title={`Share ${title}`}
      description={
        readOnly
          ? 'Who has access. Sharing changes need a larger screen.'
          : 'Invite people by email, choose what they can do, or share a link.'
      }
      className="gd-share"
      actions={
        <>
          {sheet !== null && (
            <Button
              variant="secondary"
              icon={<Icon name="link" size={13} />}
              onClick={() => void onCopyLink()}
              aria-live="polite"
            >
              {copied ? 'Link copied' : 'Copy link'}
            </Button>
          )}
          {canManage && !confirmStop && (
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmStop(true);
              }}
              disabled={busy !== null}
            >
              Stop sharing
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        </>
      }
    >
      {state.status === 'error' ? (
        <div className="gd-share__error" role="alert">
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
        <Skeleton active={state.status === 'loading'} rows={5} statusLabel="Loading sharing">
          {sheet !== null && (
            <div className="gd-share__body">
              <section className="gd-share__section" aria-labelledby="gd-share-access-heading">
                <h3 id="gd-share-access-heading" className="gd-share__heading">
                  Who can access
                </h3>
                {canManage ? (
                  <Select
                    label="Who can access"
                    hideLabel
                    value={access}
                    onValueChange={onAccess}
                    options={ACCESS_OPTIONS}
                    disabled={busy !== null}
                  />
                ) : (
                  <p className="gd-share__value">
                    {access === 'link' ? 'Anyone with the link' : 'Only people you invite'}
                  </p>
                )}
              </section>

              {!readOnly && (
                <section
                  className="gd-share__section"
                  aria-labelledby="gd-share-permission-heading"
                >
                  <h3 id="gd-share-permission-heading" className="gd-share__heading">
                    Permission
                  </h3>
                  {canInvite ? (
                    <Select
                      label="Permission"
                      hideLabel
                      value={permission}
                      onValueChange={onPermission}
                      options={PERMISSION_OPTIONS}
                      disabled={busy !== null || (access === 'link' && !isOwner)}
                    />
                  ) : (
                    <p className="gd-share__value">{PERMISSION_LABEL[permission]}</p>
                  )}
                  <p className="gd-share__hint">
                    {access === 'link'
                      ? 'For people you invite and for anyone who opens the link.'
                      : 'For the people you invite next.'}
                  </p>
                </section>
              )}

              {canInvite && (
                <form className="gd-share__invite" noValidate onSubmit={(e) => void onInvite(e)}>
                  <TextField
                    ref={emailRef}
                    label="Add people by email"
                    type="email"
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (inviteError !== null) setInviteError(null);
                    }}
                    error={inviteError ?? undefined}
                    disabled={busy !== null}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    loading={busy === 'invite'}
                    loadingLabel="Inviting…"
                    disabled={busy !== null && busy !== 'invite'}
                  >
                    Invite
                  </Button>
                </form>
              )}
              {shareMailFailed !== null && (
                <p className="gd-share__notice" role="status" data-testid="share-mail-failed">
                  <Icon name="warning" size={13} />
                  <span>
                    {SHARE_MAIL_FAILED_NOTICE} ({shareMailFailed})
                  </span>
                </p>
              )}
              {canInvite && unsent.length > 0 && (
                <p className="gd-share__notice" role="status" data-testid="share-mail-failed">
                  <Icon name="warning" size={13} />
                  <span>
                    {MAIL_FAILED_NOTICE} ({unsent.map((i) => i.email).join(', ')})
                  </span>
                  {soleUnsent !== undefined && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === `invite-resend:${soleUnsent.id}`}
                      loadingLabel="Sending…"
                      disabled={busy !== null && busy !== `invite-resend:${soleUnsent.id}`}
                      onClick={() => void onResend(soleUnsent)}
                    >
                      Resend
                    </Button>
                  )}
                </p>
              )}

              <section className="gd-share__section" aria-labelledby="gd-share-people-heading">
                <h3 id="gd-share-people-heading" className="gd-share__heading">
                  People with access
                </h3>
                <ul className="gd-participants__list" aria-label="People with access">
                  <Person
                    person={sheet.owner}
                    you={isViewer(sheet.owner)}
                    trailing={<Badge>Owner</Badge>}
                  />
                  {sheet.participants.map((p) => (
                    <ParticipantRow
                      key={p.userId}
                      participant={p}
                      you={isViewer({ id: p.userId })}
                      manage={canManage}
                      busy={busy !== null}
                      onPermission={(next) =>
                        run(`permission:${p.userId}`, () =>
                          setParticipantPermission(docId, p, next),
                        )
                      }
                      onRemove={() =>
                        run(`remove:${p.userId}`, async () => {
                          await removeParticipant(docId, p);
                          announce(`${displayNameOf(p) ?? 'That person'} no longer has access`);
                          return getShareSheet(docId);
                        })
                      }
                    />
                  ))}
                  {sheet.invites.map((invite) => (
                    <InviteRow
                      key={invite.id}
                      invite={invite}
                      expires={formatDate(locale, invite.expiresAt)}
                      manage={canManage}
                      resend={canInvite}
                      mailFailed={invite.mailSentAt === null}
                      busy={busy !== null}
                      onResend={() => onResend(invite)}
                      onRemove={() =>
                        run(`invite-remove:${invite.id}`, async () => {
                          await withdrawInvite(docId, invite.id);
                          announce(`Invitation to ${invite.email} withdrawn`);
                          return getShareSheet(docId);
                        })
                      }
                    />
                  ))}
                </ul>
                {sheet.participants.length === 0 && sheet.invites.length === 0 && (
                  <p className="gd-share__hint">Only you, so far.</p>
                )}
              </section>

              {confirmStop && (
                <section
                  className="gd-share__confirm"
                  role="group"
                  aria-labelledby="gd-share-stop-heading"
                >
                  <h3 id="gd-share-stop-heading" className="gd-share__heading">
                    Stop sharing {title}?
                  </h3>
                  <p className="gd-share__hint">
                    Everyone listed loses access, pending invitations are withdrawn and the link
                    stops working. You keep the workscape.
                  </p>
                  <div className="gd-share__confirm-actions">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setConfirmStop(false);
                      }}
                      disabled={busy !== null}
                    >
                      Keep sharing
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => void onStop()}
                      loading={busy === 'stop'}
                      loadingLabel={busyLabel('stop', 'Stopping…')}
                      disabled={busy !== null && busy !== 'stop'}
                    >
                      Stop sharing
                    </Button>
                  </div>
                </section>
              )}

              {failure !== null && (
                <p className="gd-share__failure" role="alert">
                  <Icon name="error" size={13} /> {failure}
                </p>
              )}
            </div>
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

function ParticipantRow({
  participant,
  you,
  manage,
  busy,
  onPermission,
  onRemove,
}: {
  participant: Participant;
  you: boolean;
  manage: boolean;
  busy: boolean;
  onPermission: (next: SharePermission) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const who = displayNameOf(participant) ?? 'this person';
  // A link share is labelled: it goes when the link is switched off or re-minted.
  const via = participant.source === 'link' ? <Badge tone="neutral">Via link</Badge> : null;
  return (
    <Person
      person={participant}
      you={you}
      trailing={
        manage ? (
          <>
            {via}
            <Select
              label={`Permission for ${who}`}
              hideLabel
              aria-label={`Permission for ${who}`}
              size="sm"
              value={participant.permission}
              onValueChange={(next) => void onPermission(next)}
              options={PERMISSION_OPTIONS}
              disabled={busy}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="delete" size={13} />}
              aria-label={`Remove ${who}`}
              title="Remove"
              onClick={() => void onRemove()}
              disabled={busy}
            />
          </>
        ) : (
          <>
            {via}
            <span className="gd-participants__permission">
              {PERMISSION_LABEL[participant.permission]}
            </span>
          </>
        )
      }
    />
  );
}

function InviteRow({
  invite,
  expires,
  manage,
  resend,
  mailFailed,
  busy,
  onResend,
  onRemove,
}: {
  invite: PendingInvite;
  expires: string;
  manage: boolean;
  /** Owner and editors may send the mail again (#121). */
  resend: boolean;
  /** This session saw the invitation's mail refused. */
  mailFailed: boolean;
  busy: boolean;
  onResend: () => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  return (
    <li className="gd-participants__person gd-share__pending">
      <Avatar name={invite.email} size={30} decorative />
      <span className="gd-participants__who">
        <span className="gd-participants__name">{invite.email}</span>
        <span className="gd-participants__email">
          {mailFailed ? 'Invited · email not sent' : `Invited · expires ${expires}`}
        </span>
      </span>
      <span className="gd-participants__permission">{PERMISSION_LABEL[invite.permission]}</span>
      {resend && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Resend invitation to ${invite.email}`}
          title="Resend the invitation email"
          onClick={() => void onResend()}
          disabled={busy}
        >
          Resend
        </Button>
      )}
      {manage && (
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon name="delete" size={13} />}
          aria-label={`Withdraw invitation to ${invite.email}`}
          title="Withdraw"
          onClick={() => void onRemove()}
          disabled={busy}
        />
      )}
    </li>
  );
}
