import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfigForTests } from '../config.js';
import { TEST_CONFIG } from '../test/helpers.js';
import {
  canEdit,
  createDocument,
  getDocument,
  listDocuments,
  toDocumentSummary,
} from './documents.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The exact shape `services/sync/src/routes/api.ts` `view()` produces. */
const serverView = {
  id: '6f1b2c3d-0000-4000-8000-000000000001',
  title: 'Everest trek',
  ownerId: 'u1',
  permission: 'view',
  linkAccess: 'none',
  updatedAt: '2026-09-12T00:00:00.000Z',
  deletedAt: null,
};

describe('documents api', () => {
  beforeEach(() => {
    setConfigForTests(TEST_CONFIG);
  });
  afterEach(() => {
    setConfigForTests(null);
  });

  it('SHARE-03 GET /documents/:id unwraps the { document } envelope and reads the permission', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(json(200, { document: serverView })));
    const doc = await getDocument(serverView.id, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: () => Promise.resolve('tok'),
    });
    expect(doc.permission).toBe('view');
    expect(doc.title).toBe('Everest trek');
    expect(doc.deletedAt).toBeNull();
    expect(canEdit(doc)).toBe(false);
    expect(canEdit({ permission: 'edit' })).toBe(true);
    expect(canEdit({ permission: 'owner' })).toBe(true);
    expect(canEdit({ permission: undefined })).toBe(false);
  });

  it('LIB-06 POST /documents unwraps the created document', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json(201, { document: { ...serverView, permission: 'owner' } })),
    );
    const doc = await createDocument({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: () => Promise.resolve('tok'),
    });
    expect(doc.permission).toBe('owner');
  });

  it('LIB-01 GET /documents reads the { documents } list', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(json(200, { documents: [serverView] })));
    const docs = await listDocuments({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: () => Promise.resolve('tok'),
    });
    expect(docs.map((d) => d.id)).toEqual([serverView.id]);
  });

  it('SHARE-03 an unknown permission string is dropped rather than invented', () => {
    expect(toDocumentSummary({ ...serverView, permission: 'admin' })?.permission).toBeUndefined();
  });
});
