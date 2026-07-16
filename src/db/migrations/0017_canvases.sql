-- Issue 090 — a design canvas becomes a first-class row. Until now a "canvas"
-- was an implicit composite key `(project_id, context_id/parent_id)`:
-- context_id/parent_id NULL = the project's single root canvas, set = that
-- context's child canvas (issue 011 recursion). This migration makes canvases
-- real rows so a project can hold MANY root canvases, and adds an explicit
-- `canvas_id` membership FK to `dimensions` and `contexts`.
--
-- Structure of this file (established 0008/0015 pattern):
--   1. drizzle-kit generated the CREATE TABLE + the canvases FKs + the partial
--      unique index (below, verbatim).
--   2. The two `ADD COLUMN canvas_id` on dimensions/contexts are hand-edited to
--      the safe nullable -> backfill -> SET NOT NULL -> add-FK sequence (0015),
--      so this is correct against a real, already-populated database, not just
--      an empty PGlite one.
--   3. The backfill (hand-authored, deterministic — SQL cannot call uuidv7, so
--      backfilled canvas ids derive from project_id / context_id and the whole
--      migration is reproducible given the current data).
--   4. RLS policies + ENABLE ROW LEVEL SECURITY (0008 direct-workspace_id
--      pattern — canvases carries its own workspace_id) + REPLICA IDENTITY FULL
--      (0012 — Electric logical replication) are hand-appended.

CREATE TABLE "canvases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_context_id" text,
	"name" text,
	"sort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_parent_context_id_contexts_id_fk" FOREIGN KEY ("parent_context_id") REFERENCES "public"."contexts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canvases_parent_context_idx" ON "canvases" USING btree ("parent_context_id") WHERE "canvases"."deleted_at" IS NULL AND "canvases"."parent_context_id" IS NOT NULL;--> statement-breakpoint

-- ── Membership columns: add nullable first (0015 sequence) ───────────────────
ALTER TABLE "contexts" ADD COLUMN "canvas_id" text;--> statement-breakpoint
ALTER TABLE "dimensions" ADD COLUMN "canvas_id" text;--> statement-breakpoint

-- ── Backfill step 1: one ROOT canvas per project (even projects with zero
-- dimensions — Correction 1). Deterministic id 'canvas-' || project id. ──────
INSERT INTO "canvases" ("id", "project_id", "workspace_id", "parent_context_id", "name", "sort", "created_at", "updated_at")
SELECT 'canvas-' || p."id", p."id", p."workspace_id", NULL, 'Canvas 1', 0, now(), now()
FROM "projects" p;--> statement-breakpoint

-- ── Backfill step 2: one CHILD canvas per DISTINCT child context — the UNION
-- of dimensions.context_id and contexts.parent_id (a child canvas can hold
-- contexts but no seeded dimensions, or vice-versa; missing either would strand
-- rows). workspace_id comes from the owning context row. Deterministic id
-- 'canvas-ctx-' || context id. name left NULL (derive from the context symbol
-- at render — Open Question 1). ─────────────────────────────────────────────
INSERT INTO "canvases" ("id", "project_id", "workspace_id", "parent_context_id", "name", "sort", "created_at", "updated_at")
SELECT 'canvas-ctx-' || ctx."id", ctx."project_id", ctx."workspace_id", ctx."id", NULL, 0, now(), now()
FROM "contexts" ctx
WHERE ctx."id" IN (
  SELECT "context_id" FROM "dimensions" WHERE "context_id" IS NOT NULL
  UNION
  SELECT "parent_id" FROM "contexts" WHERE "parent_id" IS NOT NULL
);--> statement-breakpoint

-- ── Backfill step 3: repoint dimensions. Root dimensions (context_id NULL) →
-- the project's root canvas; child dimensions → their context's child canvas. ─
UPDATE "dimensions" SET "canvas_id" = 'canvas-' || "project_id" WHERE "context_id" IS NULL;--> statement-breakpoint
UPDATE "dimensions" SET "canvas_id" = 'canvas-ctx-' || "context_id" WHERE "context_id" IS NOT NULL;--> statement-breakpoint

-- ── Backfill step 4: repoint contexts. Root contexts (parent_id NULL) → the
-- project's root canvas; child contexts → the child canvas of their parent. ──
UPDATE "contexts" SET "canvas_id" = 'canvas-' || "project_id" WHERE "parent_id" IS NULL;--> statement-breakpoint
UPDATE "contexts" SET "canvas_id" = 'canvas-ctx-' || "parent_id" WHERE "parent_id" IS NOT NULL;--> statement-breakpoint

-- ── Backfill step 5: enforce NOT NULL, then add the FKs (after backfill so a
-- populated DB never violates them mid-migration — 0008/0015 ordering). ──────
ALTER TABLE "contexts" ALTER COLUMN "canvas_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dimensions" ALTER COLUMN "canvas_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contexts" ADD CONSTRAINT "contexts_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── RLS (hand-authored, 0008 direct-workspace_id pattern — canvases carries
-- its own workspace_id, so it mirrors the dimensions/contexts policies, NOT the
-- nested FK-chain form). app_member_workspace_ids()/app_writable_workspace_ids()
-- are defined in 0008. PGlite stays permissive (table owner); server Postgres
-- enforces via the granted-not-owning app_user role. ────────────────────────
ALTER TABLE "canvases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Table-level privilege for the non-owning server role (0008/0009 pattern — a
-- new table is NOT covered by 0008's GRANT list, so the write API / Electric's
-- app_user would be 42501-denied without this; RLS policies below only filter
-- rows a granted role may already touch, they do not grant the table itself).
GRANT SELECT, INSERT, UPDATE, DELETE ON "canvases" TO app_user;--> statement-breakpoint
CREATE POLICY canvases_select ON "canvases" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));--> statement-breakpoint
CREATE POLICY canvases_insert ON "canvases" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));--> statement-breakpoint
CREATE POLICY canvases_update ON "canvases" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));--> statement-breakpoint
CREATE POLICY canvases_delete ON "canvases" FOR DELETE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()));--> statement-breakpoint

-- ── Electric logical replication (0012 pattern): a WHERE-scoped shape needs the
-- full OLD row image to recognize a workspace move-out on UPDATE/DELETE. ─────
ALTER TABLE "canvases" REPLICA IDENTITY FULL;
