#!/usr/bin/env bash
# Provisions the OpenEstate test database against a PostgreSQL server you
# already run, then applies migrations and seeds it. No containers — this
# repo has no Docker in it at all; you bring Postgres and Redis the same
# way a production install does (see docs/docs/installation.md).
#
# Usage:
#   ./scripts/test-setup.sh            # create DB + roles, migrate, seed
#   ./scripts/test-setup.sh teardown   # DROP the test database
#
# Connecting as an admin, two modes, matching deploy/native/setup-database.sh:
#   local  (default) — `sudo -u postgres psql`, Unix-socket peer auth
#   remote (TCP)     — set PGPASSWORD, and TEST_PG_HOST if not localhost
#
# Overridable:
#   TEST_PG_HOST (unset=peer auth)  TEST_PG_PORT (5432)
#   TEST_PG_ADMIN_USER (postgres)   TEST_DB_NAME (openestate_test)
#   TEST_REDIS_HOST (localhost)     TEST_REDIS_PORT (6379)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PG_HOST="${TEST_PG_HOST:-}"
PG_PORT="${TEST_PG_PORT:-5432}"
PG_ADMIN_USER="${TEST_PG_ADMIN_USER:-postgres}"
DB_NAME="${TEST_DB_NAME:-openestate_test}"
REDIS_HOST="${TEST_REDIS_HOST:-localhost}"
REDIS_PORT="${TEST_REDIS_PORT:-6379}"

# Fixed, not generated. These are throwaway credentials for a throwaway
# database, and .github/workflows/ci.yml plus apps/e2e/playwright.config.ts
# both hardcode the same values — a per-run random password would mean
# nothing else could connect without being told what it was.
SUPER_PASSWORD="test_super_pass"
APP_PASSWORD="test_app_pass"
SYSTEM_PASSWORD="test_system_pass"

# Deliberately DIFFERENT names from a real install's openestate_app/
# openestate_system (deploy/native/setup-database.sh's own defaults) — not
# just different passwords. Postgres roles are cluster-wide, and a prior
# incident found out the hard way that provisioning tests with the SAME
# role names as a real install on the same cluster resets that install's
# passwords to these throwaway values, breaking it until its own
# setup-database.sh is re-run. Different names make that collision
# structurally impossible rather than merely guarded against — see the
# now-removed shared-cluster guard this replaced, a few sections down.
TEST_APP_ROLE="openestate_test_app"
TEST_SYSTEM_ROLE="openestate_test_system"

log()  { printf '\033[1;32m[test-setup]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[test-setup]\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31m[test-setup]\033[0m %s\n' "$1" >&2; exit 1; }

command -v psql >/dev/null 2>&1 || die "psql not found. Install the PostgreSQL client package."

# COREPACK_ENABLE_DOWNLOAD_PROMPT=0: corepack's "Do you want to continue?
# [Y/n]" prompt (shown the first time this repo's pinned pnpm version isn't
# already cached for the invoking user) reads from stdin — real feedback on
# a real interactive terminal, but this script has no guarantee of one (an
# agent, a CI runner, anything that doesn't provide a live keyboard), so
# left at its default the prompt just hangs forever. Reproduced directly
# (a fresh COREPACK_HOME against this project's pinned pnpm@9.15.0, network
# reachable): the prompt appears and blocks indefinitely with no env var
# set; with this one set, it proceeds straight to the download instead —
# confirmed the hang is gone, not just less likely.
#
# Investigated whether the fetch itself can be avoided entirely when the
# pinned version isn't cached, rather than just making its failure mode
# clean — tried COREPACK_ENABLE_NETWORK=0 (fails cleanly instead of
# fetching, but never succeeds either — it can't use a different, already-
# installed pnpm, it just refuses) and COREPACK_ENABLE_PROJECT_SPEC=0
# (ignores this repo's pin and tries to fetch pnpm "latest" instead — worse,
# not better, and defeats the entire point of pinning). Neither lets
# corepack fall back to an already-installed different-version pnpm; there
# is no such fallback in corepack's own design short of disabling the pin
# outright, which was rejected — every contributor and CI run using the
# exact same pnpm version is worth keeping. A real download over the
# network stays possible when genuinely needed; run_pnpm() below is what
# makes THAT failing cleanly instead of hanging or dumping a raw stack
# trace.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Every bare `pnpm` invocation in this script goes through this wrapper
# instead of being called directly, so a failure fetching the pinned
# version is diagnosed once, here, instead of as whatever raw corepack
# stack trace happened to come out of whichever call site hit it first.
run_pnpm() {
  pnpm "$@" && return 0
  local status=$?
  if ! node -e "fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(5000) })" >/dev/null 2>&1; then
    die "pnpm $* failed, and this machine cannot reach registry.npmjs.org over
HTTPS right now (checked directly just now, not inferred from the error
above). If this is a virtual machine resumed from a snapshot, its system
clock may have drifted and broken TLS certificate validation for exactly this
host; sync the clock and retry. Otherwise, check your own network/proxy/firewall.
The original pnpm error is above this message."
  fi
  die "pnpm $* failed (exit ${status}) — see the output above."
}

