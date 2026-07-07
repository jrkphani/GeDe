-- Issue 034 (ADR-0009/0010) — workspaces + Postgres Row-Level Security
-- multi-tenancy. Drizzle-generated DDL (enum/tables/columns) is followed by
-- hand-authored data backfill + RLS policies, exactly as the issue's
-- implementation notes call for ("author RLS policies directly in Postgres").
--
-- ── Why this migration is "permissive on PGlite, enforcing on Postgres" with
-- ZERO dialect fork (SPEC §3, issue 034 scope) ──
--
-- Postgres exempts a table's OWNER from its own RLS policies unless the table
-- is explicitly marked FORCE ROW LEVEL SECURITY (which this migration never
-- does). Every table here is created — and therefore owned — by whichever
-- role applies this migration:
--   - In-browser PGlite: the app's own single connection (src/db/client.ts)
--     runs every query AS the table owner, so RLS is a harmless no-op there —
--     "one personal workspace, policies permissive" (design brief) falls out
--     of Postgres' own semantics, not a special case in this file.
--   - Server Postgres (deploy/cdk/lib/data-stack.ts's RDS): migrations run as
--     `gede_admin` (the generated master credential), so it too owns these
--     tables and would ALSO bypass RLS if it ran app queries directly. The
--     enforcement point is that the sync (032/ElectricSQL) and write-path
--     (043) connections must use the much less privileged `app_user` role
--     this migration provisions below (GRANTed table access, NOT ownership)
--     — RLS applies in full to any non-owner role regardless of privileges
--     granted. Wiring the CDK-provisioned secret for that role's credentials
--     is a deploy-layer follow-up (out of this issue's lane); this migration
--     ships the role + grants so that wiring has something to point at.
--
-- This lets the exact same policies below be verified end-to-end against
-- PGlite in tests: `SET ROLE app_user; SELECT set_config('app.current_user_sub', ...)`
-- exercises real Postgres RLS enforcement without a live server (see
-- src/db/workspaceRls.test.ts) — PGlite is genuine Postgres under WASM, so
-- CREATE ROLE / GRANT / SET ROLE / RLS all behave identically to RDS.
--
-- ── Which tables carry a literal workspace_id column ──
--
-- `projects` (the tenancy root) and the five tables with a direct
-- `project_id` FK (tier1_purpose, tier1_props, tier2_tables, dimensions,
-- contexts) get a denormalized `workspace_id` column — cheap, indexed-by-FK,
-- and consistent with this schema's existing denormalize-for-RLS/lookup
-- precedent (bindings.tuple_hash). `tier2_entries`, `parameters`, and
-- `bindings` do NOT get their own workspace_id column — scoping columns onto
-- every nested table would ripple workspace_id-threading into every mutation
-- that creates one of those rows for no enforcement benefit. Instead their
-- policies join up their existing FK chain (tier2_entries -> tier2_tables,
-- parameters -> dimensions, bindings -> contexts) to the nearest
-- workspace_id-bearing ancestor. Isolation is identical either way — RLS
-- enforces via a subquery instead of a literal column — this is a scoped
-- implementation decision, flagged for review (see the issue's own report).
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_sub" text NOT NULL,
	"role" "workspace_role" DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
-- workspace_id added NULLABLE first — the backfill below fills existing rows
-- (v1 single-user data, test-first plan #4) before the NOT NULL is applied
-- further down, so this migration is safe against a real, already-populated
-- database (not just an empty one).
ALTER TABLE "contexts" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "dimensions" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "tier1_props" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "tier1_purpose" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "tier2_tables" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user_idx" ON "workspace_members" USING btree ("workspace_id","user_sub");--> statement-breakpoint
ALTER TABLE "contexts" ADD CONSTRAINT "contexts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier1_props" ADD CONSTRAINT "tier1_props_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier1_purpose" ADD CONSTRAINT "tier1_purpose_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier2_tables" ADD CONSTRAINT "tier2_tables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── Backfill: v1 single-user data gets a default/personal workspace (test-
-- first plan #4, "single-user preserved") ──────────────────────────────────
DO $$
DECLARE
  default_ws_id text;
BEGIN
  IF EXISTS (SELECT 1 FROM "projects" WHERE "workspace_id" IS NULL) THEN
    default_ws_id := gen_random_uuid()::text;
    INSERT INTO "workspaces" ("id", "name") VALUES (default_ws_id, 'Personal Workspace');

    UPDATE "projects" SET "workspace_id" = default_ws_id WHERE "workspace_id" IS NULL;
    UPDATE "tier1_purpose" SET "workspace_id" = default_ws_id WHERE "workspace_id" IS NULL;
    UPDATE "tier1_props" SET "workspace_id" = default_ws_id WHERE "workspace_id" IS NULL;
    UPDATE "tier2_tables" SET "workspace_id" = default_ws_id WHERE "workspace_id" IS NULL;
    UPDATE "dimensions" SET "workspace_id" = default_ws_id WHERE "workspace_id" IS NULL;
    UPDATE "contexts" SET "workspace_id" = default_ws_id WHERE "workspace_id" IS NULL;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "projects" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tier1_purpose" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tier1_props" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tier2_tables" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dimensions" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contexts" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint

-- ── Least-privilege connecting role (see header) ────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "workspaces", "workspace_members", "projects", "tier1_purpose", "tier1_props",
  "tier2_tables", "tier2_entries", "dimensions", "parameters", "contexts", "bindings"
TO app_user;
--> statement-breakpoint

-- ── The identity seam RLS reads (ADR-0009) ──────────────────────────────────
-- The connecting role (app_user on the server; irrelevant on PGlite, owner
-- bypasses regardless) sets this once per session/request via
-- `SELECT set_config('app.current_user_sub', '<cognito sub>', false)` —
-- src/db/tenantContext.ts is the client-side half of this seam. `true` as
-- the second arg to current_setting means "don't error if unset", so an
-- anonymous/local session simply resolves to NULL (matches nothing, not an
-- error) rather than crashing every query.
CREATE OR REPLACE FUNCTION app_current_user_sub() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.current_user_sub', true), '')
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ── Membership lookup helpers — SECURITY DEFINER to break RLS self-reference ─
-- Every policy below needs "which workspaces can the caller reach", which is
-- itself a query against workspace_members. Inlining that subquery directly
-- in workspace_members' OWN policies causes Postgres to recursively
-- re-evaluate the same policy while evaluating it ("infinite recursion
-- detected in policy for relation workspace_members" — caught by this
-- migration's own PGlite smoke test, not a hypothetical). The fix is the
-- standard Postgres pattern: wrap the lookup in a SECURITY DEFINER function.
-- Such a function runs with the privileges of its OWNER (whoever applies this
-- migration — the same role that owns every table here), so its internal
-- query bypasses RLS via the owner-exemption (see the file header) instead of
-- re-entering the calling policy. `SET search_path` pins name resolution so a
-- SECURITY DEFINER function can't be tricked by a caller-controlled path.
CREATE OR REPLACE FUNCTION app_member_workspace_ids() RETURNS SETOF text AS $$
  SELECT workspace_id FROM workspace_members
  WHERE user_sub = app_current_user_sub() AND deleted_at IS NULL
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION app_writable_workspace_ids() RETURNS SETOF text AS $$
  SELECT workspace_id FROM workspace_members
  WHERE user_sub = app_current_user_sub() AND deleted_at IS NULL AND role IN ('owner', 'editor')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION app_owned_workspace_ids() RETURNS SETOF text AS $$
  SELECT workspace_id FROM workspace_members
  WHERE user_sub = app_current_user_sub() AND deleted_at IS NULL AND role = 'owner'
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint

ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tier1_purpose" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tier1_props" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tier2_tables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tier2_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dimensions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "parameters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contexts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── workspaces / workspace_members policies ────────────────────────────────
-- Workspace creation itself leaks nothing (an empty shell with a name), so
-- any authenticated caller may INSERT one; who then has access is entirely
-- governed by workspace_members. Self-bootstrap only for membership INSERT
-- (a caller can only ever seat themselves) — inviting OTHER subs is issue
-- 035's granting UX, deliberately out of this issue's scope; extend this
-- policy there rather than widening it here speculatively.
CREATE POLICY workspaces_select ON "workspaces" FOR SELECT
  USING ("id" IN (SELECT app_member_workspace_ids()));
CREATE POLICY workspaces_insert ON "workspaces" FOR INSERT
  WITH CHECK (app_current_user_sub() IS NOT NULL);
CREATE POLICY workspaces_update ON "workspaces" FOR UPDATE
  USING ("id" IN (SELECT app_owned_workspace_ids()))
  WITH CHECK ("id" IN (SELECT app_owned_workspace_ids()));
CREATE POLICY workspaces_delete ON "workspaces" FOR DELETE
  USING ("id" IN (SELECT app_owned_workspace_ids()));
--> statement-breakpoint

CREATE POLICY workspace_members_select ON "workspace_members" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));
CREATE POLICY workspace_members_insert ON "workspace_members" FOR INSERT
  WITH CHECK (
    "user_sub" = app_current_user_sub()
    OR "workspace_id" IN (SELECT app_owned_workspace_ids())
  );
CREATE POLICY workspace_members_update ON "workspace_members" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_owned_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_owned_workspace_ids()));
CREATE POLICY workspace_members_delete ON "workspace_members" FOR DELETE
  USING (
    "user_sub" = app_current_user_sub()
    OR "workspace_id" IN (SELECT app_owned_workspace_ids())
  );
--> statement-breakpoint

-- ── Direct workspace_id-bearing tenant tables ───────────────────────────────
-- Read: any live membership. Write (insert/update/delete): editor or owner —
-- "least privilege by role" (design brief); a viewer's writes are rejected by
-- RLS itself, not merely hidden by the UI.
CREATE POLICY projects_select ON "projects" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));
CREATE POLICY projects_insert ON "projects" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY projects_update ON "projects" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY projects_delete ON "projects" FOR DELETE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()));
--> statement-breakpoint

