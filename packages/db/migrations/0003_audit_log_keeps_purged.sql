-- 0003_audit_log_keeps_purged — LIB-08: `audit_log` must outlive its subject.
--
-- 0000 declared `audit_log.document_id` with `REFERENCES documents(id) ON
-- DELETE CASCADE`, which erased a document's whole audit trail — including
-- the `document.purge` row written in the same transaction — the moment
-- Delete All removed the row. The digest (§1.5) lists `document_id` on
-- `audit_log` without a foreign key; the constraint goes, the column and its
-- index stay. No data is dropped.

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_document_id_fkey;
