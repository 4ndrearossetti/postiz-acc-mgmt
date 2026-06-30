// Catalog-driven delete planner (SPEC Sec 6).
//
// Reads the live FK graph from the Postgres catalog, restricts it to every
// table that transitively references "Organization" or "User", topologically
// sorts it children-first, and emits scoped DELETE statements. Handles cycles
// (e.g. Orders <-> MessagesGroup) and self-references (Post.parentPostId).
//
// Identifiers come from the catalog and are quoted with quoteIdent(); target
// ids are ALWAYS bound parameters fed through the org_del / user_del temp
// tables — never interpolated.
import { PoolClient } from 'pg';
import { quoteIdent } from './db';

export const ROOT_ORG = 'Organization';
export const ROOT_USER = 'User';

export interface FkEdge {
  constraint: string;
  childTable: string;
  parentTable: string;
  childCols: string[];
  parentCols: string[];
  childColNullable: boolean; // true if the (first) child column is nullable
}

export interface PlanStep {
  kind: 'update-null' | 'delete';
  table: string;
  column?: string; // for update-null
  sql: string;
}

export interface DeletePlan {
  order: string[]; // table delete order (children-first), roots last
  steps: PlanStep[]; // update-null steps (cycle breaks) then deletes, in run order
  brokenEdges: { table: string; column: string }[];
  subgraph: string[];
}

// ── 1. Read FK edges from the live catalog ──────────────────────────────────
export async function loadForeignKeys(client: PoolClient, schema = 'public'): Promise<FkEdge[]> {
  const { rows } = await client.query(
    `SELECT con.conname               AS constraint,
            c.relname                 AS child_table,
            p.relname                 AS parent_table,
            att_c.attname             AS child_col,
            att_p.attname             AS parent_col,
            ck.ord                    AS ord,
            (col.is_nullable = 'YES') AS child_nullable
       FROM pg_constraint con
       JOIN pg_class c       ON c.oid = con.conrelid
       JOIN pg_class p       ON p.oid = con.confrelid
       JOIN pg_namespace n   ON n.oid = c.relnamespace
       JOIN unnest(con.conkey)  WITH ORDINALITY AS ck(attnum, ord)   ON true
       JOIN unnest(con.confkey) WITH ORDINALITY AS cfk(attnum, ord2) ON ck.ord = cfk.ord2
       JOIN pg_attribute att_c ON att_c.attrelid = con.conrelid AND att_c.attnum = ck.attnum
       JOIN pg_attribute att_p ON att_p.attrelid = con.confrelid AND att_p.attnum = cfk.attnum
       JOIN information_schema.columns col
             ON col.table_schema = n.nspname
            AND col.table_name   = c.relname
            AND col.column_name  = att_c.attname
      WHERE con.contype = 'f' AND n.nspname = $1
      ORDER BY con.conname, ck.ord`,
    [schema],
  );

  const byCon = new Map<string, FkEdge>();
  for (const r of rows) {
    let e = byCon.get(r.constraint);
    if (!e) {
      e = {
        constraint: r.constraint,
        childTable: r.child_table,
        parentTable: r.parent_table,
        childCols: [],
        parentCols: [],
        childColNullable: r.child_nullable,
      };
      byCon.set(r.constraint, e);
    }
    e.childCols.push(r.child_col);
    e.parentCols.push(r.parent_col);
  }
  return [...byCon.values()];
}

