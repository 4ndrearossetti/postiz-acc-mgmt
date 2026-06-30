/* Adversarial / edge-case tests (QA pass).  Mirrors test/run.ts harness:
 * set env BEFORE importing src modules, then drive the exported functions.
 *
 * Reset the DB first:   bash scripts/test-db.sh up
 * Run:                   npx ts-node test/extra.ts
 *
 * Covers (per QA brief):
 *   a. single shared-account deletion (SPEC B.5)
 *   b. last-SUPERADMIN guard (changeRole / removeMember / override / 2 SAs)
 *   c. CSV dry-run classification + RFC-4180 parsing
 *   d. idempotency of bulkImportMembers
 *   e. duplicate workspace names allowed + flagged
 */
import * as path from 'path';

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGDATABASE = process.env.PGDATABASE || 'postiz_test';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'postgres';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.AUDIT_LOG = path.join(__dirname, '.tmp', 'audit.jsonl');
process.env.BACKUP_DIR = path.join(__dirname, '.tmp', 'backups');

import { loadConfig } from '../src/config';
import { initPool, getPool } from '../src/db';
import { initAudit } from '../src/audit';
import {
  createWorkspaceWithOwner,
  addMembersToWorkspace,
  bulkImportMembers,
  changeRole,
  removeMember,
  LastSuperadminError,
  BulkMemberRow,
} from '../src/creation';
import { healthChecks, listWorkspaces } from '../src/health';
import { runDelete } from '../src/deleteEngine';
import { diffMembers, diffWorkspaces, parseCsv } from '../src/csv';

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}
function section(t: string) { console.log(`\n# ${t}`); }

async function expectThrows(fn: () => Promise<unknown>, ctor: Function, msg: string) {
  try {
    await fn();
    ok(false, `${msg} (did NOT throw)`);
  } catch (e) {
    ok(e instanceof ctor, `${msg} (threw ${(e as Error).constructor.name})`);
  }
}

