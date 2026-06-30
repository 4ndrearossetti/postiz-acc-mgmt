// Read views + the 4 health checks (SPEC 4.1 / Appendix B.3).
import { getPool } from './db';

export interface WorkspaceRow {
  id: string;
  name: string;
  members: number;
  channels: number;
  posts: number;
  superadmins: string[];
  duplicateName: boolean;
  emptyShell: boolean;
}

export async function listWorkspaces(): Promise<WorkspaceRow[]> {
  const { rows } = await getPool().query(`
    WITH dup AS (
      SELECT name FROM "Organization" GROUP BY name HAVING count(*) > 1
    )
    SELECT o.id, o.name,
           (SELECT count(*) FROM "UserOrganization" uo WHERE uo."organizationId" = o.id) AS members,
           (SELECT count(*) FROM "Integration"      i  WHERE i."organizationId" = o.id) AS channels,
           (SELECT count(*) FROM "Post"             p  WHERE p."organizationId" = o.id) AS posts,
           COALESCE((SELECT array_agg(u.email ORDER BY u.email)
                       FROM "UserOrganization" uo
                       JOIN "User" u ON u.id = uo."userId"
                      WHERE uo."organizationId" = o.id AND uo.role = 'SUPERADMIN'), '{}') AS superadmins,
           (o.name IN (SELECT name FROM dup)) AS dup
      FROM "Organization" o
     ORDER BY o.name, o.id`);
  return rows.map((r) => {
    const members = parseInt(r.members, 10);
    const channels = parseInt(r.channels, 10);
    const posts = parseInt(r.posts, 10);
    return {
      id: r.id,
      name: r.name,
      members,
      channels,
      posts,
      superadmins: r.superadmins || [],
      duplicateName: r.dup,
      emptyShell: members === 0 && channels === 0 && posts === 0,
    };
  });
}

export interface AccountRow {
  id: string;
  email: string;
  provider: string;
  activated: boolean;
  memberships: number;
  workspaces: { name: string; role: string }[];
  orphan: boolean;
  shared: boolean;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const { rows } = await getPool().query(`
    SELECT u.id, u.email, u."providerName" AS provider, u.activated,
           COALESCE((SELECT json_agg(json_build_object('name', o.name, 'role', uo.role) ORDER BY o.name)
                       FROM "UserOrganization" uo
                       JOIN "Organization" o ON o.id = uo."organizationId"
                      WHERE uo."userId" = u.id), '[]') AS workspaces,
           (SELECT count(*) FROM "UserOrganization" uo WHERE uo."userId" = u.id) AS memberships
      FROM "User" u
     ORDER BY u.email`);
  return rows.map((r) => {
    const memberships = parseInt(r.memberships, 10);
    return {
      id: r.id,
      email: r.email,
      provider: r.provider,
      activated: r.activated,
      memberships,
      workspaces: r.workspaces || [],
      orphan: memberships === 0,
      shared: memberships > 1,
    };
  });
}

export interface HealthReport {
  noSuperadmin: { id: string; name: string }[];
  orphanAccounts: { email: string; provider: string; activated: boolean }[];
  duplicateNames: { name: string; copies: number; ids: string }[];
  sharedAccounts: { email: string; workspaces: number; roles: string }[];
}

export async function healthChecks(): Promise<HealthReport> {
  const pool = getPool();
  const [noSa, orphan, dup, shared] = await Promise.all([
    pool.query(`SELECT o.id, o.name FROM "Organization" o
                 WHERE NOT EXISTS (SELECT 1 FROM "UserOrganization" uo
                                    WHERE uo."organizationId" = o.id AND uo.role = 'SUPERADMIN')
                 ORDER BY o.name`),
    pool.query(`SELECT u.email, u."providerName" AS provider, u.activated FROM "User" u
                 WHERE NOT EXISTS (SELECT 1 FROM "UserOrganization" uo WHERE uo."userId" = u.id)
                 ORDER BY u.email`),
    pool.query(`SELECT name, count(*)::int AS copies, string_agg(id::text, ', ') AS ids
                  FROM "Organization" GROUP BY name HAVING count(*) > 1 ORDER BY name`),
    pool.query(`SELECT u.email, count(*)::int AS workspaces,
                       string_agg(o.name || ':' || uo.role::text, ', ' ORDER BY o.name) AS roles
                  FROM "User" u
                  JOIN "UserOrganization" uo ON uo."userId" = u.id
                  JOIN "Organization" o      ON o.id = uo."organizationId"
                 GROUP BY u.id, u.email HAVING count(*) > 1 ORDER BY u.email`),
  ]);
  return {
    noSuperadmin: noSa.rows,
    orphanAccounts: orphan.rows,
    duplicateNames: dup.rows,
    sharedAccounts: shared.rows,
  };
}

