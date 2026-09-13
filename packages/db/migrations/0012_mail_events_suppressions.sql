-- 0012_mail_events_suppressions — SHARE-02, SES bounce and complaint handling (ADR-046).
--
-- What the owner told AWS on the production-access case: "a hard bounce or
-- complaint withdraws the invitation and blocks further mail to that address".
-- The sync service reads SES events (configuration set → SNS → SQS) and keeps
-- two tables:
--
--   `mail_events`       — one row per (SES message id, recipient) event the
--                         service has processed: `kind` is `bounce_permanent`,
--                         `bounce_transient`, `complaint` or `reject`. The
--                         primary key is what makes a redelivered SQS message a
--                         no-op, and transient bounces are counted here before
--                         they suppress (three within a window). `source` is the
--                         event as SES published it, minus nothing — it carries
--                         no message content, only headers and the verdict.
--   `mail_suppressions` — the addresses GeDe will not mail again: `reason` is
--                         `bounce` or `complaint`; `first_seen_at` when the
--                         first suppressing event arrived, `last_event_at` the
--                         latest; `source` the event that suppressed it. The
--                         invite and resend routes answer 409 `address_suppressed`
--                         while a row exists. Un-suppressing is a `DELETE` here
--                         plus `aws sesv2 delete-suppressed-destination` for the
--                         account-level list (runbook §5).
--
-- Emails are citext, like `users.email` and `invites.email`: lookups are
-- case-insensitive by type. Additive; no rows are changed.

CREATE TABLE IF NOT EXISTS mail_events (
  message_id  text        NOT NULL,
  email       citext      NOT NULL,
  kind        text        NOT NULL,
  at          timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  source      jsonb       NOT NULL,
  PRIMARY KEY (message_id, email),
  CONSTRAINT mail_events_kind_check
    CHECK (kind IN ('bounce_permanent', 'bounce_transient', 'complaint', 'reject'))
);

-- The transient-bounce count and the address's history are read by address.
CREATE INDEX IF NOT EXISTS mail_events_email_at_idx ON mail_events (email, at);

CREATE TABLE IF NOT EXISTS mail_suppressions (
  email         citext      PRIMARY KEY,
  reason        text        NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz NOT NULL DEFAULT now(),
  source        jsonb       NOT NULL,
  CONSTRAINT mail_suppressions_reason_check CHECK (reason IN ('bounce', 'complaint'))
);
