-- 0011_users_library_sort — LIB-05 (#133).
--
--   `users.library_sort` — the Browse / Shared sort the account chose, `name`
--                          or `date`; null until chosen (the SPA sorts by
--                          name). LIB-05: "the choice persists per user" — per
--                          account, like `locale` (I18N-05) and `tour_done_at`
--                          (ONB-03), never per device. Set through
--                          `PATCH /api/me { librarySort }`. The CHECK keeps the
--                          two spellings the service accepts and nothing else.
--
-- Additive; no rows are changed.

ALTER TABLE users ADD COLUMN IF NOT EXISTS library_sort text;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_library_sort_check
    CHECK (library_sort IS NULL OR library_sort IN ('name', 'date'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
