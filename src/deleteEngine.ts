// Executes a catalog-derived delete plan inside one transaction (SPEC Sec 5/6).
//
// Flow per call: build plan -> (optionally) compute orphan cascade -> BEGIN ->
// load target ids into org_del/user_del temp tables -> run NULL-break updates
// -> run children-first deletes -> verify roots are gone -> COMMIT (or ROLLBACK
// for a dry run). Backup is the caller's responsibility (routes do it first).
import { PoolClient } from 'pg';
import { getPool } from './db';
import { buildDeletePlan, loadForeignKeys, DeletePlan } from './fkwalker';

export interface DeleteRequest {
  orgIds: string[];
  userIds: string[];
  cascadeOrphans: boolean; // workspace-delete orphan toggle (SPEC Sec 7)
  dryRun: boolean;
}

export interface StepCount {
  kind: string;
  table: string;
  column?: string;
  rows: number;
  sql: string;
}

export interface DeleteResult {
  dryRun: boolean;
  orgIds: string[];
  userIds: string[]; // includes any cascaded orphans
  cascadedUserIds: string[];
  steps: StepCount[];
  totalRows: number;
  rootsLeft: { orgs: number; users: number };
}

// Accounts whose SOLE membership is in one of orgIds (never shared accounts).
export async function computeOrphanCascade(
  client: PoolClient,
  orgIds: string[],
): Promise<string[]> {
  if (orgIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT DISTINCT uo."userId" AS id
       FROM "UserOrganization" uo
      WHERE uo."organizationId" = ANY($1::text[])
        AND (SELECT count(*) FROM "UserOrganization" x WHERE x."userId" = uo."userId") = 1`,
    [orgIds],
  );
  return rows.map((r) => r.id);
}

export async function runDelete(req: DeleteRequest): Promise<DeleteResult> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    let userIds = [...new Set(req.userIds)];
    let cascadedUserIds: string[] = [];
    if (req.cascadeOrphans && req.orgIds.length) {
      cascadedUserIds = await computeOrphanCascade(client, req.orgIds);
      const before = new Set(userIds);
      cascadedUserIds = cascadedUserIds.filter((id) => !before.has(id));
      userIds = [...userIds, ...cascadedUserIds];
    }

    const edges = await loadForeignKeys(client);
    const plan: DeletePlan = buildDeletePlan(edges);

    await client.query('CREATE TEMP TABLE org_del(id text) ON COMMIT DROP');
    await client.query('CREATE TEMP TABLE user_del(id text) ON COMMIT DROP');
    await client.query('INSERT INTO org_del SELECT unnest($1::text[])', [req.orgIds]);
    await client.query('INSERT INTO user_del SELECT unnest($1::text[])', [userIds]);

    const steps: StepCount[] = [];
    let totalRows = 0;
    for (const step of plan.steps) {
      const res = await client.query(step.sql);
      const rows = res.rowCount || 0;
      if (step.kind === 'delete') totalRows += rows;
      steps.push({ kind: step.kind, table: step.table, column: step.column, rows, sql: step.sql });
    }

    // Verify both roots are gone within scope.
    const verify = await client.query(
      `SELECT (SELECT count(*) FROM "Organization" WHERE id IN (SELECT id FROM org_del))  AS orgs,
              (SELECT count(*) FROM "User"         WHERE id IN (SELECT id FROM user_del)) AS users`,
    );
    const rootsLeft = {
      orgs: parseInt(verify.rows[0].orgs, 10),
      users: parseInt(verify.rows[0].users, 10),
    };
    if (!req.dryRun && (rootsLeft.orgs !== 0 || rootsLeft.users !== 0)) {
      throw new Error(
        `Post-delete verification failed: ${rootsLeft.orgs} orgs / ${rootsLeft.users} users still present.`,
      );
    }

    if (req.dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    return {
      dryRun: req.dryRun,
      orgIds: req.orgIds,
      userIds,
      cascadedUserIds,
      steps,
      totalRows,
      rootsLeft,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