CREATE POLICY tier1_purpose_select ON "tier1_purpose" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));
CREATE POLICY tier1_purpose_insert ON "tier1_purpose" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY tier1_purpose_update ON "tier1_purpose" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY tier1_purpose_delete ON "tier1_purpose" FOR DELETE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()));
--> statement-breakpoint

CREATE POLICY tier1_props_select ON "tier1_props" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));
CREATE POLICY tier1_props_insert ON "tier1_props" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY tier1_props_update ON "tier1_props" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY tier1_props_delete ON "tier1_props" FOR DELETE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()));
--> statement-breakpoint

CREATE POLICY tier2_tables_select ON "tier2_tables" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));
CREATE POLICY tier2_tables_insert ON "tier2_tables" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY tier2_tables_update ON "tier2_tables" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY tier2_tables_delete ON "tier2_tables" FOR DELETE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()));
--> statement-breakpoint

CREATE POLICY dimensions_select ON "dimensions" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));
CREATE POLICY dimensions_insert ON "dimensions" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY dimensions_update ON "dimensions" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY dimensions_delete ON "dimensions" FOR DELETE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()));
--> statement-breakpoint

CREATE POLICY contexts_select ON "contexts" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));
CREATE POLICY contexts_insert ON "contexts" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY contexts_update ON "contexts" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY contexts_delete ON "contexts" FOR DELETE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()));
--> statement-breakpoint

