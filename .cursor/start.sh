#!/usr/bin/env bash
# Per-boot reconciliation: bring up PostgreSQL and make sure the JUSTTECH
# role, database, and schema exist. Safe to run on every boot and more than
# once -- every step is idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Start the default Postgres 16 cluster if it is not already online. The
# cluster's data directory persists in the environment snapshot, so this
# only needs to (re)start the server process on a fresh boot.
if ! pg_lsclusters -h 2>/dev/null | awk '$1=="16" && $2=="main" {print $4}' | grep -q online; then
  sudo pg_ctlcluster 16 main start 2>/dev/null || sudo pg_ctlcluster 16 main restart
fi

# Wait for the server to accept connections before touching it.
for _ in $(seq 1 30); do
  if pg_isready -h localhost -p 5432 -q; then break; fi
  sleep 1
done

# Ensure the application role exists. It is a superuser so it owns the
# tables it creates and therefore bypasses the (Supabase-oriented) RLS
# policies for local single-user development -- this matches the
# docker-compose setup documented in the README.
sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='justtech') THEN CREATE ROLE justtech LOGIN SUPERUSER PASSWORD 'justtech'; END IF; END \$\$;"

# Ensure the database exists.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='justtech'" | grep -q 1; then
  sudo -u postgres createdb -O justtech justtech
fi

# Apply the schema. 001_init.sql is fully guarded with IF NOT EXISTS /
# CREATE OR REPLACE, so re-running it is a no-op on an already-migrated DB.
PGPASSWORD=justtech psql -h localhost -U justtech -d justtech -q -f "$REPO_ROOT/backend/migrations/001_init.sql" >/dev/null

echo "PostgreSQL is online and the JUSTTECH schema is applied."
