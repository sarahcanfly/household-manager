#!/usr/bin/env bash
# Runs the migration and SQL tests against a throwaway local Postgres.
# Usage: tests/sql/run.sh   (needs Postgres 15+ binaries; run as root or the postgres user)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
bin="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
dir="$(mktemp -d)"; port=54329
chown postgres "$dir" 2>/dev/null || true
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
cleanup() { as_pg "$bin/pg_ctl -D $dir/data -m immediate stop >/dev/null 2>&1" || true; rm -rf "$dir"; }
trap cleanup EXIT
as_pg "$bin/initdb -D $dir/data -U postgres -A trust >/dev/null"
as_pg "$bin/pg_ctl -D $dir/data -o '-p $port -k $dir -c listen_addresses=' -l $dir/log start >/dev/null"
psql_() { as_pg "$bin/psql -h $dir -p $port -U postgres -v ON_ERROR_STOP=1 -q $*"; }
psql_ "-c 'create database t'"
cp "$here/supabase_stub.sql" "$root/supabase/migrations/"*.sql "$here/tests.sql" "$dir/"
chmod 644 "$dir"/*.sql
psql_ "-d t -f $dir/supabase_stub.sql"
for f in "$root"/supabase/migrations/*.sql; do psql_ "-d t -f $dir/$(basename "$f")"; done
out="$(psql_ "-d t -f $dir/tests.sql" 2>&1 || true)"
echo "$out" | grep -E 'ok -|FAIL|ERROR|PASSED' | sed 's/^psql:[^ ]* NOTICE:  //'
echo "$out" | grep -q 'ALL SQL TESTS PASSED'
# Optional: extra SQL files to load afterwards into a fresh database (e.g. an import), then show counts.
if [ "$#" -gt 0 ]; then
  psql_ "-c 'create database extra'"
  psql_ "-d extra -f $dir/supabase_stub.sql"
  for f in "$root"/supabase/migrations/*.sql; do psql_ "-d extra -f $dir/$(basename "$f")"; done
  for f in "$@"; do cp "$f" "$dir/extra.sql"; chmod 644 "$dir/extra.sql"; psql_ "-d extra -f $dir/extra.sql"; done
  psql_ "-d extra -At -c \"select 'members', count(*) from members union all select 'events', count(*) from events union all select 'pending', count(*) from pending union all select 'allowed', count(*) from allowed_users union all select 'feeds', jsonb_array_length(value) from settings where key='feeds'\""
fi
