#!/bin/sh
# Type-check and compile the server code, then run the unit tests (and the SQL tests if Postgres is available).
set -e
cd "$(dirname "$0")/.."
rm -rf .build
tsc -p tsconfig.json
node --test tests/unit/*.test.mjs
if ls /usr/lib/postgresql/*/bin/initdb >/dev/null 2>&1; then tests/sql/run.sh | tail -1; fi
