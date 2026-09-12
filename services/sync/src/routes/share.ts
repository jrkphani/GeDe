/**
 * Sharing under `/api/documents/:id` (ARCHITECTURE §1.3 "Documents & Sharing
 * API": invite, change permission, revoke, link mode; sends SES invitations).
 * Registered by `api.ts` inside the `/api` plugin, so the auth hook and the
 * per-user limiter have run; `request.user` is always set.
 *
 * Who may do what (SHARE-03, checked here on every route, never in the SPA):
 *   - see the sheet: any participant (`view`); a viewer sees names only —
 *     no emails, no pending invitations, no link token.
 *   - invite: the owner and editors ("people you invite can make changes and
 *     add others", prototype), at `view` or `edit`.
 *   - change a permission, remove a person, withdraw an invitation, set the
 *     link mode, stop sharing: the owner only.
 *   - redeem a link, accept an invitation: any signed-in user, for themselves.
 *
 * A share change reaches live sockets (SHARE-03): a removed participant's
 * connections close with 4403, a changed one's with 1001 so the provider
 * reconnects and resolves the new permission.
 *
 * SHARE-02: an address with an account gets a share and a `share.member`
 * mail; one without gets an `invites` row valid 14 days and a `share.invite`
 * mail whose link carries the invitation token. The mail is sent after the
 * row is written; a refused send (SES sandbox: unverified recipient) rolls the
 * invitation back and answers 502 so nothing pending exists that the
 * recipient cannot act on. Conversion to a share happens when the address is
 * bound to an account (`PATCH /api/me { idToken }`, `upsertFromToken`) or
 * when the invitee opens the mail's link signed in as that address.
 */
import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { currentUser } from '../auth.js';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import { senderFor, shareInviteMail, shareMemberMail } from '../mail/templates.js';
import { canEdit, requirePermission } from '../permissions.js';
import {
  INVITE_VALID_DAYS,
  type DocumentPermission,
  type DocumentRecord,
  type ParticipantList,
} from '../repo/types.js';
import type { RoomManager } from '../ws/room-manager.js';
import { CLOSE_FORBIDDEN } from '../ws/route.js';
import { emailSchema, NOT_FOUND, parse, parseId } from './parse.js';

const permissionSchema = z.enum(['view', 'edit']);
const inviteBody = z.object({ email: emailSchema, permission: permissionSchema }).strict();
const permissionBody = z.object({ permission: permissionSchema }).strict();
const linkBody = z.object({ access: z.enum(['none', 'view', 'edit']) }).strict();
/** A minted secret is 32 bytes base64url; anything else is refused before any lookup. */
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u, 'Not a token');
const tokenBody = z.object({ token: tokenSchema }).strict();
const userParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const inviteParams = z.object({ id: z.string().uuid(), inviteId: z.string().uuid() });

/** The reconnect close: the provider comes back and resolves the permission afresh. */
const CLOSE_RECONNECT = 1001;

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The share sheet as the API returns it (LIB-07, SHARE-01). Emails, pending
 * invitations and the link token are for people who can act on them — the
 * owner and editors; a viewer receives names and the link mode only.
 */
export interface SharesView {
  owner: { id: string; name: string | null; email: string | null };
  participants: {
    userId: string;
    name: string | null;
    email: string | null;
    permission: 'view' | 'edit';
    invitedBy: string;
  }[];
  invites: {
    id: string;
    email: string;
    permission: 'view' | 'edit';
    invitedBy: string | null;
    expiresAt: string;
  }[];
  linkAccess: DocumentRecord['linkAccess'];
  /** Present for the owner and editors while link access is on; null otherwise. */
  linkToken: string | null;
  /** What the caller may do with this sheet. */
  permission: DocumentPermission;
}

export function sharesView(list: ParticipantList, permission: DocumentPermission): SharesView {
  const manage = canEdit(permission);
  const email = (value: string | null) => (manage ? value : null);
  return {
    owner: { id: list.owner.id, name: list.owner.name, email: email(list.owner.email) },
    participants: list.participants.map((p) => ({
      userId: p.userId,
      name: p.name,
      email: email(p.email),
      permission: p.permission,
      invitedBy: p.invitedBy,
    })),
    invites: manage
      ? list.invites.map((i) => ({
          id: i.id,
          email: i.email,
          permission: i.permission,
          invitedBy: i.invitedBy,
          expiresAt: i.expiresAt.toISOString(),
        }))
      : [],
    linkAccess: list.linkAccess,
    linkToken: manage && list.linkAccess !== 'none' ? list.linkToken : null,
    permission,
  };
}

