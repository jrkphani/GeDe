-- 0006_invites_inviter — SHARE-02: an invitation records who sent it and when,
-- so the share it converts into carries the right `invited_by` (the library
-- shows "shared by") and the share sheet can list pending invitations in the
-- order they were sent. The conversion on first sign-in looks invitations up
-- by address, which needs its own index (`email` is citext, so the lookup is
-- case-insensitive by type). Additive; no data changes. Rows from before this
-- migration keep `invited_by` null and convert with the document's owner as
-- the inviter.

ALTER TABLE invites ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id);
ALTER TABLE invites ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS invites_email_idx ON invites (email);
