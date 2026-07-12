-- Issue 078 step 2 — denormalizes `workspace_id` directly onto the three
-- nested child tables (`parameters`, `bindings`, `tier2_entries`) that
-- migration 0008 deliberately left scoped only via their parent's FK chain
-- (see 0008's own header: "scoping columns onto every nested table would
-- ripple workspace_id-threading into every mutation... flagged for review").
--
-- That review landed: 078 diagnosed Electric serving stale/empty shapes for
-- some sessions, root-caused to shape-cache churn on the experimental
-- `ELECTRIC_FEATURE_FLAGS=allow_subqueries` opt-in these three tables'
-- subquery-shaped WHERE clauses required (src/domain/syncScope.ts). A
-- literal `workspace_id = ANY($1::text[])` predicate — the same simple shape
-- every other synced table already uses — needs a real column, not a
-- subquery against tier2_tables/dimensions/contexts. This migration adds
-- it; src/domain/syncScope.ts's WORKSPACE_SCOPE_SQL switches these three
-- tables to the literal predicate, and deploy/cdk/lib/api-stack.ts drops the
-- `allow_subqueries` env var entirely.
--
-- RLS is UNCHANGED: migration 0008's parameters_select/bindings_select/
-- tier2_entries_select policies still walk the FK chain (tier2_tables/
-- dimensions/contexts) — they remain correct with or without this column,
-- so this migration does not touch them. This column is a read-path
-- (Electric shape-scoping) optimization only, not a new enforcement point.
--
-- Sequence mirrors 0008_workspaces_rls.sql exactly: ADD COLUMN nullable ->
-- backfill each child from its SPECIFIC parent -> SET NOT NULL, so this is
-- safe against a real, already-populated database (not just an empty one).
ALTER TABLE "parameters" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "bindings" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "tier2_entries" ADD COLUMN "workspace_id" text;--> statement-breakpoint

-- ── Backfill: each child's workspace comes from its SPECIFIC parent, not a
-- fresh default-workspace shortcut (0008's own backfill invented a brand-new
-- "Personal Workspace" for orphaned top-level rows; these three are never
-- orphaned — every live row already has a real parent row carrying a real
-- workspace_id) ──────────────────────────────────────────────────────────
UPDATE "parameters" p SET "workspace_id" = d."workspace_id" FROM "dimensions" d WHERE d."id" = p."dimension_id";--> statement-breakpoint
UPDATE "bindings" b SET "workspace_id" = c."workspace_id" FROM "contexts" c WHERE c."id" = b."context_id";--> statement-breakpoint
UPDATE "tier2_entries" e SET "workspace_id" = t."workspace_id" FROM "tier2_tables" t WHERE t."id" = e."table_id";--> statement-breakpoint

ALTER TABLE "parameters" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bindings" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tier2_entries" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "parameters" ADD CONSTRAINT "parameters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier2_entries" ADD CONSTRAINT "tier2_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
