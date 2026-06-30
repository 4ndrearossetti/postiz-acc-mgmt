#!/usr/bin/env bash
# Spin up / tear down a THROWAWAY local Postgres for tests. Never touches a
# live database. Postgres refuses to run as root, so it runs as user "pgtest".
set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA=${PGDATA:-/tmp/pgtest/data}
PGPORT=${PGPORT:-55432}
PGUSER=${PGUSER:-postgres}
PGDATABASE=${PGDATABASE:-postiz_test}
ROOTDIR="$(cd "$(dirname "$0")/.." && pwd)"

ensure_user() {
  if ! id pgtest >/dev/null 2>&1; then
    useradd -m pgtest
  fi
  mkdir -p "$(dirname "$PGDATA")"
  chown -R pgtest "$(dirname "$PGDATA")"
}

up() {
  ensure_user
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    su pgtest -c "$PGBIN/initdb -D '$PGDATA' -U '$PGUSER' --auth=trust >/dev/null"
  fi
  if ! su pgtest -c "$PGBIN/pg_ctl -D '$PGDATA' status" >/dev/null 2>&1; then
    su pgtest -c "$PGBIN/pg_ctl -D '$PGDATA' -o '-p $PGPORT -k /tmp/pgtest -c listen_addresses=127.0.0.1' -l '/tmp/pgtest/server.log' -w start"
  fi
  # (Re)create the database fresh.
  su pgtest -c "$PGBIN/psql -h 127.0.0.1 -p $PGPORT -U '$PGUSER' -d postgres -v ON_ERROR_STOP=1 -c \"DROP DATABASE IF EXISTS $PGDATABASE\"" >/dev/null
  su pgtest -c "$PGBIN/psql -h 127.0.0.1 -p $PGPORT -U '$PGUSER' -d postgres -v ON_ERROR_STOP=1 -c \"CREATE DATABASE $PGDATABASE\"" >/dev/null
  su pgtest -c "$PGBIN/psql -h 127.0.0.1 -p $PGPORT -U '$PGUSER' -d $PGDATABASE -v ON_ERROR_STOP=1 -f '$ROOTDIR/test/schema.sql'" >/dev/null
  echo "test db ready on 127.0.0.1:$PGPORT db=$PGDATABASE user=$PGUSER (trust auth)"
}

down() {
  if id pgtest >/dev/null 2>&1 && [ -f "$PGDATA/PG_VERSION" ]; then
    su pgtest -c "$PGBIN/pg_ctl -D '$PGDATA' -w stop" >/dev/null 2>&1 || true
  fi
  echo "test db stopped"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 [up|down]"; exit 1 ;;
esac
