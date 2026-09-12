-- 0005_migrations_checksum — #42: the ledger records the SHA-256 of each
-- applied file so an edit to a shipped migration is detected at the next
-- boot instead of silently diverging from what production ran. The runner
-- fills the column for rows applied before this migration on its next run
-- (the files it has are the files that ran; from then on they are pinned).

ALTER TABLE __migrations ADD COLUMN IF NOT EXISTS checksum text;
