import { apiFetch, type RequestOptions } from './client.js';
import {
  toDocumentShares,
  type DocumentPermission,
  type DocumentShares,
  type Participant,
} from './documents.js';

/**
 * Sharing API (services/sync `routes/share.ts`, SHARE-01, SHARE-02). The
 * sheet's read model extends the LIB-07 participant list with pending
 * invitations, the link token and what the caller may do; every write
 * answers the refreshed sheet so the client never guesses.
 */
export type LinkAccess = 'none' | 'view' | 'edit';
export type SharePermission = 'view' | 'edit';

export interface PendingInvite {
  id: string;
  email: string;
  permission: SharePermission;
  invitedBy: string | null;
  expiresAt: string;
  /**
   * #121: ISO time SES last accepted the invitation's mail; null while it never
   * did — the sheet says "email not sent" and offers Resend, after a reload too.
   */
  mailSentAt: string | null;
}

export interface ShareSheet extends DocumentShares {
  invites: PendingInvite[];
  /** Present for the owner and editors while link access is on; null otherwise. */
  linkToken: string | null;
  /** What the caller may do with this sheet; absent in a wave-1 response, read as view. */
  permission: DocumentPermission;
  /** The caller's service user id, for "(you)"; absent in a wave-1 response. */
  callerId: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function toInvite(v: unknown): PendingInvite | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const email = str(v.email);
  const expiresAt = str(v.expiresAt);
  if (id === undefined || email === undefined || expiresAt === undefined) return null;
  return {
    id,
    email,
    permission: v.permission === 'edit' ? 'edit' : 'view',
    invitedBy: str(v.invitedBy) ?? null,
    expiresAt,
    mailSentAt: str(v.mailSentAt) ?? null,
  };
}

/** Tolerant reader over the LIB-07 shape: unknown fields are dropped, missing ones read as the least. */
export function toShareSheet(v: unknown): ShareSheet | null {
  const base = toDocumentShares(v);
  if (!base || !isRecord(v)) return null;
  const invites = Array.isArray(v.invites)
    ? v.invites.map(toInvite).filter((i): i is PendingInvite => i !== null)
    : [];
  const permission =
    v.permission === 'owner' || v.permission === 'edit' || v.permission === 'view'
      ? v.permission
      : 'view';
  return {
    ...base,
    invites,
    linkToken: str(v.linkToken) ?? null,
    permission,
    callerId: str(v.callerId) ?? null,
  };
}

function sheetOf(raw: unknown): ShareSheet {
  const sheet = toShareSheet(raw);
  if (!sheet) throw new Error('The shares response was not in the expected shape');
  return sheet;
}

function encode(id: string): string {
  return encodeURIComponent(id);
}

/** `GET /api/documents/:id/shares`. */
export async function getShareSheet(id: string, options?: RequestOptions): Promise<ShareSheet> {
  return sheetOf(await apiFetch<unknown>(`/documents/${encode(id)}/shares`, options));
}

/** What became of the mail a share or an invitation sends (#121). */
export type MailDelivery = 'sent' | 'failed' | 'skipped';

export interface InviteOutcome {
  /** `share` when the address already had an account (they have access now), `invite` when a row was made. */
  kind: 'share' | 'invite';
  /** False when an invitation for the address already stood: nothing was written, no mail went out. */
  created: boolean;
  /**
   * `failed`: the share or invitation stands but its mail was refused (SES in
   * the sandbox, an outage) — share the link, or Resend. `skipped`: nothing
   * was sent because nothing was created, or because the member's address
   * cannot receive mail from GeDe (the share stands, ADR-046).
   */
  delivery: MailDelivery;
  shares: ShareSheet;
}

function deliveryOf(raw: unknown, created: boolean): MailDelivery {
  const value = isRecord(raw) ? raw.delivery : undefined;
  if (value === 'sent' || value === 'failed' || value === 'skipped') return value;
  return created ? 'sent' : 'skipped';
}

/**
 * `POST /api/documents/:id/invites` — owner or editor. Never retried by the
 * client (review of #76): the call writes a row, and is idempotent per
 * address on the service anyway. A refused mail is not an error (#121): the
 * row stands and `delivery` says so.
 */