# packages/db's seed/sync scripts run under tsx as CJS, which resolves
# @openestate/shared via its package.json's "require" condition —
# ./dist/index.js, the COMPILED output — not the "import" condition Vite
# dev servers use (raw TS source). A shared-package export added since the
# last build (e.g. DEFAULT_LEAD_STAGES) silently resolves to undefined
# there until dist is rebuilt: exactly the Phase 1 "Vite builds don't
# require this, NestJS production runtime does" rule, applying here too
# because tsx is also a Node/CJS consumer. Same reason
# deploy/native/lib.sh's build_release() rebuilds shared before db.
log "Building @openestate/shared (dist consumed by tsx-run scripts)..."
run_pnpm --filter @openestate/shared build

if [ -n "$PG_HOST" ] || [ -n "${PGPASSWORD:-}" ]; then
  PG_HOST="${PG_HOST:-localhost}"
  psql_admin() { psql -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" -U "$PG_ADMIN_USER" "$@"; }
else
  sudo -u postgres true 2>/dev/null || die "Cannot sudo to the 'postgres' OS user. Set PGPASSWORD (and TEST_PG_HOST if remote) to connect over TCP instead."
  psql_admin() { sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"; }
fi
CONNECT_HOST="${PG_HOST:-localhost}"

psql_admin -tAc "SELECT 1" postgres >/dev/null 2>&1 \
  || die "Cannot connect to PostgreSQL as an admin. Check it is running and the connection details are right."

if [ "${1:-}" = "teardown" ]; then
  # Only ever drop a database whose name marks it as disposable. Without
  # this guard a stray TEST_DB_NAME=openestate would drop a real install's
  # database, since it is the same cluster.
  case "$DB_NAME" in
    *_test) ;;
    *) die "Refusing to drop '${DB_NAME}': teardown only drops a database whose name ends in _test." ;;
  esac
  log "Dropping database '${DB_NAME}'..."
  psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)" postgres
  # openestate_test_app/openestate_test_system/openestate_super are
  # cluster-wide, not per-database — dropping them here could break a
  # DIFFERENT test database on this same cluster that still uses them, so
  # they are deliberately left in place regardless. (They share no name
  # with a real install's own openestate_app/openestate_system, so this is
  # no longer about protecting a real install specifically — just about
  # not surprising whatever else might be using this cluster.)
  log "Done. Roles left in place (they are cluster-wide — see comment in this script)."
  exit 0
fi

# REMOVED (this used to be a two-part guard here — a check for a database
# named 'openestate', and a check for existing openestate_app/openestate_system
# roles — refusing to proceed on a cluster that looked like it hosted a real
# install, because provisioning tests there reset those roles' passwords and
# broke it). Both checks existed for exactly one reason: TEST_APP_ROLE/
# TEST_SYSTEM_ROLE used to be the SAME names a real install uses
# (openestate_app/openestate_system). Now that they're structurally
# different (openestate_test_app/openestate_test_system), the harm the guard
# existed to prevent can't happen — this script never creates, alters, or
# reads the password of any role a real install uses, on any cluster,
# regardless of what else that cluster hosts. Keeping the guard around
# would mean keeping dead code whose own error messages describe a
# collision that is no longer possible; removed rather than left
# half-meaningful. TEST_ALLOW_SHARED_CLUSTER is gone with it — nothing left
# to opt into.

# Migrations CREATE ROLE ... BYPASSRLS, which only a superuser may do, so
# migrate/seed cannot run as the test app/system roles. A native
# install solves this by running them as the `postgres` OS user over the
# Unix socket (install-native.sh's run_as_superuser). That does not work
# from a developer checkout: Prisma stats its cwd for a config file first,
# and the `postgres` user usually cannot traverse a $HOME checkout — the
# EACCES failure documented in install-native.sh. So tests get their own
# superuser login role and connect over TCP as the developer instead.
log "Ensuring superuser login role 'openestate_super' exists..."
psql_admin postgres <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'openestate_super') THEN
	    CREATE ROLE openestate_super WITH LOGIN SUPERUSER PASSWORD '${SUPER_PASSWORD}';
	  ELSE
	    ALTER ROLE openestate_super WITH LOGIN SUPERUSER PASSWORD '${SUPER_PASSWORD}';
	  END IF;
	END
	\$\$;
EOSQL

log "Ensuring database '${DB_NAME}' exists and is owned by openestate_super..."
if ! psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" postgres | grep -q 1; then
  psql_admin -c "CREATE DATABASE ${DB_NAME} OWNER openestate_super" postgres
else
  psql_admin -c "ALTER DATABASE ${DB_NAME} OWNER TO openestate_super" postgres
fi

