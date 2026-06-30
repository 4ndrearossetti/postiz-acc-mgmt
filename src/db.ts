// Connection pool to the Postiz Postgres database.
//
// SAFETY: every row VALUE goes through bind parameters ($1, $2, ...). The only
// place identifiers are built dynamically is the catalog-driven delete walker
// (src/fkwalker.ts), where table/column names come from the live catalog and
// are quoted with quoteIdent(). Values there are STILL bound parameters.
import { Pool, PoolClient } from 'pg';
import { Config } from './config';

let pool: Pool | null = null;

export function initPool(cfg: Config): Pool {
  pool = new Pool({
    host: cfg.pg.host,
    port: cfg.pg.port,
    database: cfg.pg.database,
    user: cfg.pg.user,
    password: cfg.pg.password,
    max: cfg.pg.max,
    application_name: 'postiz-admin-console',
  });
  return pool;
}

export function getPool(): Pool {
  if (!pool) throw new Error('Pool not initialised; call initPool() first.');
  return pool;
}

// Run a function inside a single transaction; rolls back on any error.
export async function withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// Quote a Postgres identifier safely. Used ONLY for catalog-derived
// identifiers in the delete walker. Postiz table/column names are simple
// word-characters (PascalCase / camelCase); reject anything else so a
// malformed catalog row can never smuggle SQL through this one dynamic path.
export function quoteIdent(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Refusing to quote suspicious identifier: ${JSON.stringify(ident)}`);
  }
  return '"' + ident + '"';
}
