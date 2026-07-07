-- Issue 035 (ADR-0009/0010, done/034 deviation #3) — the invitation/granting
-- path 034 deliberately deferred. Drizzle-generated DDL (the `invitations`
-- table) is followed by hand-authored RLS policies + a tightened
-- `workspace_members` INSERT policy, exactly as migration 0008 did for the
-- enforcement layer. See that migration's header for why this file is
-- "permissive on PGlite, enforcing on Postgres" with zero dialect fork (the
-- app's own connection is always the table OWNER, which Postgres exempts from
-- RLS) — the same reasoning applies unchanged here.
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "workspace_role" DEFAULT 'viewer' NOT NULL,
	"invited_by_sub" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "invitations" TO app_user;
--> statement-breakpoint

-- ── The identity seam's email half (ADR-0009) ───────────────────────────────
-- `app_current_user_sub()` (migration 0008) is the row-scoping identity; an
-- invitation is keyed by EMAIL (the owner doesn't know the invitee's Cognito
-- `sub` until they accept — that's the whole reason this table exists rather
-- than 034's self-bootstrap `workspace_members` INSERT being enough). Mirrors
-- 0008's GUC pattern exactly: src/db/tenantContext.ts's `setTenantEmail` sets
-- `app.current_user_email` once per session alongside the sub.
CREATE OR REPLACE FUNCTION app_current_user_email() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.current_user_email', true), '')
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ── SECURITY DEFINER helpers (break RLS self-reference, per 0008's header) ──
-- `app_workspace_has_any_member` backs the tightened workspace_members INSERT
-- policy below: it must read workspace_members from INSIDE that same table's
-- own INSERT policy, which — like 0008's SELECT-policy recursion — needs the
-- SECURITY DEFINER escape hatch rather than an inline subquery.
CREATE OR REPLACE FUNCTION app_workspace_has_any_member(ws_id text) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ws_id AND deleted_at IS NULL)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- A caller may self-seat into an ALREADY-populated workspace only by
-- redeeming a still-valid (unaccepted, unrevoked, unexpired) invitation whose
-- email matches their own and whose role matches the row they're inserting —
-- i.e. accepting can grant exactly the role the owner invited, never more.
CREATE OR REPLACE FUNCTION app_has_valid_invitation(ws_id text, r workspace_role) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM invitations
    WHERE workspace_id = ws_id
      AND lower(email) = lower(app_current_user_email())
      AND role = r
      AND accepted_at IS NULL
      AND deleted_at IS NULL
      AND expires_at > now()
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint

-- ── Fix workspace_members SELECT (surfaced by this issue's own RLS test) ────
-- 0008's SELECT policy was subquery-only (`workspace_id IN (SELECT
-- app_member_workspace_ids())`), unlike its own DELETE policy which also has
-- a direct `user_sub = app_current_user_sub()` self-branch. That asymmetry
-- is latent but real: an INSERT ... RETURNING (exactly what
-- addWorkspaceMember/acceptInvitation do) needs the SELECT policy to admit
-- the just-inserted row so it can be returned, and a self-referencing
-- subquery over the SAME table cannot see a row inserted earlier in the SAME
-- command (Postgres command-visibility semantics) — every prior test
-- exercised these functions only as the table owner (bypassing RLS
-- entirely), so this never surfaced until this issue's RLS tests ran them as
-- `app_user`. The fix mirrors DELETE's existing pattern: a plain column
-- comparison (no subquery) always sees the row's own value, sidestepping the
-- command-visibility gap entirely, and is a strict widening only for exactly
-- "can I see my own membership row" — never another tenant's.
DROP POLICY workspace_members_select ON "workspace_members";
CREATE POLICY workspace_members_select ON "workspace_members" FOR SELECT
  USING (
    "workspace_id" IN (SELECT app_member_workspace_ids())
    OR "user_sub" = app_current_user_sub()
  );
--> statement-breakpoint

-- ── Tighten workspace_members INSERT (done/034 deviation #3) ────────────────
-- 0008 shipped this self-only, unconditionally allowing any authenticated
-- caller to seat THEMSELVES into ANY workspace_id at ANY role (the column
-- default is even 'owner') — deliberately deferred here per that issue's own
-- scope note. That's fine for the one legitimate self-insert case
-- (createWorkspace's bootstrap: a brand-new workspace, zero existing members,
-- seating its creator as owner) but would otherwise let anyone who merely
-- knows a workspace's id join it uninvited, which would make this issue's
-- whole invitation flow decorative. The tightened rule: self-insert is
-- allowed when the workspace has NO members yet (bootstrap), OR when a valid,
-- role-matching invitation is being redeemed; an owner may still seat anyone
-- directly (owned-workspace branch, unchanged).
DROP POLICY workspace_members_insert ON "workspace_members";
CREATE POLICY workspace_members_insert ON "workspace_members" FOR INSERT
  WITH CHECK (
    (
      "user_sub" = app_current_user_sub()
      AND (
        NOT app_workspace_has_any_member("workspace_id")
        OR app_has_valid_invitation("workspace_id", "role")
      )
    )
    OR "workspace_id" IN (SELECT app_owned_workspace_ids())
  );
--> statement-breakpoint

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── invitations policies ─────────────────────────────────────────────────────
-- SELECT: the owner managing the workspace, or the invitee themselves (email
-- match) reading their own still-visible (non-deleted) invite — the accept
-- flow's own lookup needs this before it has any workspace_members row at all.
CREATE POLICY invitations_select ON "invitations" FOR SELECT
  USING (
    "workspace_id" IN (SELECT app_owned_workspace_ids())
    OR (lower("email") = lower(app_current_user_email()) AND "deleted_at" IS NULL)
  );
-- INSERT: owner only — granting is an owner-only act (design brief, 035 scope).
CREATE POLICY invitations_insert ON "invitations" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_owned_workspace_ids()));
-- UPDATE: the owner (revoke via deleted_at, resend via expires_at) or the
-- invitee themselves (accept via accepted_at) — src/db/invitations.ts's
-- `acceptInvitation` is the only caller that ever sets accepted_at from the
-- non-owner side, mirroring this repo's existing trust model (RLS scopes
-- WHICH rows a caller may touch; the app-layer function is what's trusted to
-- only touch the right column, exactly as every other mutation here is).
CREATE POLICY invitations_update ON "invitations" FOR UPDATE
  USING (
    "workspace_id" IN (SELECT app_owned_workspace_ids())
    OR lower("email") = lower(app_current_user_email())
  )
  WITH CHECK (
    "workspace_id" IN (SELECT app_owned_workspace_ids())
    OR lower("email") = lower(app_current_user_email())
  );
-- DELETE: owner only (revoke is normally a soft-delete via UPDATE; this
-- policy exists so every table here has an explicit policy per command, per
-- 0008's own convention, not because a hard DELETE call site exists yet).
CREATE POLICY invitations_delete ON "invitations" FOR DELETE
  USING ("workspace_id" IN (SELECT app_owned_workspace_ids()));