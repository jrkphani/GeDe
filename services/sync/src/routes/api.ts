/**
 * REST under `/api` (ARCHITECTURE §1.3 "Documents & Sharing API"). Every route
 * here runs behind the auth hook; `request.user` is always set.
 *
 * Sharing, invites and link mode are not in this walking skeleton; see the
 * TODO in `permissions.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { currentUser, requireUser, type UserResolver } from '../auth.js';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import { requirePermission } from '../permissions.js';
import type { DocumentListing, DocumentPermission, DocumentRecord } from '../repo/types.js';

const documentId = z.string().uuid();
const titleSchema = z.string().trim().min(1).max(200);
const createBody = z.object({ title: titleSchema.optional() }).strict().default({});
const patchBody = z.object({ title: titleSchema }).strict();
const listQuery = z.object({ view: z.enum(['active', 'deleted']).default('active') });

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      400,
      'bad_request',
      `That ${what} is not valid`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

function parseId(params: unknown): string {
  const result = z.object({ id: documentId }).safeParse(params);
  if (!result.success) throw new AppError(400, 'bad_request', 'That link is not a workscape');
  return result.data.id;
}

export interface DocumentView {
  id: string;
  title: string;
  ownerId: string;
  permission: DocumentPermission;
  linkAccess: DocumentRecord['linkAccess'];
  updatedAt: string;
  deletedAt: string | null;
}

function view(doc: DocumentRecord, permission: DocumentPermission): DocumentView {
  return {
    id: doc.id,
    title: doc.title,
    ownerId: doc.ownerId,
    permission,
    linkAccess: doc.linkAccess,
    updatedAt: doc.updatedAt.toISOString(),
    deletedAt: doc.deletedAt?.toISOString() ?? null,
  };
}

function viewListing(listing: DocumentListing): DocumentView {
  return view(listing, listing.permission);
}

export function registerApi(app: FastifyInstance, deps: Deps, resolver: UserResolver): void {
  const repo = deps.db;

  app.register(
    (api, _opts, done) => {
      api.addHook('onRequest', requireUser(resolver));

      api.get('/me', (request) => {
        const user = currentUser(request);
        return { id: user.id, sub: user.sub, email: user.email, displayName: user.displayName };
      });

      api.get('/documents', async (request) => {
        const user = currentUser(request);
        const { view: which } = parse(listQuery, request.query, 'query');
        const listings = await repo.documents.listForUser(user.id, which);
        return { documents: listings.map(viewListing) };
      });

      api.post('/documents', async (request, reply) => {
        const user = currentUser(request);
        const body = parse(createBody, request.body ?? {}, 'request');
        const doc = await repo.documents.create({
          ownerId: user.id,
          title: body.title ?? 'Untitled',
        });
        await repo.audit.record({
          documentId: doc.id,
          userId: user.id,
          action: 'document.create',
          target: null,
        });
        return reply.status(201).send({ document: view(doc, 'owner') });
      });

      api.get('/documents/:id', async (request) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        const { document, permission } = await requirePermission(repo, user.id, id, 'view');
        return { document: view(document, permission) };
      });

      api.patch('/documents/:id', async (request) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        const body = parse(patchBody, request.body, 'request');
        const { permission, document } = await requirePermission(repo, user.id, id, 'edit');
        if (document.deletedAt !== null)
          throw new AppError(404, 'not_found', 'Nothing at this address');
        const renamed = await repo.documents.rename(id, body.title);
        if (!renamed) throw new AppError(404, 'not_found', 'Nothing at this address');
        await repo.audit.record({
          documentId: id,
          userId: user.id,
          action: 'document.rename',
          target: body.title,
        });
        return { document: view(renamed, permission) };
      });

      api.delete('/documents/:id', async (request, reply) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        await requirePermission(repo, user.id, id, 'owner');
        const deleted = await repo.documents.softDelete(id);
        if (!deleted) throw new AppError(404, 'not_found', 'Nothing at this address');
        await repo.audit.record({
          documentId: id,
          userId: user.id,
          action: 'document.delete',
          target: null,
        });
        return reply.status(204).send();
      });

      done();
    },
    { prefix: '/api' },
  );
}
