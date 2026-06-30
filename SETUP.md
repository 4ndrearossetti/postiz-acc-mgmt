# Setup guide

Get the Postiz Admin Console running from zero. Two paths:

- [A. Docker deploy](#a-docker-deploy-recommended) — run it next to Postiz on the
  same Docker network (how you'd actually use it).
- [B. Local development](#b-local-development) — run it against a throwaway
  Postgres on your laptop, never touching live data.

> ⚠️ This tool operates **directly on the Postiz database** and can delete every
> workspace and connected social account. Keep it on the internal network behind
> the admin login, **never public**. Develop against the throwaway DB (Path B)
> until you trust it, then point Path A at the real network.

---

## Prerequisites

- A running self-hosted **Postiz** stack in Docker (Postgres container
  `postiz-postgres`, image `postgres:17-alpine`, on a Docker network).
- **Docker** + **Docker Compose** (for Path A).
- **Node.js 22+** and **npm** (for Path B / building locally).
- Shell access to the Docker host.

---

## A. Docker deploy (recommended)

### 1. Get the code onto the Docker host

```bash
git clone <this-repo> postiz-admin-console
cd postiz-admin-console
```

### 2. Find the Postiz network name

The console must join the **existing** Docker network Postiz already uses, so
`postiz-postgres` resolves.

```bash
docker network ls
# Look for the Postiz project's network, e.g. "postiz_default" or "postiz".
```

If you're unsure which network the DB is on:

```bash
docker inspect postiz-postgres \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

### 3. Discover the database credentials

The DB name/user come from the Postiz Postgres container's own env (you set
these when you deployed Postiz):

```bash
docker exec postiz-postgres sh -c 'printf "PGUSER=%s\nPGDATABASE=%s\n" "$POSTGRES_USER" "$POSTGRES_DB"'
```

The password is whatever you set as `POSTGRES_PASSWORD` for that container.

### 4. Create your `.env`

```bash
cp .env.example .env
```

Edit `.env` and set, at minimum:

| Variable | Set it to |
|----------|-----------|
| `PGHOST` | `postiz-postgres` (the container name; leave as-is) |
| `PGDATABASE` / `PGUSER` / `PGPASSWORD` | the values from step 3 |
| `POSTIZ_NETWORK` | the network name from step 2 |
| `SESSION_SECRET` | a long random string — `openssl rand -hex 32` |
| `ADMIN_USERNAME` | your console login name |
| `ADMIN_PASSWORD_HASH` **or** `ADMIN_PASSWORD` | your console login secret (see step 5) |

Leave `AUDIT_LOG`, `BACKUP_DIR`, `APP_PORT`, and `INSECURE_COOKIES=true` at their
defaults unless you have a reason to change them.

### 5. Set the admin password

Preferred — store a **hash**, not a plaintext password. Build once and generate:

```bash
npm install && npm run build
node dist/tools/hashpw.js 'your-strong-password'
# → $2b$10$....  copy this into ADMIN_PASSWORD_HASH in .env
```

Or, for a quick start, just set `ADMIN_PASSWORD=your-strong-password` in `.env`
(it's hashed in memory at boot). Set only one of the two.

### 6. Build and start

```bash
docker compose up -d --build
docker compose logs -f admin-console   # should print "listening on 0.0.0.0:8080"
```

The image bundles `pg_dump` 17 (matching `postgres:17-alpine`) for the
pre-delete backups.

### 7. Reach the UI (it's loopback-only on purpose)

Compose publishes the console **only on the host's `127.0.0.1`** — it is not
reachable from the network. Tunnel in over SSH:

```bash
ssh -L 8080:127.0.0.1:8080 your-docker-host
# then open http://localhost:8080 in your browser and log in
```

> Never change the port binding to `0.0.0.0` or put this behind a public reverse
> proxy without an additional auth layer + TLS. It is an internal tool.

### 8. First run checklist

1. Log in with your `ADMIN_USERNAME` / password.
2. The **Dashboard** shows workspace/account counts and the 4 health checks —
   confirm they reflect your real instance (this proves the DB connection).
3. Create a throwaway workspace, then delete it (preview → backup → confirm) to
   verify backups land in `BACKUP_DIR` (the `backups` volume).

---

## B. Local development

Runs the app against a **throwaway** local Postgres seeded with a Postiz-shaped
schema. Never touches a live DB.

```bash
npm install
npm test            # spins up a local PG on 127.0.0.1:55432, runs all suites
```

`npm test` resets the throwaway DB and runs the smoke, adversarial, and
regression suites. To run the app itself against that DB:

```bash
npm run build
npm run test:db:up     # start the throwaway PG (loads test/schema.sql)

PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=postiz_test PGUSER=postgres PGPASSWORD=postgres \
ADMIN_USERNAME=admin ADMIN_PASSWORD=secret SESSION_SECRET=$(openssl rand -hex 32) \
APP_PORT=8080 AUDIT_LOG=./data/audit.jsonl BACKUP_DIR=./backups INSECURE_COOKIES=true \
node dist/server.js
# open http://localhost:8080  (admin / secret)

npm run test:db:down   # stop the throwaway PG when finished
```

> The throwaway Postgres runs as a dedicated `pgtest` OS user (Postgres refuses
> to run as root). `scripts/test-db.sh up` creates it on first run; this needs
> root/sudo on the dev box.

---

## Configuration reference

Every setting is env-only (see `.env.example`):

| Var | Purpose | Default |
|-----|---------|---------|
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | Postiz DB connection | — / `5432` / — |
| `PGPOOLMAX` | pg pool size | `5` |
| `ADMIN_USERNAME` | console login user | `admin` |
| `ADMIN_PASSWORD_HASH` *or* `ADMIN_PASSWORD` | console login secret | — |
| `SESSION_SECRET` | signs the session cookie (long & random) | — |
| `APP_HOST` `APP_PORT` | listen address/port inside the container | `0.0.0.0` / `8080` |
| `AUDIT_LOG` | JSONL audit-log path | `./data/audit.jsonl` |
| `BACKUP_DIR` | where pre-delete `pg_dump` files go | `./backups` |
| `ORPHAN_POLICY` | `leave` or `cascade` for members left at 0 memberships | `leave` |
| `POSTIZ_NETWORK` | existing Postiz Docker network to join | `postiz_default` |
| `INSECURE_COOKIES` | `true` for plain-HTTP internal use; `false` behind TLS | `true` |

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Container exits immediately, log says `Missing required env var` | A required value isn't set in `.env` (e.g. `SESSION_SECRET`, DB creds, or neither `ADMIN_PASSWORD_HASH` nor `ADMIN_PASSWORD`). |
| `getaddrinfo ENOTFOUND postiz-postgres` | The console didn't join Postiz's network. Check `POSTIZ_NETWORK` matches step 2 and that the network is `external`. |
| `password authentication failed` / `database "..." does not exist` | `PGUSER` / `PGPASSWORD` / `PGDATABASE` don't match the values from step 3. |
| Dashboard loads but shows 0 of everything | You're connected to the wrong database — re-check `PGDATABASE`. |
| Delete refused: *"Backup is missing the pg_dump completion marker"* or *exit N* | `pg_dump` couldn't reach/dump the DB, or its version is older than the server. The bundled image ships `pg_dump` 17; if you changed the base image, ensure `pg_dump` ≥ your Postgres major. |
| Can't open the UI in a browser | It's loopback-only by design — use the SSH tunnel in step 7. |
| `Too many attempts. Try again in Ns` at login | Login rate-limit after repeated failures; wait it out (per-IP backoff). |

See [README.md](./README.md) for architecture, the safety model, and known
behaviors.
