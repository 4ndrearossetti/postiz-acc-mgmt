# Postiz Admin Console

A small internal web app for managing **users and workspaces** on a self-hosted
[Postiz](https://github.com/gitroomhq/postiz-app) instance, run by **one
operator**. Postiz has no admin API for creating users/orgs, so this tool works
**directly on the Postiz PostgreSQL database**, replicating Postiz's own data
conventions (bcrypt cost 10, `LOCAL` provider, the `ON CONFLICT` upserts, etc.).

> ⚠️ **This tool can delete every workspace and every connected social account on
> the instance.** Keep it on the internal Docker network, behind the single admin
> login, **never public**. Every destructive action is **preview → backup →
> confirm**, and a `pg_dump` runs automatically before any delete.

---

## What it does

| Area | Feature |
|------|---------|
| **Read / health** | Workspace & account tables; the 4 health checks (no-SUPERADMIN workspaces, orphaned accounts, duplicate names, shared accounts). |
| **Create** | A) add accounts to an existing workspace · B) create workspace + owner · C) create + populate. New accounts get a secure generated password shown **once**. |
| **Bulk CSV** | `members.csv` and `workspaces.csv` with a **dry-run diff** (validate + classify each row) before a one-transaction execute. |
| **Manage** | Change role, remove member — with a **last-SUPERADMIN guard** (override required). |
| **Delete** | FK-ordered teardown of workspaces and/or accounts, derived **from the live catalog** (handles the `Orders↔MessagesGroup` cycle and the `Post.parentPostId` self-reference). Preview shows predicted row counts (dry-run, rolled back); confirm requires typing the exact names. |
| **Audit** | Append-only JSONL log (`admin, action, targets, row counts, ts`) with **passwords and bcrypt hashes redacted**. |

## Safety model (single operator)

- **Preview → backup → confirm** for every destructive action; confirms require
  typing the exact workspace name(s) / account email(s).
- **Auto-backup**: `pg_dump` of the Postiz DB to a timestamped file in
  `BACKUP_DIR` before any delete. The delete **refuses to proceed** unless the
  dump is non-empty.
- Every mutation runs in **one transaction**; any error rolls it all back.
- **Dry-run** prints the exact SQL plan + predicted row counts without
  committing.
- Health checks re-run after each delete; new issues are surfaced.
- All row values use **bind parameters**. The only dynamic identifiers are the
  catalog-derived table/column names in the delete walker, quoted with a
  vetted helper — values there are still bound.

## Architecture

```
src/
  config.ts        env-only config (nothing hardcoded)
  db.ts            pg pool + withTransaction + quoteIdent
  hash.ts          bcrypt (Postiz-compatible $2b$10$) + secure password gen
  auth.ts          single-operator login, signed session cookie
  audit.ts         append-only JSONL audit log (redacts secrets)
  health.ts        read views + the 4 health checks + delete pre-flights
  fkwalker.ts      catalog-driven FK graph → topo sort → scoped DELETE plan
  deleteEngine.ts  executes the plan in one transaction (dry-run or real)
  backup.ts        pre-delete pg_dump over the pg protocol
  creation.ts      cases A/B/C, bulk import, role/membership management
  csv.ts           CSV parse + dry-run diff classification
  tokens.ts        one-time tokens (double-submit / confirm binding)
  views.ts         server-rendered HTML (no external CDN)
  server.ts        Fastify routes + UI
```

## Configuration

Everything is env-only — copy `.env.example` to `.env` and fill it in.

| Var | Purpose |
|-----|---------|
| `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` | Postiz database connection. |
| `ADMIN_USERNAME` | Console login user. |
| `ADMIN_PASSWORD_HASH` *or* `ADMIN_PASSWORD` | Console login secret. Prefer the hash: `node dist/tools/hashpw.js 'pw'`. |
| `SESSION_SECRET` | Signs the session cookie. Long & random. |
| `APP_PORT/APP_HOST` | Where the console listens (inside the container). |
| `AUDIT_LOG` | Path to the JSONL audit log. |
| `BACKUP_DIR` | Where pre-delete `pg_dump` files are written. |
| `ORPHAN_POLICY` | `leave` (default) or `cascade` — see below. |
| `POSTIZ_NETWORK` | Name of the existing Postiz Docker network to join. |
| `INSECURE_COOKIES` | `true` for plain-HTTP internal use; `false` behind TLS. |

### Orphan policy (workspace deletes)

When a workspace is deleted, members left with **zero memberships**:

- **`leave`** (default, safer): leave them as orphans, surfaced in the health
  panel for separate review.
- **`cascade`**: also delete accounts whose **sole** membership was this
  workspace — **never** a shared account. Can also be toggled per-delete in the
  UI.

## Deploy (Docker, same network as Postiz)

1. Find the Postiz network name: `docker network ls` (e.g. `postiz_default`).
2. `cp .env.example .env` and edit — set the DB creds, `POSTIZ_NETWORK`, a real
   `SESSION_SECRET`, and either `ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD`.
3. `docker compose up -d --build`
4. Reach it over an SSH tunnel — it is published on host loopback only:
   `ssh -L 8080:127.0.0.1:8080 your-server`, then open `http://localhost:8080`.

The image bundles `pg_dump` 17 (matching `postgres:17-alpine`) for backups, and
talks to `postiz-postgres:5432` over the shared network.

## Local development & tests

A throwaway local Postgres (loaded with a Postiz-shaped schema — **never the
live DB**) backs the smoke test.

```bash
npm install
npm run test:db:up     # initdb + start a local PG on 127.0.0.1:55432, load test/schema.sql
npm test               # FK-walker unit checks + end-to-end smoke test
npm run test:db:down   # stop it
```

The smoke test (SPEC Sec 8): creates a workspace + members, runs a dry-run,
performs a real delete (with backup), and asserts all four health checks come
back clean. It also verifies the walker breaks the `Orders↔MessagesGroup` cycle
and that the orphan-cascade never touches a shared account.

Run the app against the test DB:

```bash
npm run build
PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=postiz_test PGUSER=postgres PGPASSWORD=postgres \
ADMIN_USERNAME=admin ADMIN_PASSWORD=secret SESSION_SECRET=$(openssl rand -hex 32) \
APP_PORT=8080 AUDIT_LOG=./data/audit.jsonl BACKUP_DIR=./backups INSECURE_COOKIES=true \
node dist/server.js
```

## Restoring from a backup

Backups are plain `pg_dump` SQL in `BACKUP_DIR`. To restore the Postiz DB:

```bash
psql -h postiz-postgres -U "$PGUSER" -d "$PGDATABASE" -f postiz-backup-YYYY-MM-DD-HHMMSS.sql
```

(Restore into an empty/clean database; the dump uses `--no-owner --no-privileges`.)

## Notes on Postiz compatibility

- Hashing matches Postiz `bcrypt.hashSync(pw, 10)` → `$2b$10$…`.
- New local accounts: `providerName='LOCAL'`, `timezone=0`, `activated=true`,
  `id=gen_random_uuid()`, explicit `createdAt`/`updatedAt`.
- Idempotent upserts: `ON CONFLICT (email,"providerName") DO UPDATE` (never
  touches an existing password) and `ON CONFLICT ("userId","organizationId") DO
  NOTHING`.
- Delete ordering is **derived at runtime** from `pg_constraint` /
  `information_schema` — not hardcoded — so it adapts to a custom Postiz image.

## Non-goals (v1)

No post/channel/OAuth-token editing (stays in Postiz). No multi-admin RBAC. No
public API.
