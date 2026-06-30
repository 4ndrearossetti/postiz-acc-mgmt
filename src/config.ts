// Centralised, env-only configuration. Nothing is hardcoded.
import * as fs from 'fs';
import * as path from 'path';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export interface Config {
  pg: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    max: number;
  };
  admin: {
    username: string;
    passwordHash?: string;
    password?: string;
  };
  sessionSecret: string;
  app: { host: string; port: number };
  auditLog: string;
  backupDir: string;
  orphanPolicy: 'leave' | 'cascade';
  insecureCookies: boolean;
}

export function loadConfig(): Config {
  const orphan = env('ORPHAN_POLICY', 'leave').toLowerCase();
  if (orphan !== 'leave' && orphan !== 'cascade') {
    throw new Error(`ORPHAN_POLICY must be 'leave' or 'cascade', got '${orphan}'`);
  }
  const cfg: Config = {
    pg: {
      host: env('PGHOST'),
      port: parseInt(env('PGPORT', '5432'), 10),
      database: env('PGDATABASE'),
      user: env('PGUSER'),
      password: env('PGPASSWORD'),
      max: parseInt(env('PGPOOLMAX', '5'), 10),
    },
    admin: {
      username: env('ADMIN_USERNAME', 'admin'),
      passwordHash: process.env.ADMIN_PASSWORD_HASH || undefined,
      password: process.env.ADMIN_PASSWORD || undefined,
    },
    sessionSecret: env('SESSION_SECRET'),
    app: {
      host: env('APP_HOST', '0.0.0.0'),
      port: parseInt(env('APP_PORT', '8080'), 10),
    },
    auditLog: env('AUDIT_LOG', path.join(process.cwd(), 'data', 'audit.jsonl')),
    backupDir: env('BACKUP_DIR', path.join(process.cwd(), 'backups')),
    orphanPolicy: orphan as 'leave' | 'cascade',
    insecureCookies: (process.env.INSECURE_COOKIES || 'false').toLowerCase() === 'true',
  };

  if (!cfg.admin.passwordHash && !cfg.admin.password) {
    throw new Error('Set ADMIN_PASSWORD_HASH or ADMIN_PASSWORD for the console login.');
  }
  // Ensure writable dirs exist.
  fs.mkdirSync(path.dirname(cfg.auditLog), { recursive: true });
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  return cfg;
}
