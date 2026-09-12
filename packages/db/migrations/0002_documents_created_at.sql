-- 0002_documents_created_at — LIB-02: the library row shows when a workscape
-- was created, and Browse sorts by date. The column is defaulted by the
-- database, never set by the application (packages/db/CLAUDE.md).
--
-- Backfill for rows that predate this column: the API has recorded a
-- `document.create` audit row for every document it created, so that
-- timestamp is the real creation time. A document without one (none are
-- expected) keeps `updated_at`, which is the latest moment it could have
-- been created.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE documents d
   SET created_at = a.at
  FROM audit_log a
 WHERE a.document_id = d.id
   AND a.action = 'document.create'
   AND d.created_at > a.at;

UPDATE documents
   SET created_at = updated_at
 WHERE created_at > updated_at;
