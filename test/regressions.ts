/* Regression tests for the issues found in multi-agent review.
 * Run on a fresh DB:  bash scripts/test-db.sh up && npx ts-node test/regressions.ts
 */
import * as path from 'path';
process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGDATABASE = process.env.PGDATABASE || 'postiz_test';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'postgres';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'pw';
process.env.SESSION_SECRET = 'z'.repeat(40);
process.env.AUDIT_LOG = path.join(__dirname, '.tmp', 'audit.jsonl');
process.env.BACKUP_DIR = path.join(__dirname, '.tmp', 'backups');

import { loadConfig } from '../src/config';
import { initPool, getPool } from '../src/db';
import { initAudit } from '../src/audit';
import { createWorkspaceWithOwner, addMembersToWorkspace, removeMember } from '../src/creation';
import { deleteTargetLabels, labelsMatch, listAccounts } from '../src/health';
import { runDelete } from '../src/deleteEngine';

let pass = 0, fail = 0;
function ok(c: boolean, m: string) { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.error(`  ✗ ${m}`)); }
function sec(t: string) { console.log(`\n# ${t}`); }

async function main() {
  const cfg = loadConfig(); initPool(cfg); initAudit(cfg);
  const pool = getPool();

  // ── #1/#2 confirmation gate: empty shells, duplicate names, commas ──────────
  sec('confirmation labels (empty-shell, duplicate names, commas)');
  // empty-shell workspace: create then strip its only member.
  const shell = await createWorkspaceWithOwner({ workspaceName: 'Empty Shell', ownerEmail: 'o1@x.test', ownerName: 'O1' });
  const shellAcct = (await listAccounts()).find((a) => a.email === 'o1@x.test')!;
  await removeMember(shell.orgId, shellAcct.id, true); // override last-SA → 0 members
  const shellLabels = await deleteTargetLabels([shell.orgId], []);
  ok(JSON.stringify(shellLabels) === JSON.stringify(['Empty Shell']), 'empty-shell workspace yields a confirmable label');
  ok(labelsMatch(shellLabels, ['Empty Shell']), 'empty-shell confirmation matches');

  // duplicate names must each be typed.
  const dupA = await createWorkspaceWithOwner({ workspaceName: 'Acme', ownerEmail: 'da@x.test', ownerName: 'DA' });
  const dupB = await createWorkspaceWithOwner({ workspaceName: 'Acme', ownerEmail: 'db@x.test', ownerName: 'DB' });
  const dupLabels = await deleteTargetLabels([dupA.orgId, dupB.orgId], []);
  ok(dupLabels.length === 2, 'two same-named workspaces yield two labels (not collapsed)');
  ok(!labelsMatch(dupLabels, ['Acme']), 'typing the name once does NOT confirm both');
  ok(labelsMatch(dupLabels, ['Acme', 'Acme']), 'typing the name twice confirms both');

  // comma in name survives (no naive comma split).
  const comma = await createWorkspaceWithOwner({ workspaceName: 'Acme, Inc.', ownerEmail: 'ci@x.test', ownerName: 'CI' });
  const commaLabels = await deleteTargetLabels([comma.orgId], []);
  ok(labelsMatch(commaLabels, ['Acme, Inc.']), 'comma-containing name confirms correctly');

  // ── #3 orphan cascade across MULTIPLE deleted orgs ──────────────────────────
  sec('orphan cascade catches a user whose memberships are all in the deleted set');
  const A = await createWorkspaceWithOwner({ workspaceName: 'A', ownerEmail: 'ownA@x.test', ownerName: 'OA' });
  const B = await createWorkspaceWithOwner({ workspaceName: 'B', ownerEmail: 'ownB@x.test', ownerName: 'OB' });
  const C = await createWorkspaceWithOwner({ workspaceName: 'C', ownerEmail: 'ownC@x.test', ownerName: 'OC' });
  // multi belongs to A and B only (both deleted); keep belongs to A and C (C survives).
  await addMembersToWorkspace(A.orgId, [{ email: 'multi@x.test', name: 'M', role: 'USER' }, { email: 'keep@x.test', name: 'K', role: 'USER' }]);
  await addMembersToWorkspace(B.orgId, [{ email: 'multi@x.test', name: 'M', role: 'USER' }]);
  await addMembersToWorkspace(C.orgId, [{ email: 'keep@x.test', name: 'K', role: 'USER' }]);
  const res = await runDelete({ orgIds: [A.orgId, B.orgId], userIds: [], cascadeOrphans: true, dryRun: false });
  const multiGone = (await pool.query(`SELECT count(*)::int n FROM "User" WHERE email='multi@x.test'`)).rows[0].n === 0;
  const keepAlive = (await pool.query(`SELECT count(*)::int n FROM "User" WHERE email='keep@x.test'`)).rows[0].n === 1;
  ok(multiGone, 'user in only-deleted orgs A+B is cascade-deleted (naive count=1 test would have missed them)');
  ok(keepAlive, 'user who also belongs to surviving C is NOT cascaded');
  ok(res.cascadedUserIds.length >= 1, 'cascade reported');

  // ── #7 self-ref across scope boundary does not RESTRICT-fail ─────────────────
  sec('cross-scope self-reference (Post.parentPostId) is NULL-broken, kept post survives');
  const D = await createWorkspaceWithOwner({ workspaceName: 'Del', ownerEmail: 'd@x.test', ownerName: 'D' });
  const K = await createWorkspaceWithOwner({ workspaceName: 'Keep', ownerEmail: 'k2@x.test', ownerName: 'K2' });
  await pool.query(`INSERT INTO "Post"(id,"organizationId",content) VALUES ('pdel',$1,'x')`, [D.orgId]);
  await pool.query(`INSERT INTO "Post"(id,"organizationId","parentPostId",content) VALUES ('pkeep',$1,'pdel','x')`, [K.orgId]);
  const delAccts = (await listAccounts()).filter((a) => a.email === 'd@x.test').map((a) => a.id);
  await runDelete({ orgIds: [D.orgId], userIds: delAccts, cascadeOrphans: false, dryRun: false });
  const delGone = (await pool.query(`SELECT count(*)::int n FROM "Post" WHERE id='pdel'`)).rows[0].n === 0;
  const keepRow = (await pool.query(`SELECT "parentPostId" pp FROM "Post" WHERE id='pkeep'`)).rows;
  ok(delGone, 'in-scope post deleted');
  ok(keepRow.length === 1 && keepRow[0].pp === null, 'kept post survives with parentPostId NULL-ed (no RESTRICT failure)');

  console.log(`\n──────────\n${pass} passed, ${fail} failed`);
  await pool.end();
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