async function userIdByEmail(email: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT id FROM "User" WHERE email=$1 AND "providerName"='LOCAL'`, [email.toLowerCase()],
  );
  return rows[0]?.id ?? null;
}
async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await getPool().query(sql, params);
  return parseInt(rows[0].n, 10);
}

async function main() {
  const cfg = loadConfig();
  initPool(cfg);
  initAudit(cfg);
  const pool = getPool();

  // ============================================================== a. B.5 ====
  // Two workspaces share one account; delete ONLY that user.
  section('a. single shared-account deletion (SPEC B.5)');
  const wsA = await createWorkspaceWithOwner({ workspaceName: 'Alpha', ownerEmail: 'ownerA@x.test', ownerName: 'OwnerA' });
  const wsB = await createWorkspaceWithOwner({ workspaceName: 'Beta', ownerEmail: 'ownerB@x.test', ownerName: 'OwnerB' });
  await addMembersToWorkspace(wsA.orgId, [{ email: 'shared@x.test', name: 'Shared', role: 'USER' }]);
  await addMembersToWorkspace(wsB.orgId, [{ email: 'shared@x.test', name: 'Shared', role: 'ADMIN' }]);
  const sharedId = await userIdByEmail('shared@x.test');
  ok(!!sharedId, 'shared account exists with one User row');
  ok(await count(`SELECT count(*)::int n FROM "UserOrganization" WHERE "userId"=$1`, [sharedId]) === 2,
    'shared account has 2 memberships before delete');

  const del = await runDelete({ orgIds: [], userIds: [sharedId!], cascadeOrphans: false, dryRun: false });
  ok(del.rootsLeft.users === 0, 'runDelete reports the user root removed');
  ok(await count(`SELECT count(*)::int n FROM "User" WHERE id=$1`, [sharedId]) === 0, 'shared User row is gone');
  ok(await count(`SELECT count(*)::int n FROM "UserOrganization" WHERE "userId"=$1`, [sharedId]) === 0,
    'all memberships of the deleted user are gone');
  ok(await count(`SELECT count(*)::int n FROM "Organization" WHERE id=$1`, [wsA.orgId]) === 1, 'workspace Alpha survives');
  ok(await count(`SELECT count(*)::int n FROM "Organization" WHERE id=$1`, [wsB.orgId]) === 1, 'workspace Beta survives');
  ok(!!(await userIdByEmail('ownerA@x.test')), 'owner of Alpha survives');
  ok(!!(await userIdByEmail('ownerB@x.test')), 'owner of Beta survives');

  // cleanup a
  {
    const ids = [await userIdByEmail('ownerA@x.test'), await userIdByEmail('ownerB@x.test')].filter(Boolean) as string[];
    await runDelete({ orgIds: [wsA.orgId, wsB.orgId], userIds: ids, cascadeOrphans: false, dryRun: false });
  }

  // ===================================================== b. last-SA guard ====
  section('b. last-SUPERADMIN guard');
  const wsS = await createWorkspaceWithOwner({ workspaceName: 'Solo SA', ownerEmail: 'sa@x.test', ownerName: 'SA' });
  const saId = (await userIdByEmail('sa@x.test'))!;

  await expectThrows(() => changeRole(wsS.orgId, saId, 'USER'), LastSuperadminError,
    'changeRole(SUPERADMIN->USER) on the only SA throws LastSuperadminError');
  // still SUPERADMIN (transaction rolled back)
  ok(await count(`SELECT count(*)::int n FROM "UserOrganization" WHERE "organizationId"=$1 AND role='SUPERADMIN'`, [wsS.orgId]) === 1,
    'role unchanged after the blocked demotion');

  await expectThrows(() => removeMember(wsS.orgId, saId), LastSuperadminError,
    'removeMember(only SUPERADMIN) throws LastSuperadminError');
  ok(await count(`SELECT count(*)::int n FROM "UserOrganization" WHERE "organizationId"=$1 AND "userId"=$2`, [wsS.orgId, saId]) === 1,
    'membership still present after blocked removal');

  const overrode = await changeRole(wsS.orgId, saId, 'USER', true);
  ok(overrode.updated, 'changeRole with override=true succeeds (demotes last SA)');
  ok(await count(`SELECT count(*)::int n FROM "UserOrganization" WHERE "organizationId"=$1 AND "userId"=$2 AND role='USER'`, [wsS.orgId, saId]) === 1,
    'override actually wrote role=USER');

  // two-superadmin workspace: demoting one is allowed
  const wsT = await createWorkspaceWithOwner({ workspaceName: 'Two SA', ownerEmail: 'sa1@x.test', ownerName: 'SA1' });
  await addMembersToWorkspace(wsT.orgId, [{ email: 'sa2@x.test', name: 'SA2', role: 'SUPERADMIN' }]);
  const sa1 = (await userIdByEmail('sa1@x.test'))!;
  const demote = await changeRole(wsT.orgId, sa1, 'USER');
  ok(demote.updated, 'demoting one of two SUPERADMINs succeeds (no override needed)');
  ok(await count(`SELECT count(*)::int n FROM "UserOrganization" WHERE "organizationId"=$1 AND role='SUPERADMIN'`, [wsT.orgId]) === 1,
    'one SUPERADMIN remains after the demotion');

  // cleanup b
  {
    const ids = [saId, await userIdByEmail('sa1@x.test'), await userIdByEmail('sa2@x.test')].filter(Boolean) as string[];
    await runDelete({ orgIds: [wsS.orgId, wsT.orgId], userIds: ids, cascadeOrphans: false, dryRun: false });
  }

  // ================================================ c. CSV dry-run + parse ====
  section('c. CSV dry-run classification + RFC-4180 parse');
  // A real workspace to anchor a "reuse + no-op" row, plus an existing member.
  const wsC = await createWorkspaceWithOwner({ workspaceName: 'CsvWs', ownerEmail: 'csvowner@x.test', ownerName: 'CO' });
  await addMembersToWorkspace(wsC.orgId, [{ email: 'existing@x.test', name: 'Ex', role: 'USER' }]);

  const memberRecords: Record<string, string>[] = [
    { email: 'newguy@x.test',   password: 'p', name: 'New Guy', org_id: wsC.orgId, role: 'ADMIN' },       // new-account / add-membership
    { email: 'existing@x.test', password: 'p', name: 'Ex',      org_id: wsC.orgId, role: 'USER' },        // reuse-account / no-op
    { email: 'csvowner@x.test', password: 'p', name: 'CO',      org_id: wsC.orgId, role: 'ADMIN' },       // reuse-account / no-op (already member)
    { email: 'badrole@x.test',  password: 'p', name: 'BR',      org_id: wsC.orgId, role: 'WIZARD' },      // bad role
    { email: 'noorg@x.test',    password: 'p', name: 'NO',      org_id: '00000000-0000-0000-0000-000000000000', role: 'USER' }, // org not found
    { email: 'not-an-email',    password: 'p', name: 'ME',      org_id: wsC.orgId, role: 'USER' },        // malformed email
  ];
  const md = await diffMembers(memberRecords);
  ok(md.valid === false, 'diffMembers reports valid=false when any row is bad');

  const byEmail = (e: string) => md.rows.find((r) => r.email === e.toLowerCase())!;
  // intentionally invalid case: 'not-an-email' is lowercased as-is
  const meRow = md.rows.find((r) => r.email === 'not-an-email')!;

  ok(byEmail('newguy@x.test').accountClass === 'new-account' && byEmail('newguy@x.test').membershipClass === 'add-membership',
    'unseen email -> new-account / add-membership');
  ok(byEmail('existing@x.test').accountClass === 'reuse-account' && byEmail('existing@x.test').membershipClass === 'no-op',
    'existing member -> reuse-account / no-op');
  ok(byEmail('csvowner@x.test').accountClass === 'reuse-account' && byEmail('csvowner@x.test').membershipClass === 'no-op',
    'owner already a member -> reuse-account / no-op (duplicate membership)');
  ok(byEmail('badrole@x.test').errors.some((e) => /invalid role/i.test(e)),
    'bad role flagged with an invalid-role error');
  ok(byEmail('badrole@x.test').accountClass === null && byEmail('badrole@x.test').membershipClass === null,
    'bad-role row is not classified');
  ok(byEmail('noorg@x.test').errors.some((e) => /org_id not found/i.test(e)),
    'non-existent org_id flagged');
  ok(meRow.errors.some((e) => /invalid email/i.test(e)),
    'malformed email flagged');

  // diffWorkspaces: bad email + reuse classification
  const wsRecords: Record<string, string>[] = [
    { workspace_name: 'Fresh',  owner_email: 'freshowner@x.test', owner_password: 'p', owner_name: 'F' }, // new-account
    { workspace_name: 'Reuse',  owner_email: 'csvowner@x.test',   owner_password: 'p', owner_name: 'CO' },// reuse-account
    { workspace_name: '',       owner_email: 'bad email',         owner_password: 'p', owner_name: 'B' }, // 2 errors
  ];
  const wd = await diffWorkspaces(wsRecords);
  ok(wd.valid === false, 'diffWorkspaces valid=false with a bad row');
  ok(wd.rows[0].ownerClass === 'new-account', 'unseen owner email -> new-account');
  ok(wd.rows[1].ownerClass === 'reuse-account', 'existing owner email -> reuse-account');
  ok(wd.rows[2].errors.some((e) => /workspace_name/i.test(e)) && wd.rows[2].errors.some((e) => /owner_email/i.test(e)),
    'empty name + malformed email both flagged');
  ok(wd.rows[2].ownerClass === null, 'invalid workspace row is not classified');

  // RFC-4180 parse: quoted fields with embedded commas and newlines
  const csv = [
    'email,password,name,org_id,role',
    '"a@x.test","p1","Doe, John","org-1","ADMIN"',
    '"b@x.test","p2","Line1' + '\n' + 'Line2","org-2","USER"',
    '"c@x.test","p,3","He said ""hi""","org-3","USER"',
  ].join('\n');
  const parsed = parseCsv(csv);
  ok(parsed.length === 3, 'parseCsv returns 3 data rows (newline inside a quoted field did not split)');
  ok(parsed[0].name === 'Doe, John', 'comma inside quotes preserved');
  ok(parsed[1].name === 'Line1\nLine2', 'newline inside quotes preserved');
  ok(parsed[2].password === 'p,3', 'comma inside quoted password preserved');
  ok(parsed[2].name === 'He said "hi"', 'escaped double-quote ("") unescaped to one quote');

  // cleanup c (orgs + owners + existing member; freshowner/newguy were never executed)
  {
    const ids = [await userIdByEmail('csvowner@x.test'), await userIdByEmail('existing@x.test')].filter(Boolean) as string[];
    await runDelete({ orgIds: [wsC.orgId], userIds: ids, cascadeOrphans: false, dryRun: false });
  }

  // =================================================== d. idempotency ========
  section('d. bulkImportMembers idempotency');
  const wsD = await createWorkspaceWithOwner({ workspaceName: 'IdemWs', ownerEmail: 'idemowner@x.test', ownerName: 'IO' });
  const rows: BulkMemberRow[] = [
    { email: 'i1@x.test', name: 'I1', orgId: wsD.orgId, role: 'USER' },
    { email: 'i2@x.test', name: 'I2', orgId: wsD.orgId, role: 'ADMIN' },
  ];
  const usersBefore = await count(`SELECT count(*)::int n FROM "User"`);
  const first = await bulkImportMembers(rows);
  ok(first.every((r) => r.accountStatus === 'new' && r.membershipStatus === 'added'),
    'first import: both accounts new + memberships added');
  const usersAfterFirst = await count(`SELECT count(*)::int n FROM "User"`);
  const membAfterFirst = await count(`SELECT count(*)::int n FROM "UserOrganization" WHERE "organizationId"=$1`, [wsD.orgId]);
  ok(usersAfterFirst - usersBefore === 2, 'first import created exactly 2 User rows');

  const second = await bulkImportMembers(rows);
  ok(second.every((r) => r.accountStatus === 'reused' && r.membershipStatus === 'exists'),
    'second import: both accounts reused + memberships already exist');
  const usersAfterSecond = await count(`SELECT count(*)::int n FROM "User"`);
  const membAfterSecond = await count(`SELECT count(*)::int n FROM "UserOrganization" WHERE "organizationId"=$1`, [wsD.orgId]);
  ok(usersAfterSecond === usersAfterFirst, 'second import created 0 new accounts');
  ok(membAfterSecond === membAfterFirst, 'second import added 0 memberships');

  // cleanup d
  {
    const ids = [
      await userIdByEmail('idemowner@x.test'),
      await userIdByEmail('i1@x.test'),
      await userIdByEmail('i2@x.test'),
    ].filter(Boolean) as string[];
    await runDelete({ orgIds: [wsD.orgId], userIds: ids, cascadeOrphans: false, dryRun: false });
  }

  // =============================================== e. duplicate names ========
  section('e. duplicate workspace names allowed + flagged');
  const dup1 = await createWorkspaceWithOwner({ workspaceName: 'Acme Inc', ownerEmail: 'dup1@x.test', ownerName: 'D1' });
  const dup2 = await createWorkspaceWithOwner({ workspaceName: 'Acme Inc', ownerEmail: 'dup2@x.test', ownerName: 'D2' });
  ok(dup1.orgId !== dup2.orgId, 'two workspaces with the SAME name got distinct ids');
  ok(await count(`SELECT count(*)::int n FROM "Organization" WHERE name='Acme Inc'`) === 2,
    'both same-named workspaces exist in the DB');

  const health = await healthChecks();
  const flagged = health.duplicateNames.find((d) => d.name === 'Acme Inc');
  ok(!!flagged && flagged.copies === 2, 'health.duplicateNames flags the name with copies=2');
  ok(!!flagged && flagged.ids.includes(dup1.orgId) && flagged.ids.includes(dup2.orgId),
    'duplicateNames lists both org ids');

  const wsList = await listWorkspaces();
  ok(wsList.filter((w) => w.name === 'Acme Inc').every((w) => w.duplicateName === true),
    'listWorkspaces marks duplicateName=true on both rows');

  // cleanup e
  {
    const ids = [await userIdByEmail('dup1@x.test'), await userIdByEmail('dup2@x.test')].filter(Boolean) as string[];
    await runDelete({ orgIds: [dup1.orgId, dup2.orgId], userIds: ids, cascadeOrphans: false, dryRun: false });
  }

  // final sanity: DB clean
  section('final: health is clean after all cleanups');
  const finalHealth = await healthChecks();
  ok(finalHealth.noSuperadmin.length === 0, 'no workspace without SUPERADMIN remains');
  ok(finalHealth.orphanAccounts.length === 0, 'no orphan accounts remain');
  ok(finalHealth.duplicateNames.length === 0, 'no duplicate names remain');
  ok(finalHealth.sharedAccounts.length === 0, 'no shared accounts remain');

  console.log(`\n──────────\n${pass} passed, ${fail} failed`);
  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
