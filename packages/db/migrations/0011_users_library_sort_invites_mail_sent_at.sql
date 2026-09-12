-- 0011_users_library_sort_invites_mail_sent_at — LIB-05 (#133), SHARE-02 (#121).
--
--   `users.library_sort` — the Browse / Shared sort the account chose, `name`
--                          or `date`; null until chosen (the SPA sorts by
--                          name). LIB-05: "the choice persists per user" — per
--                          account, like `locale` (I18N-05) and `tour_done_at`
--                          (ONB-03), never per device. Set through
--                          `PATCH /api/me { librarySort }`. The CHECK keeps the
--                          two spellings the service accepts and nothing else.
--   `invites.mail_sent_at` — when the invitation's mail was last accepted by SES,
--                          null while it never was (SES in the sandbox refused
--                          it; #121). The row is the grant and stands either
--                          way; the share sheet reads null as "email not sent"
--                          and offers Resend after a reload as well. Existing
--                          rows read null: their mail went out under the old
--                          contract (a refused send withdrew the row), but the
--                          service never recorded it, so Resend is offered for
--                          them too — harmless, one mail.
--
-- Additive; no rows are changed.

ALTER TABLE users ADD COLUMN IF NOT EXISTS library_sort text;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_library_sort_check
    CHECK (library_sort IS NULL OR library_sort IN ('name', 'date'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE invites ADD COLUMN IF NOT EXISTS mail_sent_at timestamptz;