/** The URL an invitation or a share mail opens. */
export function documentLink(webOrigin: string, documentId: string, query?: string): string {
  return `${webOrigin}/d/${documentId}${query === undefined ? '' : `?${query}`}`;
}

export function registerShareRoutes(
  api: FastifyInstance,
  ctx: { deps: Deps; rooms: Pick<RoomManager, 'closeUser'> },
): void {
  const { deps, rooms } = ctx;
  const repo = deps.db;
  const from = senderFor(deps.config.WEB_ORIGIN);

  async function participantsOrThrow(id: string, permission: DocumentPermission) {
    const list = await repo.documents.participants(id);
    if (!list) throw NOT_FOUND();
    return sharesView(list, permission);
  }

  // --- the sheet ------------------------------------------------------------

  api.get('/documents/:id/shares', async (request) => {
    const user = currentUser(request);
    const id = parseId(request.params);
    const { permission } = await requirePermission(repo, user.id, id, 'view');
    return participantsOrThrow(id, permission);
  });

  // --- invitations (SHARE-02) ---------------------------------------------------

  // A stricter bucket than the request limit (#66): each call is an outbound
  // mail from the product's domain. Same key (the verified user, `perUserKey`),
  // its own window and store. `createRateLimit` rather than `api.rateLimit()`:
  // the latter runs at most once per request, and the per-user limiter has
  // already run at `preHandler` for every `/api` route.
  const inviteBucket = api.createRateLimit({
    max: deps.config.RATE_LIMIT_INVITES_PER_HOUR,
    timeWindow: '1 hour',
  });

  api.post('/documents/:id/invites', async (request, reply) => {
    const user = currentUser(request);
    const id = parseId(request.params);
    const body = parse(inviteBody, request.body, 'request');
    const { document, permission } = await requirePermission(repo, user.id, id, 'edit');
    if (document.deletedAt !== null) throw NOT_FOUND();
    // Counted after validation and the permission check: the budget is for
    // invitations that would go out, not for typos or for a viewer's attempts.
    // `isAllowed` is the allow-list answer; the bucket's verdict is `isExceeded`.
    const budget = await inviteBucket(request);
    if (!budget.isAllowed && budget.isExceeded) {
      throw new AppError(
        429,
        'too_many_requests',
        `Too many invitations; try again in ${String(budget.ttlInSeconds)} seconds`,
      );
    }
    const actor = { actorName: user.displayName, actorEmail: user.email };

    const existing = await repo.users.findByEmail(body.email);
    if (existing) {
      if (existing.id === document.ownerId) {
        throw new AppError(409, 'conflict', 'That is the owner of this workscape');
      }
      const added = await repo.shares.add({
        documentId: id,
        userId: existing.id,
        permission: body.permission,
        invitedBy: user.id,
        actorId: user.id,
      });
      if (!added) {
        throw new AppError(409, 'conflict', 'That person already has access');
      }
      try {
        await deps.mail.send(
          shareMemberMail({
            ...actor,
            to: body.email,
            from,
            documentTitle: document.title,
            link: documentLink(deps.config.WEB_ORIGIN, id),
          }),
        );
      } catch (error) {
        // The share stands — it works without the mail — but the sender is told.
        request.log.warn(
          { err: error, documentId: id, ref: request.id },
          'share mail not sent; the share was created',
        );
      }
      return reply.status(201).send({
        kind: 'share',
        shares: await participantsOrThrow(id, permission),
      });
    }

    const invite = await repo.invites.create({
      documentId: id,
      email: body.email,
      permission: body.permission,
      token: mintToken(),
      expiresAt: new Date(Date.now() + INVITE_VALID_DAYS * 24 * 60 * 60 * 1000),
      invitedBy: user.id,
    });
    try {
      await deps.mail.send(
        shareInviteMail({
          ...actor,
          to: body.email,
          from,
          documentTitle: document.title,
          link: documentLink(deps.config.WEB_ORIGIN, id, `invite=${invite.token}`),
        }),
      );
    } catch (error) {
      // Nothing pending may exist that the recipient cannot act on: the row
      // goes, and the sender learns the mail did not go out.
      request.log.warn(
        { err: error, documentId: id, ref: request.id },
        'invitation mail not sent; the invitation was withdrawn',
      );
      await repo.invites.remove({ documentId: id, inviteId: invite.id, actorId: user.id });
      throw new AppError(
        502,
        'unavailable',
        'The invitation could not be sent to that address. Try again later.',
      );
    }
    return reply.status(201).send({
      kind: 'invite',
      shares: await participantsOrThrow(id, permission),
    });
  });

  api.delete('/documents/:id/invites/:inviteId', async (request, reply) => {
    const user = currentUser(request);
    const { id, inviteId } = parse(inviteParams, request.params, 'link');
    await requirePermission(repo, user.id, id, 'owner');
    const removed = await repo.invites.remove({ documentId: id, inviteId, actorId: user.id });
    if (!removed) throw NOT_FOUND();
    return reply.status(204).send();
  });

  /**
   * The link in the invitation mail, opened signed in. The invitation converts
   * only for the account holding its address (checked in SQL); with no address
   * bound yet the caller is told to finish sign-in — the SPA binds the address
   * right after sign-in, so this is the rare race, not the normal path.
   */
  api.post('/documents/:id/invites/accept', async (request) => {
    const user = currentUser(request);
    const id = parseId(request.params);
    const { token } = parse(tokenBody, request.body, 'request');
    const invite = await repo.invites.byToken(token);
    // Any mismatch answers the same 404: a token is a secret, not a probe.
    if (invite?.documentId !== id) throw NOT_FOUND();
    if (invite.acceptedAt !== null) {
      throw new AppError(409, 'conflict', 'This invitation has already been used');
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new AppError(410, 'not_found', 'This invitation has expired');
    }
    if (user.email === null) {
      throw new AppError(409, 'conflict', 'Finish signing in, then open the invitation again');
    }
    if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new AppError(403, 'forbidden', 'This invitation was sent to a different address');
    }
    const granted = await repo.invites.accept({ inviteId: invite.id, userId: user.id });
    if (granted === undefined) throw NOT_FOUND();
    return { permission: granted };
  });

  // --- participants (SHARE-01) -------------------------------------------------

  api.patch('/documents/:id/shares/:userId', async (request) => {
    const user = currentUser(request);
    const { id, userId } = parse(userParams, request.params, 'link');
    const { permission: body } = parse(permissionBody, request.body, 'request');
    await requirePermission(repo, user.id, id, 'owner');
    if (userId === user.id) {
      throw new AppError(409, 'conflict', 'The owner always has full access');
    }
    const changed = await repo.shares.setPermission({
      documentId: id,
      userId,
      permission: body,
      actorId: user.id,
    });
    if (!changed) throw NOT_FOUND();
    rooms.closeUser(id, userId, CLOSE_RECONNECT, 'permission changed');
    return participantsOrThrow(id, 'owner');
  });

  api.delete('/documents/:id/shares/:userId', async (request, reply) => {
    const user = currentUser(request);
    const { id, userId } = parse(userParams, request.params, 'link');
    await requirePermission(repo, user.id, id, 'owner');
    if (userId === user.id) {
      throw new AppError(409, 'conflict', 'The owner cannot be removed');
    }
    const removed = await repo.shares.remove({ documentId: id, userId, actorId: user.id });
    if (!removed) throw NOT_FOUND();
    rooms.closeUser(id, userId, CLOSE_FORBIDDEN, 'access removed');
    return reply.status(204).send();
  });

  api.post('/documents/:id/stop-sharing', async (request) => {
    const user = currentUser(request);
    const id = parseId(request.params);
    await requirePermission(repo, user.id, id, 'owner');
    const removed = await repo.shares.stop({ documentId: id, actorId: user.id });
    for (const userId of removed) rooms.closeUser(id, userId, CLOSE_FORBIDDEN, 'sharing stopped');
    return participantsOrThrow(id, 'owner');
  });

  // --- link access (SHARE-01 "anyone with the link") --------------------------

  api.patch('/documents/:id/link', async (request) => {
    const user = currentUser(request);
    const id = parseId(request.params);
    const { access } = parse(linkBody, request.body, 'request');
    await requirePermission(repo, user.id, id, 'owner');
    const updated = await repo.shares.setLinkAccess({
      documentId: id,
      access,
      actorId: user.id,
      mintToken,
    });
    if (!updated) throw NOT_FOUND();
    return participantsOrThrow(id, 'owner');
  });

  /**
   * Opened `?k=<token>` signed in: become a participant at the link's level.
   * The document's existence is never confirmed to a wrong token (404 either
   * way); a right token answers the permission now held.
   */
  api.post('/documents/:id/link/redeem', async (request) => {
    const user = currentUser(request);
    const id = parseId(request.params);
    const { token } = parse(tokenBody, request.body, 'request');
    const document = await repo.documents.get(id);
    if (document?.deletedAt !== null) throw NOT_FOUND();
    const granted = await repo.shares.redeemLink({ documentId: id, userId: user.id, token });
    if (granted === undefined) throw NOT_FOUND();
    const permission: DocumentPermission = document.ownerId === user.id ? 'owner' : granted;
    return { permission };
  });
}
