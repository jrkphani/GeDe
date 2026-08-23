-- Phase 3 (design-prose-references) — a reference token inside a Design
-- context's justification prose (Lexical JSON), pointing at the Architecture
-- (Tier 2) entry it cites. Structure follows 0017_canvases.sql's template
-- (CREATE TABLE -> FK constraints, no SQL cascades -> GRANT -> RLS -> REPLICA
-- IDENTITY FULL); this is a brand-new table with no existing rows, so there
-- is no backfill/data-migration step to carry over from that template.
--
-- RLS pattern: this table carries its own first-class `workspace_id` (not a
-- derived/optimization-only column), so its policies read `workspace_id`
-- DIRECTLY off the row — the 0008_workspaces_rls.sql `dimensions`/`contexts`
-- pattern, NOT the FK-chain subquery pattern 0008 uses for `parameters`/
-- `tier2_entries`/`bindings` (those gained workspace_id later, in
-- 0015_child_workspace_scoping.sql, as a read-path/Electric-shape-scoping
-- optimization only — their RLS enforcement still subqueries through their
-- parent). 0017_canvases.sql's own RLS already uses this same direct-read
-- form (canvases carries its own workspace_id too), so this migration mirrors
-- 0017's RLS block verbatim in shape.
CREATE TABLE "design_prose_references" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"context_id" text NOT NULL,
	"source_entry_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "design_prose_references" ADD CONSTRAINT "design_prose_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_prose_references" ADD CONSTRAINT "design_prose_references_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_prose_references" ADD CONSTRAINT "design_prose_references_source_entry_id_tier2_entries_id_fk" FOREIGN KEY ("source_entry_id") REFERENCES "public"."tier2_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Deliberate deviation from this schema's usual "no FK-column indexes"
-- convention (bindings/parameters/tier2_entries/etc. carry none) — this table
-- IS queried by both FKs at meaningful scale (every reference row for a
-- context's prose; every context referencing a given entry), so it gets them
-- on purpose. Not an oversight to "clean up" later.
-- No uniqueness constraint on (context_id, source_entry_id) — deliberate: one
-- Architecture entry may legitimately be referenced more than once in the
-- same prose, once per inline token occurrence.
CREATE INDEX "design_prose_references_context_id_idx" ON "design_prose_references" USING btree ("context_id");--> statement-breakpoint
CREATE INDEX "design_prose_references_source_entry_id_idx" ON "design_prose_references" USING btree ("source_entry_id");--> statement-breakpoint

-- ── RLS (0008 direct-workspace_id pattern — this table carries its own
-- workspace_id, so it mirrors the dimensions/contexts/canvases policies, NOT
-- the nested FK-chain form). app_member_workspace_ids()/
-- app_writable_workspace_ids() are defined in 0008. PGlite stays permissive
-- (table owner); server Postgres enforces via the granted-not-owning app_user
-- role. ────────────────────────────────────────────────────────────────────
ALTER TABLE "design_prose_references" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Table-level privilege for the non-owning server role (0008/0009/0017
-- pattern — a new table is NOT covered by 0008's GRANT list, so the write API
-- / Electric's app_user would be 42501-denied without this; RLS policies
-- below only filter rows a granted role may already touch, they do not grant
-- the table itself).
GRANT SELECT, INSERT, UPDATE, DELETE ON "design_prose_references" TO app_user;--> statement-breakpoint
CREATE POLICY design_prose_references_select ON "design_prose_references" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));--> statement-breakpoint
CREATE POLICY design_prose_references_insert ON "design_prose_references" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));--> statement-breakpoint
CREATE POLICY design_prose_references_update ON "design_prose_references" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));--> statement-breakpoint
CREATE POLICY design_prose_references_delete ON "design_prose_references" FOR DELETE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()));--> statement-breakpoint

-- ── Electric logical replication (0012 pattern): a WHERE-scoped shape needs
-- the full OLD row image to recognize a workspace move-out on UPDATE/DELETE.
ALTER TABLE "design_prose_references" REPLICA IDENTITY FULL;
