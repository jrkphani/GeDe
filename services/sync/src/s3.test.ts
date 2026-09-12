import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, test } from 'vitest';

import { createS3SnapshotStore, documentPrefix, snapshotKey } from './s3.js';

/**
 * FAKE `S3Client.send` over a Set of keys: pages `ListObjectsV2` two keys at a
 * time and records every `DeleteObjects` batch. No network.
 */
function fakeS3(keys: string[]) {
  const objects = new Set(keys);
  const deleteBatches: string[][] = [];
  let failDeletes = false;
  const client = {
    send(command: unknown): Promise<unknown> {
      if (command instanceof ListObjectsV2Command) {
        // Like S3, the continuation token names the last key returned.
        const { Prefix = '', ContinuationToken } = command.input;
        const matching = [...objects]
          .filter(
            (k) =>
              k.startsWith(Prefix) && (ContinuationToken === undefined || k > ContinuationToken),
          )
          .sort();
        const page = matching.slice(0, 2);
        const truncated = matching.length > page.length;
        return Promise.resolve({
          Contents: page.map((Key) => ({ Key })),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? page.at(-1) : undefined,
        });
      }
      if (command instanceof DeleteObjectsCommand) {
        const batch = (command.input.Delete?.Objects ?? []).flatMap((o) =>
          o.Key === undefined ? [] : [o.Key],
        );
        deleteBatches.push(batch);
        if (failDeletes) {
          return Promise.resolve({
            Errors: [{ Key: batch[0], Code: 'AccessDenied', Message: 'no' }],
          });
        }
        for (const key of batch) objects.delete(key);
        return Promise.resolve({ Deleted: batch.map((Key) => ({ Key })) });
      }
      if (command instanceof PutObjectCommand || command instanceof GetObjectCommand) {
        return Promise.reject(new Error('not exercised here'));
      }
      return Promise.reject(new Error('unexpected command'));
    },
  };
  return {
    client: client as unknown as S3Client,
    objects,
    deleteBatches,
    failDeletes: () => {
      failDeletes = true;
    },
  };
}

describe('S3 snapshot store', () => {
  test('LOAD-06 keys are <prefix><docId>/<seq>.yjs, inside the folder a purge removes', () => {
    expect(snapshotKey('docs/', 'd1', 7)).toBe('docs/d1/7.yjs');
    expect(documentPrefix('docs/', 'd1')).toBe('docs/d1/');
    expect(snapshotKey('docs/', 'd1', 7).startsWith(documentPrefix('docs/', 'd1'))).toBe(true);
  });

  test('LIB-08 deletePrefix walks every page and deletes only keys under the prefix', async () => {
    const s3 = fakeS3([
      'docs/d1/1.yjs',
      'docs/d1/2.yjs',
      'docs/d1/3.yjs',
      'docs/d10/1.yjs',
      'docs/d2/1.yjs',
    ]);
    const store = createS3SnapshotStore(s3.client, 'bucket');
    const removed = await store.deletePrefix('docs/d1/');
    expect(removed).toBe(3);
    expect([...s3.objects].sort()).toEqual(['docs/d10/1.yjs', 'docs/d2/1.yjs']);
    expect(s3.deleteBatches.flat().sort()).toEqual([
      'docs/d1/1.yjs',
      'docs/d1/2.yjs',
      'docs/d1/3.yjs',
    ]);
  });

  test('LIB-08 deletePrefix on an empty folder deletes nothing and never calls DeleteObjects', async () => {
    const s3 = fakeS3(['docs/d2/1.yjs']);
    const store = createS3SnapshotStore(s3.client, 'bucket');
    expect(await store.deletePrefix('docs/d1/')).toBe(0);
    expect(s3.deleteBatches).toEqual([]);
  });

  test('LIB-08 a per-key delete error becomes a thrown error naming the prefix', async () => {
    const s3 = fakeS3(['docs/d1/1.yjs']);
    s3.failDeletes();
    const store = createS3SnapshotStore(s3.client, 'bucket');
    await expect(store.deletePrefix('docs/d1/')).rejects.toThrow(/docs\/d1\/.*AccessDenied/);
  });
});
