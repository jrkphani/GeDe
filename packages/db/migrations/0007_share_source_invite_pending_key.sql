-- 0007_share_source_invite_pending_key — review of #76.
--
-- `shares.source` says how a share came to be: `invite` (the owner or an
-- editor named the person, or an invitation converted) or `link` ("anyone
-- with the link" redeemed). A link-derived share is shown as such in the
-- sheet and is revoked when the link is switched off or its token re-minted;
-- an invited share is not. Existing rows are invites (no link had shipped).
--
-- `invites_pending_key`: at most one pending (unaccepted) invitation per
-- address per document, so a repeated POST — a retried request, a double
-- click — returns the invitation that exists instead of inserting a second
-- row and sending a second mail. Expired unaccepted rows count as pending
-- for the index; the service deletes them before inserting afresh.
-- Additive; no data changes.

DO $$ BEGIN
  CREATE TYPE share_source AS ENUM ('invite', 'link');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE shares ADD COLUMN IF NOT EXISTS source share_source NOT NULL DEFAULT 'invite';

CREATE UNIQUE INDEX IF NOT EXISTS invites_pending_key ON invites (document_id, email) WHERE accepted_at IS NULL;
