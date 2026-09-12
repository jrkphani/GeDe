/**
 * The local replica lives in IndexedDB (y-indexeddb), one database per
 * (user, document): the name carries the user's `sub` so two accounts on one
 * browser never read each other's replica, and sign-out deletes every
 * `gede-doc-*` database so "Nothing is left on this device" stays true
 * (AUTH-09, LOAD-06).
 *
 * `indexedDB.databases()` is not universal (Firefox gained it late), so every
 * replica opened is also recorded in a small registry; sign-out clears both.
 */
export const REPLICA_PREFIX = 'gede-doc-';
const REGISTRY_KEY = 'gede.replicas';

export function replicaStoreName(userSub: string, docId: string): string {
  return `${REPLICA_PREFIX}${userSub}-${docId}`;
}

export function isReplicaStoreName(name: string): boolean {
  return name.startsWith(REPLICA_PREFIX);
}

function readRegistry(): string[] {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Note that a replica exists so sign-out can find it without `databases()`. */
export function registerReplica(name: string): void {
  try {
    const names = readRegistry();
    if (!names.includes(name)) localStorage.setItem(REGISTRY_KEY, JSON.stringify([...names, name]));
  } catch {
    /* no storage: databases() is the only source, which is still true where it exists */
  }
}

async function listReplicaNames(): Promise<string[]> {
  const names = new Set(readRegistry());
  const factory = typeof indexedDB === 'undefined' ? null : indexedDB;
  if (factory !== null && typeof factory.databases === 'function') {
    try {
      for (const db of await factory.databases()) {
        if (typeof db.name === 'string' && isReplicaStoreName(db.name)) names.add(db.name);
      }
    } catch {
      /* enumeration failed; the registry still lists what we opened */
    }
  }
  return Array.from(names);
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve();
      return;
    }
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      resolve();
    };
    // A still-open connection (a document tab closing) finishes the delete once it closes.
    request.onblocked = () => {
      resolve();
    };
  });
}

/** Delete every local replica. Returns the names removed. */
export async function clearReplicas(): Promise<string[]> {
  const names = await listReplicaNames();
  await Promise.all(names.map(deleteDatabase));
  try {
    localStorage.removeItem(REGISTRY_KEY);
  } catch {
    /* nothing to forget */
  }
  return names;
}