-- ── Nested tables (no own workspace_id — scoped via their parent's FK chain) ─
CREATE POLICY tier2_entries_select ON "tier2_entries" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "tier2_tables" t
                 WHERE t."id" = "tier2_entries"."table_id"
                   AND t."workspace_id" IN (SELECT app_member_workspace_ids())));
CREATE POLICY tier2_entries_insert ON "tier2_entries" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "tier2_tables" t
                       WHERE t."id" = "tier2_entries"."table_id"
                         AND t."workspace_id" IN (SELECT app_writable_workspace_ids())));
CREATE POLICY tier2_entries_update ON "tier2_entries" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "tier2_tables" t
                 WHERE t."id" = "tier2_entries"."table_id"
                   AND t."workspace_id" IN (SELECT app_writable_workspace_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM "tier2_tables" t
                       WHERE t."id" = "tier2_entries"."table_id"
                         AND t."workspace_id" IN (SELECT app_writable_workspace_ids())));
CREATE POLICY tier2_entries_delete ON "tier2_entries" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "tier2_tables" t
                 WHERE t."id" = "tier2_entries"."table_id"
                   AND t."workspace_id" IN (SELECT app_writable_workspace_ids())));
--> statement-breakpoint

CREATE POLICY parameters_select ON "parameters" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "dimensions" d
                 WHERE d."id" = "parameters"."dimension_id"
                   AND d."workspace_id" IN (SELECT app_member_workspace_ids())));
CREATE POLICY parameters_insert ON "parameters" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "dimensions" d
                       WHERE d."id" = "parameters"."dimension_id"
                         AND d."workspace_id" IN (SELECT app_writable_workspace_ids())));
CREATE POLICY parameters_update ON "parameters" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "dimensions" d
                 WHERE d."id" = "parameters"."dimension_id"
                   AND d."workspace_id" IN (SELECT app_writable_workspace_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM "dimensions" d
                       WHERE d."id" = "parameters"."dimension_id"
                         AND d."workspace_id" IN (SELECT app_writable_workspace_ids())));
CREATE POLICY parameters_delete ON "parameters" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "dimensions" d
                 WHERE d."id" = "parameters"."dimension_id"
                   AND d."workspace_id" IN (SELECT app_writable_workspace_ids())));
--> statement-breakpoint

CREATE POLICY bindings_select ON "bindings" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "contexts" c
                 WHERE c."id" = "bindings"."context_id"
                   AND c."workspace_id" IN (SELECT app_member_workspace_ids())));
CREATE POLICY bindings_insert ON "bindings" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "contexts" c
                       WHERE c."id" = "bindings"."context_id"
                         AND c."workspace_id" IN (SELECT app_writable_workspace_ids())));
CREATE POLICY bindings_update ON "bindings" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "contexts" c
                 WHERE c."id" = "bindings"."context_id"
                   AND c."workspace_id" IN (SELECT app_writable_workspace_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM "contexts" c
                       WHERE c."id" = "bindings"."context_id"
                         AND c."workspace_id" IN (SELECT app_writable_workspace_ids())));
CREATE POLICY bindings_delete ON "bindings" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "contexts" c
                 WHERE c."id" = "bindings"."context_id"
                   AND c."workspace_id" IN (SELECT app_writable_workspace_ids())));
