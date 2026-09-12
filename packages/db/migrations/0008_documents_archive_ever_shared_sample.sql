-- 0008_documents_archive_ever_shared_sample — LIB-D1..D11 (delete vs archive).
--
-- Archive and trash are document states, not library-local flags (LIB-D11):
--   `archived_at`  — set by Archive, cleared by Unarchive; never expires
--                    (LIB-D6). A document is archived or deleted, never both:
--                    Delete clears `archived_at` as it sets `deleted_at`.
--   `ever_shared`  — true while the document has a participant or, once one
--                    existed, while its share link is still on (LIB-D2, LIB-D4,
--                    ADR in docs/DECISIONS.md). Set by the service when a share
--                    is inserted (an accepted invitation, a link redeemed, a
--                    person with an account named in the sheet) — never when
--                    an invitation is merely sent — and cleared when the last
--                    share goes and link access is `none`. Delete is refused
--                    while it is true or the link is on (409 `shared`).
--   `sample`       — the guided sample workscape (ONB-01, a later wave seeds
--                    it); exempt from Delete and Archive (LIB-D10). Nothing
--                    sets it yet; the guard ships now so it cannot be missed.
--
-- Backfill: a document that already has a share, or whose link is on, has
-- been shared. Additive otherwise; no rows are removed.
--
-- The partial index serves the Archived view (owner's archived rows) without
-- widening `documents_owner_id_idx` for every other query.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ever_shared boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sample boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT documents_archived_or_deleted_check
    CHECK (archived_at IS NULL OR deleted_at IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS documents_archived_owner_idx ON documents (owner_id) WHERE archived_at IS NOT NULL;

UPDATE documents d
   SET ever_shared = true
 WHERE d.ever_shared = false
   AND (
     d.link_access <> 'none'
     OR EXISTS (SELECT 1 FROM shares s WHERE s.document_id = d.id)
   );
