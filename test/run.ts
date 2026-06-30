/* Test runner: FK-walker unit checks + end-to-end smoke test (SPEC Sec 8).
 * Runs against the throwaway Postgres from scripts/test-db.sh — never live.
 *
 *   npm run test:db:up && npm test
 */
import * as path from 'path';

// ── point the app at the throwaway DB BEFORE importing app modules ───────────
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
import { loadForeignKeys, buildDeletePlan } from '../src/fkwalker';
import { createWorkspaceWithOwner, addMembersToWorkspace } from '../src/creation';
import { healthChecks, listWorkspaces, listAccounts } from '../src/health';
import { runDelete } from '../src/deleteEngine';
import { backup } from '../src/backup';
import { generatePassword, hashPassword, verifyPassword } from '../src/hash';
import * as fs from 'fs';

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}
function eq(a: unknown, b: unknown, msg: string) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }
function section(t: string) { console.log(`\n# ${t}`); }

async function main() {
  const cfg = loadConfig();
  initPool(cfg);
  initAudit(cfg);
  const pool = getPool();

  // ── hashing ────────────────────────────────────────────────────────────────
  section('hashing matches Postiz ($2b$10$)');
  const h = hashPassword('hunter2');
  ok(/^\$2b\$10\$/.test(h), 'emits $2b$10$ prefix');
  ok(verifyPassword('hunter2', h), 'verifies its own hash');
  ok(!verifyPassword('wrong', h), 'rejects wrong password');
  const pw = generatePassword(20);
  ok(pw.length === 20 && /^[A-Za-z0-9]+$/.test(pw), 'generates 20-char alphanumeric password');

  // ── FK walker ───────────────────────────────────────────────────────────────
  section('FK walker produces a valid children-first order');
  const client = await pool.connect();
  let plan;
  try {
    const edges = await loadForeignKeys(client);
    plan = buildDeletePlan(edges);
  } finally { client.release(); }
  const idx = (t: string) => plan!.order.indexOf(t);

  // Every non-broken, non-self FK edge must put child before parent.
  const broken = new Set(plan.brokenEdges.map((b) => `${b.table}.${b.column}`));
  const client2 = await pool.connect();
  let edges2;
  try { edges2 = await loadForeignKeys(client2); } finally { client2.release(); }
  let violations = 0;
  for (const e of edges2) {
    if (e.childTable === e.parentTable) continue;            // self-ref exempt
    if (broken.has(`${e.childTable}.${e.childCols[0]}`)) continue; // cycle-break exempt
    if (idx(e.childTable) < 0 || idx(e.parentTable) < 0) continue;
    if (idx(e.childTable) >= idx(e.parentTable)) { violations++; console.error(`     bad order: ${e.childTable} after ${e.parentTable}`); }
  }
  ok(violations === 0, 'no child-after-parent ordering violations');
  ok(plan.brokenEdges.length >= 1, 'detected & broke the Orders<->MessagesGroup cycle');

  // Consistency with the known-good upstream order (Appendix B.4).
  ok(idx('UserOrganization') < idx('Organization') && idx('UserOrganization') < idx('User'), 'UserOrganization before Organization & User');
  ok(idx('Integration') < idx('Organization'), 'Integration before Organization');
  ok(idx('IntegrationsWebhooks') < idx('Integration'), 'IntegrationsWebhooks before Integration');
  ok(idx('TagsPosts') < idx('Post') && idx('TagsPosts') < idx('Tags'), 'TagsPosts before Post & Tags');
  ok(idx('Post') < idx('Organization'), 'Post before Organization');
  ok(idx('Messages') < idx('MessagesGroup'), 'Messages before MessagesGroup');
  const lastTwo = plan.order.slice(-2);
  ok(lastTwo.includes('Organization') && lastTwo.includes('User'), 'Organization & User deleted last');

  // ── creation ────────────────────────────────────────────────────────────────
  section('creation: workspace + owner + members');
  const ws = await createWorkspaceWithOwner({ workspaceName: 'Acme', ownerEmail: 'owner@acme.test', ownerName: 'Owner' });
  ok(!!ws.orgId && ws.accountStatus === 'new' && !!ws.password, 'created workspace with new owner + generated password');
  const members = await addMembersToWorkspace(ws.orgId, [
    { email: 'a@acme.test', name: 'A', role: 'ADMIN' },
    { email: 'b@acme.test', name: 'B', role: 'USER' },
    { email: 'owner@acme.test', name: 'Owner', role: 'USER' }, // existing account → reuse, no-op membership? different role
  ]);
  ok(members.find((m) => m.email === 'a@acme.test')?.accountStatus === 'new', 'new member account created');
  ok(members.find((m) => m.email === 'owner@acme.test')?.accountStatus === 'reused', 'existing owner reused, not recreated');
  ok(members.find((m) => m.email === 'owner@acme.test')?.membershipStatus === 'exists', 'owner membership already existed (idempotent)');

  // idempotency: re-adding the same members changes nothing.
  const again = await addMembersToWorkspace(ws.orgId, [{ email: 'a@acme.test', name: 'A', role: 'ADMIN' }]);
  ok(again[0].membershipStatus === 'exists' && again[0].accountStatus === 'reused', 're-import is a no-op (idempotent)');

  // Seed some child rows so the delete walker has real work (channels/posts/cycle).
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO "Integration"(id,"organizationId",name) VALUES (gen_random_uuid(),$1,'tw')`, [ws.orgId]);
    await c.query(`INSERT INTO "Post"(id,"organizationId",content) VALUES ('p1',$1,'hi')`, [ws.orgId]);
    await c.query(`INSERT INTO "Post"(id,"organizationId","parentPostId",content) VALUES ('p2',$1,'p1','reply')`, [ws.orgId]);
    await c.query(`INSERT INTO "Tags"(id,"orgId",name) VALUES ('t1',$1,'x')`, [ws.orgId]);
    await c.query(`INSERT INTO "TagsPosts"(id,"postId","tagId") VALUES (gen_random_uuid(),'p1','t1')`);
    await c.query(`INSERT INTO "Comments"(id,"organizationId","postId") VALUES (gen_random_uuid(),$1,'p1')`, [ws.orgId]);
    await c.query(`INSERT INTO "Media"(id,"organizationId") VALUES (gen_random_uuid(),$1)`, [ws.orgId]);
    await c.query(`INSERT INTO "Customer"(id,"orgId") VALUES (gen_random_uuid(),$1)`, [ws.orgId]);
    // cycle rows
    await c.query(`INSERT INTO "MessagesGroup"(id,"buyerOrganizationId") VALUES ('g1',$1)`, [ws.orgId]);
    await c.query(`INSERT INTO "Orders"(id,"buyerId","messageGroupId") VALUES ('o1',NULL,'g1')`);
    await c.query(`UPDATE "MessagesGroup" SET "orderId"='o1' WHERE id='g1'`);
    await c.query(`INSERT INTO "Messages"(id,"groupId") VALUES (gen_random_uuid(),'g1')`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

  section('health checks before delete');
  let health = await healthChecks();
  ok(health.noSuperadmin.length === 0, 'no workspace lacks a SUPERADMIN');
  ok(health.orphanAccounts.length === 0, 'no orphaned accounts yet');
  const wsList = await listWorkspaces();
  ok(wsList.find((w) => w.id === ws.orgId)?.channels === 1, 'workspace shows 1 channel');
  ok((wsList.find((w) => w.id === ws.orgId)?.posts || 0) === 2, 'workspace shows 2 posts');

  // ── dry run ─────────────────────────────────────────────────────────────────
  section('dry-run delete leaves the database untouched');
  const accts = await listAccounts();
  const userIds = accts.map((a) => a.id);
  const dry = await runDelete({ orgIds: [ws.orgId], userIds, cascadeOrphans: false, dryRun: true });
  ok(dry.totalRows > 0, `dry-run predicts ${dry.totalRows} row deletions`);
  const stillThere = await pool.query(`SELECT count(*)::int n FROM "Organization" WHERE id=$1`, [ws.orgId]);
  ok(stillThere.rows[0].n === 1, 'workspace still present after dry-run (rolled back)');
  const postsStill = await pool.query(`SELECT count(*)::int n FROM "Post"`);
  ok(postsStill.rows[0].n === 2, 'posts still present after dry-run');

  // ── real delete + backup ─────────────────────────────────────────────────────
  section('backup + real delete, then health is clean');
  const bkp = await backup(cfg);
  ok(fs.existsSync(bkp.file) && bkp.bytes > 0, `backup written (${bkp.bytes} bytes)`);
  const real = await runDelete({ orgIds: [ws.orgId], userIds, cascadeOrphans: false, dryRun: false });
  ok(real.rootsLeft.orgs === 0 && real.rootsLeft.users === 0, 'roots fully removed');
  for (const t of ['Organization', 'User', 'UserOrganization', 'Post', 'Integration', 'Orders', 'MessagesGroup', 'Messages', 'TagsPosts', 'Comments']) {
    const r = await pool.query(`SELECT count(*)::int n FROM "${t}"`);
    eq(r.rows[0].n, 0, `${t} is empty after delete`);
  }
  health = await healthChecks();
  ok(health.noSuperadmin.length === 0 && health.orphanAccounts.length === 0 && health.duplicateNames.length === 0 && health.sharedAccounts.length === 0,
    'all 4 health checks clean after delete');

  // ── orphan cascade path ───────────────────────────────────────────────────────
  section('workspace delete with cascade removes sole-membership accounts');
  const ws2 = await createWorkspaceWithOwner({ workspaceName: 'Solo', ownerEmail: 'solo@x.test', ownerName: 'Solo' });
  await addMembersToWorkspace(ws2.orgId, [{ email: 'shared@x.test', name: 'S', role: 'USER' }]);
  const ws3 = await createWorkspaceWithOwner({ workspaceName: 'Other', ownerEmail: 'other@x.test', ownerName: 'Other' });
  await addMembersToWorkspace(ws3.orgId, [{ email: 'shared@x.test', name: 'S', role: 'USER' }]); // shared across ws2+ws3
  const casc = await runDelete({ orgIds: [ws2.orgId], userIds: [], cascadeOrphans: true, dryRun: false });
  const soloGone = await pool.query(`SELECT count(*)::int n FROM "User" WHERE email='solo@x.test'`);
  const sharedKept = await pool.query(`SELECT count(*)::int n FROM "User" WHERE email='shared@x.test'`);
  ok(soloGone.rows[0].n === 0, 'sole-membership owner cascade-deleted');
  ok(sharedKept.rows[0].n === 1, 'shared account NEVER cascade-deleted');
  ok(casc.cascadedUserIds.length === 1, 'exactly one account cascaded');

  // cleanup ws3
  const a3 = await listAccounts();
  await runDelete({ orgIds: [ws3.orgId], userIds: a3.map((a) => a.id), cascadeOrphans: false, dryRun: false });

  console.log(`\n──────────\n${pass} passed, ${fail} failed`);
  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
