// Account / workspace / membership creation + management (SPEC 4.2, 4.5).
//
// Replicates Postiz's insert conventions exactly (LOCAL provider, timezone=0,
// activated=true, explicit updatedAt, the two ON CONFLICT clauses). All row
// values are bound parameters.
import * as crypto from 'crypto';
import { PoolClient } from 'pg';
import { withTransaction } from './db';
import { generatePassword, hashPassword } from './hash';

export type Role = 'USER' | 'ADMIN' | 'SUPERADMIN';
export const ROLES: Role[] = ['USER', 'ADMIN', 'SUPERADMIN'];

export function isRole(s: string): s is Role {
  return (ROLES as string[]).includes(s);
}

function uuid(): string {
  return crypto.randomUUID();
}

// Insert or reuse a LOCAL account. Reuse never touches the existing password.
async function upsertUser(
  c: PoolClient,
  email: string,
  name: string,
  passwordHash: string,
): Promise<{ id: string; reused: boolean }> {
  const norm = email.trim().toLowerCase();
  const pre = await c.query(
    `SELECT id FROM "User" WHERE email = $1 AND "providerName" = 'LOCAL'`,
    [norm],
  );
  const reused = pre.rows.length > 0;
  const res = await c.query(
    `INSERT INTO "User"(id,email,password,"providerName",name,timezone,activated,"createdAt","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, 'LOCAL', $3, 0, true, now(), now())
     ON CONFLICT (email,"providerName") DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [norm, passwordHash, name.trim()],
  );
  return { id: res.rows[0].id, reused };
}

async function ensureMembership(
  c: PoolClient,
  userId: string,
  orgId: string,
  role: Role,
): Promise<{ created: boolean }> {
  const res = await c.query(
    `INSERT INTO "UserOrganization"(id,"userId","organizationId",role,"createdAt","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now())
     ON CONFLICT ("userId","organizationId") DO NOTHING
     RETURNING id`,
    [userId, orgId, role],
  );
  return { created: (res.rowCount || 0) > 0 };
}

export interface NewMember {
  email: string;
  name: string;
  role: Role;
  password?: string; // if omitted, a secure one is generated for NEW accounts
}

export interface MemberResult {
  email: string;
  name: string;
  role: Role;
  accountStatus: 'new' | 'reused';
  membershipStatus: 'added' | 'exists';
  password?: string; // only present for newly-created accounts
}

// Case A — add accounts to an existing workspace.
export async function addMembersToWorkspace(
  orgId: string,
  members: NewMember[],
): Promise<MemberResult[]> {
  return withTransaction(async (c) => {
    // One password per unique brand-new email within this batch.
    const generated = new Map<string, string>();
    const out: MemberResult[] = [];
    for (const m of members) {
      const key = m.email.trim().toLowerCase();
      const plain = m.password || generated.get(key) || generatePassword();
      const { id, reused } = await upsertUser(c, m.email, m.name, hashPassword(plain));
      if (!reused && !m.password) generated.set(key, plain);
      const { created } = await ensureMembership(c, id, orgId, m.role);
      out.push({
        email: key,
        name: m.name.trim(),
        role: m.role,
        accountStatus: reused ? 'reused' : 'new',
        membershipStatus: created ? 'added' : 'exists',
        password: reused ? undefined : m.password || generated.get(key),
      });
    }
    return out;
  });
}

export interface NewWorkspace {
  workspaceName: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword?: string;
}

export interface WorkspaceResult {
  orgId: string;
  workspaceName: string;
  ownerEmail: string;
  ownerName: string;
  accountStatus: 'new' | 'reused';
  password?: string;
}

// Case B — create workspace + owner (SUPERADMIN) in one transaction.
export async function createWorkspaceWithOwner(ws: NewWorkspace): Promise<WorkspaceResult> {
  return withTransaction(async (c) => {
    const orgId = uuid();
    const plain = ws.ownerPassword || generatePassword();
    const { id: userId, reused } = await upsertUser(
      c,
      ws.ownerEmail,
      ws.ownerName,
      hashPassword(plain),
    );
    await c.query(
      `INSERT INTO "Organization"(id,name,"allowTrial","isTrailing","createdAt","updatedAt")
       VALUES ($1, $2, true, true, now(), now())`,
      [orgId, ws.workspaceName.trim()],
    );
    await ensureMembership(c, userId, orgId, 'SUPERADMIN');
    return {
      orgId,
      workspaceName: ws.workspaceName.trim(),
      ownerEmail: ws.ownerEmail.trim().toLowerCase(),
      ownerName: ws.ownerName.trim(),
      accountStatus: reused ? 'reused' : 'new',
      password: reused ? undefined : ws.ownerPassword || plain,
    };
  });
}

// Case C — create workspace + owner, then populate with members.
export async function createAndPopulate(
  ws: NewWorkspace,
  members: NewMember[],
): Promise<{ workspace: WorkspaceResult; members: MemberResult[] }> {
  const workspace = await createWorkspaceWithOwner(ws);
  const memberResults = members.length ? await addMembersToWorkspace(workspace.orgId, members) : [];
  return { workspace, members: memberResults };
}

// ── Bulk CSV execution (SPEC 4.3) — one transaction for the whole batch ──────

export interface BulkMemberRow {
  email: string;
  name: string;
  orgId: string;
  role: Role;
  password?: string;
}

export async function bulkImportMembers(rows: BulkMemberRow[]): Promise<MemberResult[]> {
  return withTransaction(async (c) => {
    const generated = new Map<string, string>();
    const out: MemberResult[] = [];
    for (const r of rows) {
      const key = r.email.trim().toLowerCase();
      const plain = r.password || generated.get(key) || generatePassword();
      const { id, reused } = await upsertUser(c, r.email, r.name, hashPassword(plain));
      if (!reused && !r.password) generated.set(key, plain);
      const { created } = await ensureMembership(c, id, r.orgId, r.role);
      out.push({
        email: key,
        name: r.name.trim(),
        role: r.role,
        accountStatus: reused ? 'reused' : 'new',
        membershipStatus: created ? 'added' : 'exists',
        password: reused ? undefined : r.password || generated.get(key),
      });
    }
    return out;
  });
}

export async function bulkCreateWorkspaces(rows: NewWorkspace[]): Promise<WorkspaceResult[]> {
  return withTransaction(async (c) => {
    const out: WorkspaceResult[] = [];
    for (const ws of rows) {
      const orgId = uuid();
      const plain = ws.ownerPassword || generatePassword();
      const { id: userId, reused } = await upsertUser(
        c,
        ws.ownerEmail,
        ws.ownerName,
        hashPassword(plain),
      );
      await c.query(
        `INSERT INTO "Organization"(id,name,"allowTrial","isTrailing","createdAt","updatedAt")
         VALUES ($1, $2, true, true, now(), now())`,
        [orgId, ws.workspaceName.trim()],
      );
      await ensureMembership(c, userId, orgId, 'SUPERADMIN');
      out.push({
        orgId,
        workspaceName: ws.workspaceName.trim(),
        ownerEmail: ws.ownerEmail.trim().toLowerCase(),
        ownerName: ws.ownerName.trim(),
        accountStatus: reused ? 'reused' : 'new',
        password: reused ? undefined : ws.ownerPassword || plain,
      });
    }
    return out;
  });
}

// ── Management (SPEC 4.5) ────────────────────────────────────────────────────

async function superadminCount(c: PoolClient, orgId: string, excludeUserId?: string): Promise<number> {
  const res = await c.query(
    `SELECT count(*)::int AS n FROM "UserOrganization"
      WHERE "organizationId" = $1 AND role = 'SUPERADMIN'
        AND ($2::text IS NULL OR "userId" <> $2)`,
    [orgId, excludeUserId ?? null],
  );
  return res.rows[0].n;
}

export class LastSuperadminError extends Error {
  constructor(public orgId: string) {
    super('This is the last SUPERADMIN of the workspace; pass override to proceed.');
  }
}

export async function changeRole(
  orgId: string,
  userId: string,
  newRole: Role,
  override = false,
): Promise<{ updated: boolean }> {
  return withTransaction(async (c) => {
    const cur = await c.query(
      `SELECT role FROM "UserOrganization" WHERE "organizationId" = $1 AND "userId" = $2`,
      [orgId, userId],
    );
    if (cur.rows.length === 0) throw new Error('No such membership.');
    const wasSa = cur.rows[0].role === 'SUPERADMIN';
    if (wasSa && newRole !== 'SUPERADMIN' && !override) {
      if ((await superadminCount(c, orgId, userId)) === 0) throw new LastSuperadminError(orgId);
    }
    const res = await c.query(
      `UPDATE "UserOrganization" SET role = $3, "updatedAt" = now()
        WHERE "organizationId" = $1 AND "userId" = $2`,
      [orgId, userId, newRole],
    );
    return { updated: (res.rowCount || 0) > 0 };
  });
}

export async function removeMember(
  orgId: string,
  userId: string,
  override = false,
): Promise<{ removed: boolean }> {
  return withTransaction(async (c) => {
    const cur = await c.query(
      `SELECT role FROM "UserOrganization" WHERE "organizationId" = $1 AND "userId" = $2`,
      [orgId, userId],
    );
    if (cur.rows.length === 0) return { removed: false };
    if (cur.rows[0].role === 'SUPERADMIN' && !override) {
      if ((await superadminCount(c, orgId, userId)) === 0) throw new LastSuperadminError(orgId);
    }
    const res = await c.query(
      `DELETE FROM "UserOrganization" WHERE "organizationId" = $1 AND "userId" = $2`,
      [orgId, userId],
    );
    return { removed: (res.rowCount || 0) > 0 };
  });
}
