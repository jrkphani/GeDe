-- 0004_fk_indexes — #42: every foreign key that a cascade or the projection
-- walks gets an index. The cascade from documents (Delete All, the nightly
-- purge) and the projection's per-document replace otherwise scan the child
-- tables in full, under the parent row's lock. Additive; no data changes.
-- cells (row_id, column_id) already serves row_id; column_id needs its own.

CREATE INDEX IF NOT EXISTS invites_document_id_idx ON invites (document_id);
CREATE INDEX IF NOT EXISTS sheets_document_id_idx ON sheets (document_id);
CREATE INDEX IF NOT EXISTS tables_sheet_id_idx ON tables (sheet_id);
CREATE INDEX IF NOT EXISTS columns_table_id_idx ON columns (table_id);
CREATE INDEX IF NOT EXISTS rows_table_id_idx ON rows (table_id);
CREATE INDEX IF NOT EXISTS cells_column_id_idx ON cells (column_id);
CREATE INDEX IF NOT EXISTS graphs_sheet_id_idx ON graphs (sheet_id);
CREATE INDEX IF NOT EXISTS graphs_table_id_idx ON graphs (table_id);