# Role creation + grants come from the native installer's own script rather
# than a second copy of the same SQL. Run before the migration so the
# ALTER DEFAULT PRIVILEGES cover the tables it is about to create, and again
# after so the GRANT ... ON ALL TABLES catches them too — the same two-step
# ci.yml does inline.
#
# Deliberately connects as openestate_super, not as the cluster admin:
# ALTER DEFAULT PRIVILEGES with no FOR ROLE applies to the role running it,
# and openestate_super is the role that creates the tables (it owns this
# database and runs the migrations below). Running these grants as the
# cluster admin instead would attach the default privileges to the wrong
# role, leaving any table created after this point ungranted. ci.yml
# connects as openestate_super here for the same reason.
grant_roles() {
  PGPASSWORD="$SUPER_PASSWORD" "${REPO_ROOT}/deploy/native/setup-database.sh" \
    --host "$CONNECT_HOST" \
    --port "$PG_PORT" \
    --admin-user openestate_super \
    --db "$DB_NAME" \
    --app-password "$APP_PASSWORD" \
    --system-password "$SYSTEM_PASSWORD" \
    --app-role-name "$TEST_APP_ROLE" \
    --system-role-name "$TEST_SYSTEM_ROLE"
}

log "Creating application roles (via deploy/native/setup-database.sh)..."
grant_roles

export DATABASE_URL="postgresql://openestate_super:${SUPER_PASSWORD}@${CONNECT_HOST}:${PG_PORT}/${DB_NAME}"
export DATABASE_URL_TEST="postgresql://${TEST_APP_ROLE}:${APP_PASSWORD}@${CONNECT_HOST}:${PG_PORT}/${DB_NAME}?connection_limit=10"
export DATABASE_URL_TEST_SYSTEM="postgresql://${TEST_SYSTEM_ROLE}:${SYSTEM_PASSWORD}@${CONNECT_HOST}:${PG_PORT}/${DB_NAME}?connection_limit=5"
export REDIS_TEST_URL="redis://${REDIS_HOST}:${REDIS_PORT}"
# Superuser login for test teardown only: since v0.8.4 the append-only
# escape hatch (app.allow_financial_mutation) works only for a login that is
# a member of openestate_maintenance, and superusers are the only such
# logins. The test app/system roles are deliberately not members.
export DATABASE_URL_TEST_SUPER="postgresql://openestate_super:${SUPER_PASSWORD}@${CONNECT_HOST}:${PG_PORT}/${DB_NAME}?connection_limit=2"
# connection_limit above is deliberate, not decorative — see CLAUDE.md's
# Phase 7 CI-reliability decisions. Every test file gets its OWN
# PrismaClient pair (createTenantPrismaClient/createSystemPrismaClient), and
# Prisma's default pool size is num_cpus*2+1 (33 on a 16-core box) PER
# CLIENT. With vitest's default fork concurrency that adds up to several
# hundred potential connections against Postgres's max_connections=100 —
# capped here to a fixed, arithmetically-checked-safe budget instead (see
# vitest.config.ts's maxForks comment for the other half of this budget).

log "Applying Prisma migrations..."
cd "${REPO_ROOT}/packages/db"
npx prisma migrate deploy
echo ""
npx prisma migrate status

# The generated client is a build artifact of schema.prisma, not of the
# migration SQL — `pnpm install`'s postinstall generates it once, but a
# schema change landing via `git pull`/a synced working tree afterward
# leaves the checked-out client stale until something regenerates it.
# migrate deploy applies raw SQL and never touches the client, so without
# this, seed (or anything else importing @prisma/client) fails with
# "Unknown field" the moment a query touches a genuinely new column.
log "Regenerating the Prisma client..."
npx prisma generate
cd "$REPO_ROOT"

log "Re-granting table privileges now that tables exist..."
grant_roles

log "Running seed..."
run_pnpm --filter @openestate/db seed

if command -v redis-cli >/dev/null 2>&1; then
  if ! redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    warn "Redis is not answering on ${REDIS_HOST}:${REDIS_PORT}. Start it before running the suite — several tests need it."
  fi
else
  warn "redis-cli not found, skipping the Redis reachability check. The suite needs Redis on ${REDIS_HOST}:${REDIS_PORT}."
fi

# Written as well as printed: the values are also the fallbacks compiled
# into the test files, so a mismatched port fails as a connection refusal
# with no hint about where the right value was.
cat > "${REPO_ROOT}/.test-env" <<-EOF
	export DATABASE_URL_TEST="${DATABASE_URL_TEST}"
	export DATABASE_URL_TEST_SYSTEM="${DATABASE_URL_TEST_SYSTEM}"
	export DATABASE_URL_TEST_SUPER="${DATABASE_URL_TEST_SUPER}"
	export REDIS_TEST_URL="${REDIS_TEST_URL}"
EOF

echo ""
log "Test database ready. Run the suite with:"
echo "  source .test-env"
echo "  pnpm test"
