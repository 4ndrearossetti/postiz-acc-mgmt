// Auto-backup before any destructive op (SPEC Sec 5 / Appendix B.1).
//
// Runs pg_dump over the Postgres protocol (no docker socket needed) to a
// timestamped file. A delete MUST refuse to proceed unless this produces a
// non-empty dump.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from './config';

export interface BackupResult {
  file: string;
  bytes: number;
}

function stamp(): string {
  // YYYY-MM-DD-HHMMSS in UTC, no separators that break filenames.
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export async function backup(cfg: Config): Promise<BackupResult> {
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  const file = path.join(cfg.backupDir, `postiz-backup-${stamp()}.sql`);
  const out = fs.createWriteStream(file);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('pg_dump', ['--no-owner', '--no-privileges'], {
      env: {
        ...process.env,
        PGHOST: cfg.pg.host,
        PGPORT: String(cfg.pg.port),
        PGDATABASE: cfg.pg.database,
        PGUSER: cfg.pg.user,
        PGPASSWORD: cfg.pg.password,
      },
    });
    let stderr = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      out.end();
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });

  const bytes = fs.statSync(file).size;
  if (bytes === 0) {
    throw new Error('Backup produced an empty file; refusing to proceed with delete.');
  }
  return { file, bytes };
}
