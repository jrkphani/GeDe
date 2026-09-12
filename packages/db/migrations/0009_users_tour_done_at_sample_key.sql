-- 0009_users_tour_done_at_sample_key — ONB-01, ONB-03 (first-run guided tour).
--
--   `users.tour_done_at`  — when the account completed or skipped the guided
--                           tour (ONB-03: per account, never per device).
--                           Set by `PATCH /api/me { tourDone: true }`,
--                           cleared by `{ tourDone: false }` (Replay, ONB-08).
--                           Null for every existing account, so each receives
--                           the tour on its next arrival at the library.
--   `documents_owner_sample_key` — at most one guided sample per owner
--                           (ONB-01). The service seeds the sample the first
--                           time an account is seen; two requests racing on
--                           that first sight cannot both insert one, and a
--                           repeat is `ON CONFLICT DO NOTHING`.
--
-- Additive; no rows are changed.

ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_done_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS documents_owner_sample_key ON documents (owner_id) WHERE sample;
