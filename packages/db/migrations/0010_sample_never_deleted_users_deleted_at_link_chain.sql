-- 0010_sample_never_deleted_users_deleted_at_link_chain — final red team (#101, #111, #114).
--
--   `documents_sample_not_deleted_check` — the guided sample (ONB-01, LIB-D10)
--                    can never be in the trash. The service already answers
--                    409 `sample` to Delete; the schema now agrees, so no
--                    job, no unguarded repository method and no hand-run
--                    UPDATE can put a sample where the purge would find it
--                    (#114). Any sample that is in the trash today (none is
--                    expected) is recovered first, never purged.
--   `users.deleted_at` — set by account erasure (#111, ADR-038): the row is
--                    kept as a tombstone with every personal column nulled,
--                    so `audit_log.user_id`, `shares.invited_by` and
--                    `doc_updates.author_id` still resolve and the Cognito
--                    `sub` cannot come back as a fresh account while its last
--                    access token is alive. Null for every account today.
--   `shares.source` backfill — a share created by someone who came in through
--                    the share link is a link share too (#101): switching the
--                    link off or re-minting it revokes the whole chain, not
--                    only the first hop. Walks `invited_by` from every `link`
--                    share; idempotent.
--
-- No rows are removed.

UPDATE documents
   SET deleted_at = NULL, updated_at = now()
 WHERE sample AND deleted_at IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT documents_sample_not_deleted_check
    CHECK (NOT sample OR deleted_at IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

WITH RECURSIVE chain AS (
  SELECT s.document_id, s.user_id
    FROM shares s
   WHERE s.source = 'link'
  UNION
  SELECT s.document_id, s.user_id
    FROM shares s
    JOIN chain c ON c.document_id = s.document_id AND s.invited_by = c.user_id
)
UPDATE shares s
   SET source = 'link'
  FROM chain c
 WHERE s.document_id = c.document_id
   AND s.user_id = c.user_id
   AND s.source = 'invite';
