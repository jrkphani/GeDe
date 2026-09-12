/**
 * Snapshot store over S3 `docs`. Keys are `${DOCS_PREFIX}${docId}/${seq}.yjs`;
 * the bucket is versioned so nothing is ever overwritten in place. A purge
 * (LIB-08 Delete All) deletes every key under the document's folder; on a
 * versioned bucket that writes delete markers and the bucket's lifecycle rule
 * expires the old versions.
 */
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import type { SnapshotStore } from './deps.js';

export function snapshotKey(prefix: string, documentId: string, seq: number): string {
  return `${prefix}${documentId}/${String(seq)}.yjs`;
}

/** The folder a document's snapshots live in; what a purge removes. */
export function documentPrefix(prefix: string, documentId: string): string {
  return `${prefix}${documentId}/`;
}

/** `DeleteObjects` accepts at most 1000 keys per call. */
const DELETE_BATCH = 1000;

export function createS3SnapshotStore(client: S3Client, bucket: string): SnapshotStore {
  return {
    async put(key, bytes) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: 'application/octet-stream',
        }),
      );
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!out.Body) return undefined;
        return await out.Body.transformToByteArray();
      } catch (error) {
        if (error instanceof NoSuchKey) return undefined;
        throw error;
      }
    },
    async deletePrefix(prefix) {
      // List everything first, then delete: a document has at most a few
      // hundred snapshots, and this keeps the walk independent of the deletes.
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key !== undefined) keys.push(object.Key);
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken !== undefined);

      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const batch = keys.slice(i, i + DELETE_BATCH);
        const out = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const failed = out.Errors ?? [];
        if (failed.length > 0) {
          const first = failed[0];
          throw new Error(
            `${String(failed.length)} of ${String(batch.length)} deletes failed under ${prefix}: ${first?.Code ?? 'unknown'} ${first?.Message ?? ''}`.trim(),
          );
        }
      }
      return keys.length;
    },
  };
}
