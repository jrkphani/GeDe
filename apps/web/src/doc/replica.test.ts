import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { clearReplicas, registerReplica, replicaStoreName } from './replica.js';

async function databaseNames(): Promise<string[]> {
  const list = await indexedDB.databases();
  return list.map((d) => d.name).filter((n): n is string => typeof n === 'string');
}

describe('replica store', () => {
  it('AUTH-09 the store name carries the user sub so two accounts never share a replica', () => {
    const a = replicaStoreName('sub-a', 'doc-1');
    const b = replicaStoreName('sub-b', 'doc-1');
    expect(a).not.toBe(b);
    expect(a).toBe('gede-doc-sub-a-doc-1');
  });

  it('AUTH-09 sign-out deletes every gede-doc-* database, found by enumeration or by the registry', async () => {
    const one = replicaStoreName('sub-a', 'doc-1');
    const two = replicaStoreName('sub-b', 'doc-2');
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const pa = new IndexeddbPersistence(one, docA);
    const pb = new IndexeddbPersistence(two, docB);
    registerReplica(one); // the registry path
    await pa.whenSynced;
    await pb.whenSynced;
    docA.getMap('meta').set('title', 'private');
    await pa.destroy();
    await pb.destroy();
    // An unrelated database survives.
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('other-app', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('x');
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
    });
    expect(await databaseNames()).toEqual(expect.arrayContaining([one, two, 'other-app']));

    const removed = await clearReplicas();
    expect(removed.sort()).toEqual([one, two].sort());
    const after = await databaseNames();
    expect(after).not.toContain(one);
    expect(after).not.toContain(two);
    expect(after).toContain('other-app');
    expect(localStorage.getItem('gede.replicas')).toBeNull();
  });
});
