import { and, asc, eq, isNull } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Database } from './client'
import { firstOrThrow } from './util'
import { workspaceMembers, workspaces } from './schema'
import type { WorkspaceRole } from '../domain/workspaceRole'

// Issue 034 — the workspace/membership mutation layer (mirrors mutations.ts's
// "every DB write flows through one seam" convention, kept in its own module
// since workspaces are a cross-cutting identity concern, not a project-tree
// tier). RLS (migration 0008) is the enforcing backstop; these functions are
// the ordinary app-side path a trusted server/local context uses to manage
// membership — they do not themselves check role (the DB does).

export type WorkspaceRow = typeof workspaces.$inferSelect
export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect

function now(): string {
  return new Date().toISOString()
}

export async function createWorkspace(
  db: Database,
  name: string,
  ownerSub?: string,
): Promise<WorkspaceRow> {
  const rows = await db.insert(workspaces).values({ id: uuidv7(), name }).returning()
  const workspace = firstOrThrow(rows)
  if (ownerSub) {
    await addWorkspaceMember(db, workspace.id, ownerSub, 'owner')
  }
  return workspace
}

// Local-first single-user simplification (design brief: "on PGlite the
// workspace is a formality — one personal workspace"). Returns the oldest
// live workspace if one already exists (so re-running never creates a second
// one), otherwise creates "Personal Workspace". Used by createProject when no
// explicit workspaceId is supplied — keeps every pre-034 caller (store/
// projects.ts, components) unchanged; they never need to know workspaces
// exist unless/until 035's UX gives them a picker.
export async function getOrCreateDefaultWorkspace(db: Database): Promise<string> {
  const existing = await db
    .select()
    .from(workspaces)
    .where(isNull(workspaces.deletedAt))
    .orderBy(asc(workspaces.createdAt))
    .limit(1)
  if (existing.length > 0) return firstOrThrow(existing).id
  const created = await createWorkspace(db, 'Personal Workspace')
  return created.id
}

function memberScope(workspaceId: string) {
  return and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.deletedAt))
}

export async function listMembers(db: Database, workspaceId: string): Promise<WorkspaceMemberRow[]> {
  return db.select().from(workspaceMembers).where(memberScope(workspaceId)).orderBy(asc(workspaceMembers.createdAt))
}

// Every workspace a given Cognito `sub` currently belongs to (live rows only)
// — the pure input the sync layer's client-side scoping (src/domain/
// syncScope.ts) needs to build a workspace-scoped shape request.
export async function listWorkspaceIdsForUser(db: Database, userSub: string): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userSub, userSub), isNull(workspaceMembers.deletedAt)))
  return rows.map((r) => r.workspaceId)
}

export async function addWorkspaceMember(
  db: Database,
  workspaceId: string,
  userSub: string,
  role: WorkspaceRole = 'viewer',
): Promise<WorkspaceMemberRow> {
  const rows = await db
    .insert(workspaceMembers)
    .values({ id: uuidv7(), workspaceId, userSub, role })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userSub],
      set: { role, deletedAt: null, updatedAt: now() },
    })
    .returning()
  return firstOrThrow(rows)
}

export async function setWorkspaceMemberRole(
  db: Database,
  workspaceId: string,
  userSub: string,
  role: WorkspaceRole,
): Promise<WorkspaceMemberRow> {
  const rows = await db
    .update(workspaceMembers)
    .set({ role, updatedAt: now() })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userSub, userSub)))
    .returning()
  return firstOrThrow(rows)
}

// Soft-delete (mirrors every other table's tombstone convention, SPEC §3) so
// a removal is itself a row-delta the sync stream can propagate, not a
// silent disappearance.
export async function removeWorkspaceMember(
  db: Database,
  workspaceId: string,
  userSub: string,
): Promise<void> {
  await db
    .update(workspaceMembers)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userSub, userSub)))
}
