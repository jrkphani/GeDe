/**
 * Snapshot store over S3 `docs`. Keys are `${DOCS_PREFIX}${docId}/${seq}.yjs`;
 * the bucket is versioned so nothing is ever overwritten in place.
 */
import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import type { SnapshotStore } from './deps.js';

export function snapshotKey(prefix: string, documentId: string, seq: number): string {
  return `${prefix}${documentId}/${String(seq)}.yjs`;
}

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
  };
}
