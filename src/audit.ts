// Append-only audit log (JSONL). One line per admin action.
//
// SECURITY: never write plaintext passwords or bcrypt hashes here. Any SQL we
// record is scrubbed by redactSql() before it lands on disk.
import * as fs from 'fs';
import { Config } from './config';

let logPath = '';

export function initAudit(cfg: Config) {
  logPath = cfg.auditLog;
}

export interface AuditEntry {
  admin: string;
  action: string;
  targets?: Record<string, unknown>;
  rowCounts?: Record<string, number>;
  sql?: string;
  ok: boolean;
  error?: string;
}

// Remove bcrypt hashes and obvious password literals from SQL/text.
export function redactSql(sql: string): string {
  return sql
    // bcrypt hashes: $2a$/$2b$/$2y$ + cost + 53 chars
    .replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, '<bcrypt-redacted>')
    // password='...' or "password" = '...'
    .replace(/("?password"?\s*[=:]\s*)'[^']*'/gi, "$1'<redacted>'");
}

export function audit(entry: AuditEntry): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
    sql: entry.sql ? redactSql(entry.sql) : undefined,
  });
  try {
    fs.appendFileSync(logPath, line + '\n');
  } catch (e) {
    // Never let an audit-write failure crash a request, but make it loud.
    // eslint-disable-next-line no-console
    console.error('AUDIT WRITE FAILED:', (e as Error).message, line);
  }
}

export function readAudit(limit = 200): unknown[] {
  try {
    const raw = fs.readFileSync(logPath, 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  } catch {
    return [];
  }
}
