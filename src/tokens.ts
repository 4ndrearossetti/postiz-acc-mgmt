// One-time tokens: guard against double-submit (SPEC 4.2 case B) and bind a
// destructive confirm to a fresh preview. In-memory is fine for one operator.
import * as crypto from 'crypto';

interface Entry { created: number; meta?: unknown }
const store = new Map<string, Entry>();
const TTL_MS = 30 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.created > TTL_MS) store.delete(k);
}

export function mint(meta?: unknown): string {
  gc();
  const t = crypto.randomBytes(18).toString('hex');
  store.set(t, { created: Date.now(), meta });
  return t;
}

// Returns the stored meta (and removes the token) if valid; null otherwise.
export function consume(token: string | undefined): { ok: boolean; meta?: unknown } {
  if (!token) return { ok: false };
  const e = store.get(token);
  if (!e) return { ok: false };
  store.delete(token);
  if (Date.now() - e.created > TTL_MS) return { ok: false };
  return { ok: true, meta: e.meta };
}
