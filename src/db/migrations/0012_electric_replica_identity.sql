-- Issue 058 — ElectricSQL requires REPLICA IDENTITY FULL on every table it
-- streams via logical replication: without it, an UPDATE/DELETE's WAL record
-- only carries the primary key (+ changed columns), which is not enough for
-- Electric to correctly compute shape membership transitions for a
-- WHERE-scoped shape (a row that stops matching a workspace-scoped WHERE
-- clause on UPDATE needs its full OLD row image to be recognized as a
-- "move-out" rather than silently vanishing) — see node_modules/
-- @electric-sql/client/skills/electric-postgres-security's "HIGH Missing
-- REPLICA IDENTITY FULL on tables" checklist item.
--
-- This is a pure Postgres replication setting — no column/schema shape
-- change — so it has no Drizzle-generated counterpart and no corresponding
-- meta/*_snapshot.json entry (unlike every other migration here, this one is
-- 100% hand-authored SQL, mirroring how 0008_workspaces_rls.sql's RLS
-- policies were hand-added alongside drizzle-generated DDL).
--
-- Scope: every table in src/domain/syncScope.ts's SYNCED_TABLES list (the
-- read-path's actual shape subscriptions, issue 058). `invitations`/
-- `workspace_members` are deliberately excluded — they are NOT Electric-
-- synced tables today (issue 056's own scope note); the shape-proxy resolves
-- a caller's memberships by querying `workspace_members` directly via a
-- normal (non-replication) connection, see src/server/shapeProxy/albAdapter.ts.
ALTER TABLE "projects" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "tier1_purpose" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "tier1_props" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "tier2_tables" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "tier2_entries" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "dimensions" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "parameters" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "contexts" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "bindings" REPLICA IDENTITY FULL;
