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

// pg_dump (plain format) writes this line when the dump finishes cleanly.
// Its presence near the tail is our proof the dump is complete, not truncated.
const COMPLETE_MARKER = 'PostgreSQL database dump complete';

export async function backup(cfg: Config): Promise<BackupResult> {
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  const file = path.join(cfg.backupDir, `postiz-backup-${stamp()}.sql`);
  const out = fs.createWriteStream(file);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
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
    let dumpExit: number | null = null;
    // A write error (ENOSPC, etc.) MUST fail the backup, not be ignored.
    out.on('error', (e) => done(new Error(`backup write failed: ${e.message}`)));
    child.on('error', done);
    child.stderr.on('data', (d) => (stderr += d.toString()));
    // end:false — we close the stream ourselves in 'close', AFTER the exit code
    // is known, so 'finish' never races ahead of it.
    child.stdout.pipe(out, { end: false });
    child.on('close', (code) => {
      dumpExit = code;
      out.end(); // 'finish' fires once the file is fully flushed to disk
    });
    out.on('finish', () => {
      if (dumpExit === 0) done();
      else done(new Error(`pg_dump exited ${dumpExit}: ${stderr.slice(0, 500)}`));
    });
  });

  const bytes = fs.statSync(file).size;
  if (bytes === 0) {
    throw new Error('Backup produced an empty file; refusing to proceed with delete.');
  }
  // Confirm the dump actually ran to completion (guards against a truncated
  // file that still exited 0). Read the tail and look for pg_dump's marker.
  const tail = readTail(file, 4096);
  if (!tail.includes(COMPLETE_MARKER)) {
    throw new Error('Backup is missing the pg_dump completion marker (possibly truncated); refusing to proceed.');
  }
  return { file, bytes };
}

function readTail(file: string, n: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