// ── 2. Build a children-first delete plan (pure; unit-testable) ─────────────
export function buildDeletePlan(edges: FkEdge[]): DeletePlan {
  // Index edges by child table (ignore self-references for ordering/scoping;
  // a single scoped DELETE removes self-parent+child rows together).
  const realEdges = edges.filter((e) => e.childTable !== e.parentTable);

  // 2a. Subgraph: every table transitively referencing a root.
  const roots = new Set([ROOT_ORG, ROOT_USER]);
  const subgraph = new Set<string>(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of realEdges) {
      if (subgraph.has(e.parentTable) && !subgraph.has(e.childTable)) {
        subgraph.add(e.childTable);
        changed = true;
      }
    }
  }

  // Edges within the subgraph only.
  const allSubEdges = realEdges.filter((e) => subgraph.has(e.childTable) && subgraph.has(e.parentTable));
  const nodes = [...subgraph];

  // 2b. Break cycles. An edge child->parent lies on a cycle iff `parent` can
  // reach `child` again by following child->parent edges. We break ONLY such
  // genuine cyclic edges (e.g. Orders<->MessagesGroup) and only when the child
  // column is nullable — never the org/user scoping edges. The broken edge's
  // rows are NULL-ed (in scope) so the parent delete isn't RESTRICT-blocked.
  const broken = new Set<string>();
  const brokenEdges: { table: string; column: string }[] = [];

  const active = () => allSubEdges.filter((e) => !broken.has(e.constraint));

  function reaches(from: string, to: string): boolean {
    const adj = new Map<string, string[]>();
    for (const e of active()) (adj.get(e.childTable) || adj.set(e.childTable, []).get(e.childTable)!).push(e.parentTable);
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const p of adj.get(n) || []) stack.push(p);
    }
    return false;
  }

  function hasCycle(): boolean {
    const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
    for (const e of active()) indeg.set(e.parentTable, (indeg.get(e.parentTable) || 0) + 1);
    const q = nodes.filter((n) => (indeg.get(n) || 0) === 0);
    let seen = 0;
    const adj = new Map<string, FkEdge[]>();
    for (const e of active()) (adj.get(e.childTable) || adj.set(e.childTable, []).get(e.childTable)!).push(e);
    while (q.length) {
      const n = q.shift()!;
      seen++;
      for (const e of adj.get(n) || []) {
        const d = (indeg.get(e.parentTable) || 0) - 1;
        indeg.set(e.parentTable, d);
        if (d === 0) q.push(e.parentTable);
      }
    }
    return seen < nodes.length;
  }

  while (hasCycle()) {
    const e = active().find((x) => x.childColNullable && reaches(x.parentTable, x.childTable));
    if (!e) {
      throw new Error('Unbreakable FK cycle (no nullable edge to defer).');
    }
    broken.add(e.constraint);
    brokenEdges.push({ table: e.childTable, column: e.childCols[0] });
  }

  // 2c. Predicate per table over the now-acyclic edge set.
  const subEdges = active();
  const predCache = new Map<string, string>();
  function predicate(table: string, stack: Set<string> = new Set()): string {
    if (table === ROOT_ORG) return `${quoteIdent('id')} IN (SELECT id FROM org_del)`;
    if (table === ROOT_USER) return `${quoteIdent('id')} IN (SELECT id FROM user_del)`;
    if (predCache.has(table)) return predCache.get(table)!;
    const terms: string[] = [];
    for (const e of subEdges.filter((x) => x.childTable === table)) {
      const col = quoteIdent(e.childCols[0]);
      if (e.parentTable === ROOT_ORG) {
        terms.push(`${col} IN (SELECT id FROM org_del)`);
      } else if (e.parentTable === ROOT_USER) {
        terms.push(`${col} IN (SELECT id FROM user_del)`);
      } else if (!stack.has(e.parentTable)) {
        const pcol = quoteIdent(e.parentCols[0]);
        const inner = predicate(e.parentTable, new Set(stack).add(table));
        terms.push(`${col} IN (SELECT ${pcol} FROM ${quoteIdent(e.parentTable)} WHERE ${inner})`);
      }
    }
    const pred = terms.length ? `(${terms.join(' OR ')})` : 'false';
    predCache.set(table, pred);
    return pred;
  }

  // 2d. Kahn topological sort over the acyclic graph, children-first.
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  const outEdges = new Map<string, FkEdge[]>(nodes.map((n) => [n, []]));
  for (const e of subEdges) {
    indeg.set(e.parentTable, (indeg.get(e.parentTable) || 0) + 1);
    outEdges.get(e.childTable)!.push(e);
  }
  const order: string[] = [];
  const ready = nodes.filter((n) => (indeg.get(n) || 0) === 0);
  while (ready.length) {
    const node = ready.shift()!;
    order.push(node);
    for (const e of outEdges.get(node) || []) {
      const d = (indeg.get(e.parentTable) || 0) - 1;
      indeg.set(e.parentTable, d);
      if (d === 0) ready.push(e.parentTable);
    }
  }
  if (order.length !== nodes.length) {
    throw new Error(`Topological sort failed; unresolved: ${nodes.filter((n) => !order.includes(n)).join(', ')}`);
  }

  // 2e. Emit steps: NULL-break updates first, then children-first deletes.
  const steps: PlanStep[] = [];
  for (const b of brokenEdges) {
    steps.push({
      kind: 'update-null',
      table: b.table,
      column: b.column,
      sql: `UPDATE ${quoteIdent(b.table)} SET ${quoteIdent(b.column)} = NULL WHERE ${predicate(b.table)} AND ${quoteIdent(b.column)} IS NOT NULL`,
    });
  }
  for (const table of order) {
    steps.push({ kind: 'delete', table, sql: `DELETE FROM ${quoteIdent(table)} WHERE ${predicate(table)}` });
  }

  return { order, steps, brokenEdges, subgraph: nodes };
}