// Pre-flight detail for deleting workspaces: roster + who would drop to zero.
export async function workspaceDeletePreflight(orgIds: string[]) {
  const pool = getPool();
  const roster = await pool.query(
    `SELECT o.id AS org_id, o.name AS org_name, u.id AS user_id, u.email, uo.role
       FROM "UserOrganization" uo
       JOIN "Organization" o ON o.id = uo."organizationId"
       JOIN "User" u         ON u.id = uo."userId"
      WHERE uo."organizationId" = ANY($1::text[])
      ORDER BY o.name, u.email`,
    [orgIds],
  );
  // Members of the deleted set with NO membership in any surviving workspace.
  const orphaning = await pool.query(
    `SELECT DISTINCT u.email, u.id
       FROM "UserOrganization" uo
       JOIN "User" u ON u.id = uo."userId"
      WHERE uo."organizationId" = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM "UserOrganization" x
           WHERE x."userId" = uo."userId"
             AND x."organizationId" <> ALL($1::text[])
        )
      ORDER BY u.email`,
    [orgIds],
  );
  return { roster: roster.rows, wouldOrphan: orphaning.rows };
}

// Pre-flight detail for deleting accounts: which workspaces they super-admin
// (orphan risk) and which memberships vanish.
export async function accountDeletePreflight(userIds: string[]) {
  const pool = getPool();
  const memberships = await pool.query(
    `SELECT u.email, u.id AS user_id, o.name AS org_name, o.id AS org_id, uo.role
       FROM "UserOrganization" uo
       JOIN "User" u         ON u.id = uo."userId"
       JOIN "Organization" o ON o.id = uo."organizationId"
      WHERE uo."userId" = ANY($1::text[])
      ORDER BY u.email, o.name`,
    [userIds],
  );
  // Workspaces that would lose their LAST superadmin if these users go.
  const losingLastSa = await pool.query(
    `SELECT o.id, o.name
       FROM "Organization" o
      WHERE EXISTS (SELECT 1 FROM "UserOrganization" uo
                     WHERE uo."organizationId" = o.id AND uo.role = 'SUPERADMIN'
                       AND uo."userId" = ANY($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM "UserOrganization" uo
                         WHERE uo."organizationId" = o.id AND uo.role = 'SUPERADMIN'
                           AND NOT (uo."userId" = ANY($1::text[])))
      ORDER BY o.name`,
    [userIds],
  );
  return { memberships: memberships.rows, losingLastSuperadmin: losingLastSa.rows };
}

export async function listOrganizationsForSelect() {
  const { rows } = await getPool().query(
    `SELECT o.id, o.name,
            (SELECT count(*)::int FROM "UserOrganization" uo WHERE uo."organizationId" = o.id) AS members
       FROM "Organization" o ORDER BY o.name, o.id`,
  );
  return rows as { id: string; name: string; members: number }[];
}

// Confirmation labels derived from the target IDS directly (NOT from
// membership joins) so empty-shell workspaces are confirmable, and returned as
// a LIST (one per id) so duplicate workspace names must each be typed.
export async function deleteTargetLabels(orgIds: string[], userIds: string[]): Promise<string[]> {
  const pool = getPool();
  const labels: string[] = [];
  if (orgIds.length) {
    const { rows } = await pool.query(`SELECT id, name FROM "Organization" WHERE id = ANY($1::text[])`, [orgIds]);
    const byId = new Map(rows.map((r) => [r.id, r.name as string]));
    for (const id of orgIds) if (byId.has(id)) labels.push(byId.get(id)!);
  }
  if (userIds.length) {
    const { rows } = await pool.query(`SELECT id, email FROM "User" WHERE id = ANY($1::text[])`, [userIds]);
    const byId = new Map(rows.map((r) => [r.id, r.email as string]));
    for (const id of userIds) if (byId.has(id)) labels.push(byId.get(id)!);
  }
  return labels;
}

// Compare two label lists as MULTISETS (order-independent, count-sensitive).
export function labelsMatch(expected: string[], typed: string[]): boolean {
  if (expected.length === 0 || expected.length !== typed.length) return false;
  const norm = (a: string[]) => a.map((s) => s.trim()).sort();
  const e = norm(expected);
  const t = norm(typed);
  return e.every((v, i) => v === t[i]);
}

export async function organizationExists(id: string): Promise<boolean> {
  const { rows } = await getPool().query(`SELECT 1 FROM "Organization" WHERE id = $1`, [id]);
  return rows.length > 0;
}
