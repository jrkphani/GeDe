import { apiFetch, type RequestOptions } from './client.js';

/**
 * Documents API contract (services/sync). Field names follow the data model in
 * ARCHITECTURE-DIGEST §1.5; anything the server omits is treated as absent,
 * never invented.
 */
export interface DocumentSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  ownerName?: string | undefined;
  /** Set when another participant shared it with the caller. */
  sharedBy?: string | undefined;
  /** Set when the caller shared it with others. */
  sharedWithOthers?: boolean | undefined;
  sizeBytes?: number | undefined;
  deletedAt?: string | null | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Tolerant reader: required fields must be strings; optional ones are kept only when well-typed. */
export function toDocumentSummary(v: unknown): DocumentSummary | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const title = str(v.title);
  const updatedAt = str(v.updatedAt);
  if (id === undefined || title === undefined || updatedAt === undefined) return null;
  return {
    id,
    title,
    updatedAt,
    createdAt: str(v.createdAt) ?? updatedAt,
    ownerId: str(v.ownerId) ?? '',
    ownerName: str(v.ownerName),
    sharedBy: str(v.sharedBy),
    sharedWithOthers: typeof v.sharedWithOthers === 'boolean' ? v.sharedWithOthers : undefined,
    sizeBytes: typeof v.sizeBytes === 'number' ? v.sizeBytes : undefined,
    deletedAt: v.deletedAt === null ? null : str(v.deletedAt),
  };
}

export async function listDocuments(options?: RequestOptions): Promise<DocumentSummary[]> {
  const raw = await apiFetch<unknown>('/documents', options);
  const items = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.documents)
      ? raw.documents
      : [];
  return items.map(toDocumentSummary).filter((d): d is DocumentSummary => d !== null);
}

export async function getDocument(id: string, options?: RequestOptions): Promise<DocumentSummary> {
  const raw = await apiFetch<unknown>(`/documents/${encodeURIComponent(id)}`, options);
  const doc = toDocumentSummary(raw);
  if (!doc) throw new Error('The document response was not in the expected shape');
  return doc;
}

/** LIB-06: the + control creates an untitled workscape. */
export async function createDocument(options?: RequestOptions): Promise<DocumentSummary> {
  const raw = await apiFetch<unknown>('/documents', {
    ...options,
    method: 'POST',
    body: { title: 'Untitled' },
  });
  const doc = toDocumentSummary(raw);
  if (!doc) throw new Error('The create response was not in the expected shape');
  return doc;
}

export async function renameDocument(
  id: string,
  title: string,
  options?: RequestOptions,
): Promise<void> {
  await apiFetch<unknown>(`/documents/${encodeURIComponent(id)}`, {
    ...options,
    method: 'PATCH',
    body: { title },
  });
}
