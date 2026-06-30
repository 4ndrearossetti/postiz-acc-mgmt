// CSV parsing + dry-run diff for the two bulk imports (SPEC 4.3).
import { getPool } from './db';
import { isRole, Role } from './creation';

// Minimal RFC-4180 CSV parser (handles quotes, commas and newlines in fields).
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let i = 0;
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => (obj[h] = (r[idx] ?? '').trim()));
    return obj;
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RowClass = 'new-account' | 'reuse-account' | 'add-membership' | 'no-op';

export interface MemberDiffRow {
  line: number;
  email: string;
  name: string;
  orgId: string;
  role: string;
  password: string;
  errors: string[];
  accountClass: 'new-account' | 'reuse-account' | null;
  membershipClass: 'add-membership' | 'no-op' | null;
}

export interface MemberDiff {
  rows: MemberDiffRow[];
  valid: boolean;
}

// members.csv: email,password,name,org_id,role
export async function diffMembers(records: Record<string, string>[]): Promise<MemberDiff> {
  const pool = getPool();
  // Preload existing accounts + memberships for classification.
  const emails = [...new Set(records.map((r) => (r.email || '').trim().toLowerCase()).filter(Boolean))];
  const orgIds = [...new Set(records.map((r) => (r.org_id || '').trim()).filter(Boolean))];

  const existingUsers = new Map<string, string>(); // email -> id
  if (emails.length) {
    const { rows } = await pool.query(
      `SELECT id, email FROM "User" WHERE "providerName" = 'LOCAL' AND email = ANY($1::text[])`,
      [emails],
    );
    rows.forEach((r) => existingUsers.set(r.email, r.id));
  }
  const existingOrgs = new Set<string>();
  if (orgIds.length) {
    const { rows } = await pool.query(`SELECT id FROM "Organization" WHERE id = ANY($1::text[])`, [orgIds]);
    rows.forEach((r) => existingOrgs.add(r.id));
  }
  const memberships = new Set<string>(); // `${userId}|${orgId}`
  if (existingUsers.size && orgIds.length) {
    const { rows } = await pool.query(
      `SELECT "userId", "organizationId" FROM "UserOrganization"
        WHERE "userId" = ANY($1::text[]) AND "organizationId" = ANY($2::text[])`,
      [[...existingUsers.values()], orgIds],
    );
    rows.forEach((r) => memberships.add(`${r.userId}|${r.organizationId}`));
  }

  const out: MemberDiffRow[] = records.map((r, idx) => {
    const email = (r.email || '').trim().toLowerCase();
    const name = (r.name || '').trim();
    const orgId = (r.org_id || '').trim();
    const role = (r.role || '').trim().toUpperCase();
    const password = (r.password || '').trim();
    const errors: string[] = [];
    if (!email) errors.push('missing email');
    else if (!EMAIL_RE.test(email)) errors.push('invalid email');
    if (!name) errors.push('missing name');
    if (!orgId) errors.push('missing org_id');
    else if (!existingOrgs.has(orgId)) errors.push(`org_id not found: ${orgId}`);
    if (!isRole(role)) errors.push(`invalid role: ${r.role}`);

    let accountClass: MemberDiffRow['accountClass'] = null;
    let membershipClass: MemberDiffRow['membershipClass'] = null;
    if (errors.length === 0) {
      const uid = existingUsers.get(email);
      accountClass = uid ? 'reuse-account' : 'new-account';
      const hasMembership = uid ? memberships.has(`${uid}|${orgId}`) : false;
      membershipClass = hasMembership ? 'no-op' : 'add-membership';
    }
    return { line: idx + 2, email, name, orgId, role, password, errors, accountClass, membershipClass };
  });

  return { rows: out, valid: out.every((r) => r.errors.length === 0) };
}

export interface WorkspaceDiffRow {
  line: number;
  workspaceName: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
  errors: string[];
  ownerClass: 'new-account' | 'reuse-account' | null;
}

export interface WorkspaceDiff {
  rows: WorkspaceDiffRow[];
  valid: boolean;
}

// workspaces.csv: workspace_name,owner_email,owner_password,owner_name
export async function diffWorkspaces(records: Record<string, string>[]): Promise<WorkspaceDiff> {
  const pool = getPool();
  const emails = [...new Set(records.map((r) => (r.owner_email || '').trim().toLowerCase()).filter(Boolean))];
  const existing = new Set<string>();
  if (emails.length) {
    const { rows } = await pool.query(
      `SELECT email FROM "User" WHERE "providerName" = 'LOCAL' AND email = ANY($1::text[])`,
      [emails],
    );
    rows.forEach((r) => existing.add(r.email));
  }
  const out: WorkspaceDiffRow[] = records.map((r, idx) => {
    const workspaceName = (r.workspace_name || '').trim();
    const ownerEmail = (r.owner_email || '').trim().toLowerCase();
    const ownerName = (r.owner_name || '').trim();
    const ownerPassword = (r.owner_password || '').trim();
    const errors: string[] = [];
    if (!workspaceName) errors.push('missing workspace_name');
    if (!ownerEmail) errors.push('missing owner_email');
    else if (!EMAIL_RE.test(ownerEmail)) errors.push('invalid owner_email');
    if (!ownerName) errors.push('missing owner_name');
    const ownerClass = errors.length === 0 ? (existing.has(ownerEmail) ? 'reuse-account' : 'new-account') : null;
    return { line: idx + 2, workspaceName, ownerEmail, ownerName, ownerPassword, errors, ownerClass };
  });
  return { rows: out, valid: out.every((r) => r.errors.length === 0) };
}

export function asRole(s: string): Role {
  return s.trim().toUpperCase() as Role;
}
