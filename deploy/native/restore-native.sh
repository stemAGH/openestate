#!/usr/bin/env bash
# Restores a bundle produced by backup-native.sh: database, uploads, and
# (only with --restore-env) openestate.env. Destructive — requires --force.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ENV_FILE="/etc/openestate/openestate.env"
UPLOADS_DIR="/var/lib/openestate/uploads"
FORCE=0
RESTORE_ENV=0
PG_HOST=""
PG_ADMIN_USER="postgres"
BUNDLE_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --restore-env) RESTORE_ENV=1; shift ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --uploads-dir) UPLOADS_DIR="$2"; shift 2 ;;
    --host) PG_HOST="$2"; shift 2 ;;
    --admin-user) PG_ADMIN_USER="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: restore-native.sh --force BUNDLE_DIR [options]
  --force              Required — this overwrites the live database.
  --restore-env        Also overwrite /etc/openestate/openestate.env with
                        the bundle's copy (requires confirmation — silently
                        replaces live secrets otherwise).
  --env-file PATH       Where to read DATABASE_URL from / write env to
                        (default: /etc/openestate/openestate.env).
  --uploads-dir PATH    Where to extract uploads to (default: /var/lib/openestate/uploads).
  --host / --admin-user Superuser connection for restoring the DB — same
                        meaning as setup-database.sh (default: local peer
                        auth as the postgres OS user).
USAGE
      exit 0
      ;;
    *)
      [ -z "$BUNDLE_DIR" ] || die "Unexpected argument: $1"
      BUNDLE_DIR="$1"; shift ;;
  esac
done

[ -n "$BUNDLE_DIR" ] || die "Missing BUNDLE_DIR. See --help."
[ -d "$BUNDLE_DIR" ] || die "Bundle directory not found: $BUNDLE_DIR"
[ "$FORCE" -eq 1 ] || die "Refusing to restore without --force (this overwrites the live database)."
[ -f "${BUNDLE_DIR}/db.sql" ] || die "${BUNDLE_DIR}/db.sql not found — is this a valid backup bundle?"

[ -f "$ENV_FILE" ] || die "${ENV_FILE} not found. Pass --env-file if it lives elsewhere."
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
DB_NAME="$(printf '%s' "${DATABASE_URL:?DATABASE_URL missing from $ENV_FILE}" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"

read -r -p "This will DROP and recreate database '${DB_NAME}' from ${BUNDLE_DIR}/db.sql. Type the database name to confirm: " CONFIRM
[ "$CONFIRM" = "$DB_NAME" ] || die "Confirmation did not match. Aborted."

if [ -n "$PG_HOST" ]; then
  psql_admin() { psql -v ON_ERROR_STOP=1 -h "$PG_HOST" -U "$PG_ADMIN_USER" "$@"; }
else
  psql_admin() { sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"; }
fi

log "Stopping openestate-api (holds open connections that block DROP DATABASE)..."
systemctl stop openestate-api 2>/dev/null || true

log "Dropping and recreating '${DB_NAME}'..."
psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME}" postgres
psql_admin -c "CREATE DATABASE ${DB_NAME}" postgres

HOST_ARGS=()
[ -n "$PG_HOST" ] && HOST_ARGS=(--host "$PG_HOST" --admin-user "$PG_ADMIN_USER")

# Roles are not part of the dump, but the dump refers to them (owners and
# grants), so on a fresh server they must exist before it is loaded.
log "Creating the database roles the dump refers to..."
"${SCRIPT_DIR}/setup-database.sh" --db "$DB_NAME" --env-file "$ENV_FILE" "${HOST_ARGS[@]}"

log "Restoring database from ${BUNDLE_DIR}/db.sql..."
# Streamed on standard input, so root opens the dump and the postgres OS user
# never has to: backup-native.sh makes it root-only (mode 600).
psql_admin -d "$DB_NAME" < "${BUNDLE_DIR}/db.sql"

log "Re-applying role setup (roles/grants are not part of the dump)..."
"${SCRIPT_DIR}/setup-database.sh" --db "$DB_NAME" --env-file "$ENV_FILE" "${HOST_ARGS[@]}"

if [ -f "${BUNDLE_DIR}/uploads.tar.gz" ]; then
  log "Restoring uploads to ${UPLOADS_DIR}..."
  mkdir -p "$UPLOADS_DIR"
  find "$UPLOADS_DIR" -mindepth 1 -delete
  tar xzf "${BUNDLE_DIR}/uploads.tar.gz" -C "$(dirname "$UPLOADS_DIR")"
else
  warn "No uploads.tar.gz in bundle — skipping uploads restore."
fi

if [ "$RESTORE_ENV" -eq 1 ]; then
  [ -f "${BUNDLE_DIR}/openestate.env" ] || die "--restore-env given but ${BUNDLE_DIR}/openestate.env not found."
  read -r -p "This overwrites ${ENV_FILE}'s live secrets with the bundle's copy. Type yes to confirm: " CONFIRM_ENV
  if [ "$CONFIRM_ENV" = "yes" ]; then
    cp "${BUNDLE_DIR}/openestate.env" "$ENV_FILE"
    chmod 640 "$ENV_FILE"
    log "openestate.env restored."
  else
    warn "Skipped restoring openestate.env."
  fi
fi

log "Starting openestate-api..."
systemctl start openestate-api

log "Restore complete."