export async function inviteToDocument(
  id: string,
  email: string,
  permission: SharePermission,
  options?: RequestOptions,
): Promise<InviteOutcome> {
  const raw = await apiFetch<unknown>(`/documents/${encode(id)}/invites`, {
    ...options,
    method: 'POST',
    body: { email, permission },
    retry: false,
  });
  const kind = isRecord(raw) && raw.kind === 'share' ? 'share' : 'invite';
  const created = !(isRecord(raw) && raw.created === false);
  return {
    kind,
    created,
    delivery: deliveryOf(raw, created),
    shares: sheetOf(isRecord(raw) ? raw.shares : raw),
  };
}

/**
 * `POST /api/documents/:id/invites/:inviteId/resend` — owner or editor. Sends
 * the same invitation again (same token, same expiry); rate-limited with
 * invitations, never retried by the client.
 */
export async function resendInvite(
  id: string,
  inviteId: string,
  options?: RequestOptions,
): Promise<{ delivery: MailDelivery; shares: ShareSheet }> {
  const raw = await apiFetch<unknown>(
    `/documents/${encode(id)}/invites/${encode(inviteId)}/resend`,
    { ...options, method: 'POST', retry: false },
  );
  return { delivery: deliveryOf(raw, true), shares: sheetOf(isRecord(raw) ? raw.shares : raw) };
}

/** `DELETE /api/documents/:id/invites/:inviteId` — owner only. */
export async function withdrawInvite(
  id: string,
  inviteId: string,
  options?: RequestOptions,
): Promise<void> {
  await apiFetch<unknown>(`/documents/${encode(id)}/invites/${encode(inviteId)}`, {
    ...options,
    method: 'DELETE',
  });
}

/** `POST /api/documents/:id/invites/accept { token }` — the invitation mail's link, signed in. */
export async function acceptInvite(
  id: string,
  token: string,
  options?: RequestOptions,
): Promise<void> {
  await apiFetch<unknown>(`/documents/${encode(id)}/invites/accept`, {
    ...options,
    method: 'POST',
    body: { token },
  });
}

/** `PATCH /api/documents/:id/shares/:userId { permission }` — owner only. */
export async function setParticipantPermission(
  id: string,
  participant: Pick<Participant, 'userId'>,
  permission: SharePermission,
  options?: RequestOptions,
): Promise<ShareSheet> {
  return sheetOf(
    await apiFetch<unknown>(`/documents/${encode(id)}/shares/${encode(participant.userId)}`, {
      ...options,
      method: 'PATCH',
      body: { permission },
    }),
  );
}

/** `DELETE /api/documents/:id/shares/:userId` — owner only. */
export async function removeParticipant(
  id: string,
  participant: Pick<Participant, 'userId'>,
  options?: RequestOptions,
): Promise<void> {
  await apiFetch<unknown>(`/documents/${encode(id)}/shares/${encode(participant.userId)}`, {
    ...options,
    method: 'DELETE',
  });
}

/** `PATCH /api/documents/:id/link { access }` — owner only. */
export async function setLinkAccess(
  id: string,
  access: LinkAccess,
  options?: RequestOptions,
): Promise<ShareSheet> {
  return sheetOf(
    await apiFetch<unknown>(`/documents/${encode(id)}/link`, {
      ...options,
      method: 'PATCH',
      body: { access },
    }),
  );
}

/** `POST /api/documents/:id/link/redeem { token }` — opened `?k=` signed in. */
export async function redeemLink(
  id: string,
  token: string,
  options?: RequestOptions,
): Promise<void> {
  await apiFetch<unknown>(`/documents/${encode(id)}/link/redeem`, {
    ...options,
    method: 'POST',
    body: { token },
  });
}

/** `POST /api/documents/:id/stop-sharing` — owner only. */
export async function stopSharing(id: string, options?: RequestOptions): Promise<ShareSheet> {
  return sheetOf(
    await apiFetch<unknown>(`/documents/${encode(id)}/stop-sharing`, {
      ...options,
      method: 'POST',
    }),
  );
}

/**
 * The link "Copy link" copies (SHARE-01). With link access on, and the token
 * in hand, it carries `?k=`; otherwise it is the plain document address,
 * which only listed people can open.
 */
export function shareLink(
  origin: string,
  id: string,
  sheet: Pick<ShareSheet, 'linkToken'>,
): string {
  const base = `${origin}/d/${encode(id)}`;
  return sheet.linkToken === null ? base : `${base}?k=${encodeURIComponent(sheet.linkToken)}`;
}
