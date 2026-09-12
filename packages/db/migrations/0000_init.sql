-- 0000_init — GeDe relational schema (ARCHITECTURE-DIGEST §1.5).
-- Hand-authored. Every statement is safe to re-run so a half-applied boot can
-- recover; the runner still records each file in __migrations and applies it
-- inside one transaction under an advisory lock.

-- Ledger -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS __migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Extensions ---------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS citext;

-- Enums --------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE link_access AS ENUM ('none', 'view', 'edit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE permission AS ENUM ('view', 'edit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE column_format AS ENUM ('auto', 'text', 'number', 'currency', 'date');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE graph_kind AS ENUM ('ring', 'coverage');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5.1 Authoritative --------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub  text NOT NULL UNIQUE,
  email        citext UNIQUE,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id),
  title        text NOT NULL DEFAULT 'Untitled',
  link_access  link_access NOT NULL DEFAULT 'none',
  link_token   text UNIQUE,
  snapshot_key text,
  snapshot_seq bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE INDEX IF NOT EXISTS documents_owner_id_idx ON documents (owner_id);

CREATE TABLE IF NOT EXISTS shares (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  permission NOT NULL,
  invited_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS shares_user_id_idx ON shares (user_id);

CREATE TABLE IF NOT EXISTS invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  permission  permission NOT NULL,
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz
);

CREATE TABLE IF NOT EXISTS doc_updates (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  update      bytea NOT NULL,
  author_id   uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, seq)
);

CREATE TABLE IF NOT EXISTS snapshots (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  s3_key      text NOT NULL,
  size_bytes  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, seq)
);

-- 5.2 Projection (rebuildable) ---------------------------------------------

CREATE TABLE IF NOT EXISTS sheets (
  id             text PRIMARY KEY,
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal        integer NOT NULL,
  label          text NOT NULL,
  parent_context text
);

CREATE TABLE IF NOT EXISTS tables (
  id       text PRIMARY KEY,
  sheet_id text NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  title    text NOT NULL,
  grid_col integer NOT NULL,
  grid_row integer NOT NULL,
  outline  text,
  options  jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS columns (
  id          text PRIMARY KEY,
  table_id    text NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  ordinal     integer NOT NULL,
  label       text NOT NULL,
  width_units integer NOT NULL,
  format      column_format NOT NULL DEFAULT 'auto',
  format_opts jsonb NOT NULL DEFAULT '{}'::jsonb,
  derived     jsonb,
  hidden      boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS rows (
  id        text PRIMARY KEY,
  table_id  text NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  ordinal   integer NOT NULL,
  depth     smallint NOT NULL DEFAULT 0,
  collapsed boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS cells (
  row_id     text NOT NULL REFERENCES rows(id) ON DELETE CASCADE,
  column_id  text NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  text_plain text NOT NULL DEFAULT '',
  rich       jsonb,
  formula    text,
  ref_target text,
  style      jsonb,
  PRIMARY KEY (row_id, column_id)
);

CREATE INDEX IF NOT EXISTS cells_text_plain_tsv_idx
  ON cells USING GIN (to_tsvector('simple', text_plain));

CREATE TABLE IF NOT EXISTS graphs (
  id                text PRIMARY KEY,
  sheet_id          text NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  pair_id           text NOT NULL,
  kind              graph_kind NOT NULL,
  table_id          text NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  dimension_columns text[] NOT NULL DEFAULT '{}',
  grid_col          integer NOT NULL,
  grid_row          integer NOT NULL,
  width_units       integer NOT NULL,
  height_units      integer NOT NULL,
  slice             jsonb
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id),
  action      text NOT NULL,
  target      text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_document_id_at_idx ON audit_log (document_id, at);
