import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfigForTests } from '../config.js';
import {
  createDocument,
  deleteAllDocuments,
  deleteDocument,
  displayNameOf,
  getDocumentShares,
  listDocuments,
  permissionOf,
  recoverAllDocuments,
  archiveDocument,
  unarchiveDocument,
  deletionModeOf,
  recoverDocument,
  toDocumentShares,
  toDocumentSummary,
} from './documents.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function calls(fetchImpl: ReturnType<typeof vi.fn>): [string, string][] {
  return fetchImpl.mock.calls.map((c) => {
    const [url, init] = c as [string, RequestInit];
    return [init.method ?? 'GET', url];
  });
}

describe('documents api', () => {
  beforeEach(() => {
    setConfigForTests({
      region: 'r',
      userPoolId: 'p',
      userPoolClientId: 'c',
      apiUrl: 'https://api.test',
      wsUrl: 'wss://api.test/ws',
      appleSignIn: false,
      statusUrl: null,
    });
  });
  afterEach(() => {
    setConfigForTests(null);
  });

  it('LIB-02 reads the wave-1 document shape and never invents what the server omitted', () => {
    const doc = toDocumentSummary({
      id: 'a',
      title: 'Everest trek',
      kind: 'workscape',
      sizeBytes: 12,
      updatedAt: '2026-09-01T00:00:00Z',
      createdAt: '2026-08-01T00:00:00Z',
      ownerId: 'u1',
      ownerName: 'Meena',
      sharedBy: { id: 'u2', name: 'Sembian V' },
      sharedWithOthers: false,
      permission: 'edit',
      deletedAt: null,
    });
    expect(doc).toMatchObject({
      id: 'a',
      sharedBy: { id: 'u2', name: 'Sembian V' },
      permission: 'edit',
      sizeBytes: 12,
      deletedAt: null,
    });
    expect(
      toDocumentSummary({
        id: 'n',
        title: 'x',
        updatedAt: '2026-09-01T00:00:00Z',
        ownerName: null,
        sharedBy: { id: 'u9', name: null },
      }),
    ).toMatchObject({ ownerName: null, sharedBy: { id: 'u9', name: null } });
    const sparse = toDocumentSummary({ id: 'b', title: 'x', updatedAt: '2026-09-01T00:00:00Z' });
    expect(sparse?.sizeBytes).toBeUndefined();
    expect(sparse?.sharedBy).toBeUndefined();
    expect(sparse?.permission).toBeUndefined();
    expect(permissionOf(sparse!)).toBe('view');
    expect(toDocumentSummary({ id: 'c' })).toBeNull();
  });

  it('LIB-D1 LIB-D2 LIB-D10 reads archivedAt, everShared, sample and linkAccess, and derives the toolbar mode: delete, archive for a shared workscape, neither for the sample', () => {
    const base = { id: 'a', title: 'x', updatedAt: '2026-09-01T00:00:00Z' };
    const plain = toDocumentSummary(base)!;
    expect(plain).toMatchObject({
      archivedAt: null,
      everShared: false,
      sample: false,
      linkAccess: 'none',
    });
    expect(deletionModeOf(plain)).toBe('delete');
    const shared = toDocumentSummary({ ...base, everShared: true, linkAccess: 'view' })!;
    expect(shared.linkAccess).toBe('view');
    expect(deletionModeOf(shared)).toBe('archive');
    const archived = toDocumentSummary({ ...base, archivedAt: '2026-09-02T00:00:00Z' })!;
    expect(archived.archivedAt).toBe('2026-09-02T00:00:00Z');
    // The sample wins over everything else: it is never deletable or archivable.
    const sample = toDocumentSummary({ ...base, sample: true, everShared: true })!;
    expect(deletionModeOf(sample)).toBe('sample');
    // Strings and other junk never become flags.
    expect(
      toDocumentSummary({ ...base, everShared: 'yes', sample: 1, linkAccess: 'all' }),
    ).toMatchObject({
      everShared: false,
      sample: false,
      linkAccess: 'none',
    });
  });

  it('LIB-01 lists by view and unwraps `{ documents }`', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        json(200, {
          documents: [{ id: 'a', title: 'A', updatedAt: '2026-09-01T00:00:00Z' }, { bad: true }],
        }),
      ),
    );
    const opts = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: () => Promise.resolve('t'),
    };
    const out = await listDocuments('shared', opts);
    expect(out.map((d) => d.id)).toEqual(['a']);
    expect(calls(fetchImpl)).toEqual([['GET', 'https://api.test/documents?view=shared']]);
  });

  it('LIB-06 create accepts `{ document }` as well as a bare document', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        json(201, { document: { id: 'n', title: 'Untitled', updatedAt: '2026-09-01T00:00:00Z' } }),
      ),
    );
    const doc = await createDocument({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: () => Promise.resolve('t'),
    });
    expect(doc.id).toBe('n');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Untitled' });
  });

  it('LIB-08 delete, recover, recover-all and delete-all hit the contract paths; bulk calls report counts', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(200, { document: { id: 'a', title: 'A', updatedAt: 'x' } }))
      .mockResolvedValueOnce(json(200, { recovered: 3, ids: ['a', 'b', 'c'] }))
      .mockResolvedValueOnce(json(200, { deleted: 2 }))
      .mockResolvedValueOnce(json(200, { document: { id: 'a', title: 'A', updatedAt: 'x' } }))
      .mockResolvedValueOnce(json(200, { document: { id: 'a', title: 'A', updatedAt: 'x' } }));
    const opts = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: () => Promise.resolve('t'),
    };
    await deleteDocument('a/b', opts);
    await recoverDocument('a', opts);
    expect(await recoverAllDocuments(opts)).toEqual({ count: 3, ids: ['a', 'b', 'c'] });
    expect(await deleteAllDocuments(opts)).toBe(2);
    // LIB-D3 / LIB-D6: archive and unarchive are POSTs on the document.
    await archiveDocument('a', opts);
    await unarchiveDocument('a', opts);
    expect(calls(fetchImpl)).toEqual([
      ['DELETE', 'https://api.test/documents/a%2Fb'],
      ['POST', 'https://api.test/documents/a/recover'],
      ['POST', 'https://api.test/documents/recover-all'],
      ['POST', 'https://api.test/documents/delete-all'],
      ['POST', 'https://api.test/documents/a/archive'],
      ['POST', 'https://api.test/documents/a/unarchive'],
    ]);
  });

  it('LIB-07 reads the shares shape with null names kept null; an unreadable one is an error, not an empty list', async () => {
    expect(
      toDocumentShares({
        owner: { id: 'u1', name: null, email: 'm@x.test' },
        participants: [
          {
            userId: 'u2',
            name: 'Sembian V',
            email: 's@x.test',
            permission: 'edit',
            invitedBy: 'u1',
          },
          { userId: 'u3', name: null, email: null, permission: 'nonsense' },
          { nope: 1 },
        ],
        linkAccess: 'view',
      }),
    ).toEqual({
      owner: { id: 'u1', name: null, email: 'm@x.test' },
      participants: [
        {
          userId: 'u2',
          name: 'Sembian V',
          email: 's@x.test',
          permission: 'edit',
          invitedBy: 'u1',
          source: 'invite',
        },
        {
          userId: 'u3',
          name: null,
          email: null,
          permission: 'view',
          invitedBy: undefined,
          source: 'invite',
        },
      ],
      linkAccess: 'view',
    });
    expect(displayNameOf({ name: null, email: 'm@x.test' })).toBe('m@x.test');
    expect(displayNameOf({ name: null, email: null })).toBeNull();
    expect(toDocumentShares({ participants: [] })).toBeNull();
    const fetchImpl = vi.fn(() => Promise.resolve(json(200, { participants: [] })));
    await expect(
      getDocumentShares('a', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getToken: () => Promise.resolve('t'),
      }),
    ).rejects.toThrow('The shares response was not in the expected shape');
    expect(calls(fetchImpl)).toEqual([['GET', 'https://api.test/documents/a/shares']]);
  });
});
