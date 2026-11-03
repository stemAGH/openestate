#!/usr/bin/env bash
# Backs up the database, uploaded files, and /etc/openestate/openestate.env
# into one timestamped bundle. The env file is NOT optional: PAN_ENCRYPTION_KEY,
# TOTP_ENCRYPTION_KEY, and PLUGIN_SECRET_ENCRYPTION_KEYS live only there —
# a database dump without it is permanently undecryptable.
set -euo pipefail
# The bundle holds the database (PII, password hashes), the uploads and the
# encryption keys: everything it creates is for root only (dirs 700, files 600).
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ENV_FILE="/etc/openestate/openestate.env"
UPLOADS_DIR="/var/lib/openestate/uploads"
OUTPUT_DIR="/var/backups/openestate"

while [ $# -gt 0 ]; do
  case "$1" in
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --uploads-dir) UPLOADS_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: backup-native.sh [--output DIR] [--env-file PATH] [--uploads-dir PATH]"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[ -f "$ENV_FILE" ] || die "${ENV_FILE} not found. Pass --env-file if it lives elsewhere."
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
[ -n "${DATABASE_URL_SYSTEM:-}" ] || die "DATABASE_URL_SYSTEM not set in ${ENV_FILE}."

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
FINAL_DIR="${OUTPUT_DIR}/${TIMESTAMP}"
# Written under a work name and renamed when complete, so a failed backup never
# looks like a finished bundle. An existing --output directory keeps its own
# permissions (only a missing one is created, private); the bundle itself is
# private either way. mkdir without -p refuses anything already at the work
# path, a symlink included, so nothing is ever written through one.
BUNDLE_DIR="${FINAL_DIR}.incomplete"
[ -e "$FINAL_DIR" ] || [ -L "$FINAL_DIR" ] && die "${FINAL_DIR} already exists. Nothing was backed up."
mkdir -p "$OUTPUT_DIR"
mkdir -m 700 "$BUNDLE_DIR" || die "Could not create ${BUNDLE_DIR} (it may already exist). Nothing was backed up."

log "Dumping database..."
# Uses openestate_system (BYPASSRLS), not openestate_app — the app role is
# RLS-enforced, and pg_dump's own COPY queries don't (and can't) set the
# app.current_company_id session variable the way the application's Prisma
# extension does, so every RLS-protected table's COPY is rejected outright
# ("query would be affected by row-level security policy") under the app
# role. Confirmed by hitting this exact error on a real install.
pg_dump "$DATABASE_URL_SYSTEM" > "${BUNDLE_DIR}/db.sql"

log "Archiving uploads (${UPLOADS_DIR})..."
tar czf "${BUNDLE_DIR}/uploads.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"

log "Copying openestate.env (holds the PAN/TOTP/plugin encryption keys)..."
cp "$ENV_FILE" "${BUNDLE_DIR}/openestate.env"
chmod 600 "${BUNDLE_DIR}/openestate.env"

mv -T -n "$BUNDLE_DIR" "$FINAL_DIR"
{ [ -d "$FINAL_DIR" ] && [ ! -L "$FINAL_DIR" ] && [ ! -e "$BUNDLE_DIR" ]; } \
  || die "Could not rename ${BUNDLE_DIR} to ${FINAL_DIR}. The backup is complete but still under its work name."
BUNDLE_DIR="$FINAL_DIR"
log "Backup complete: ${BUNDLE_DIR}"
log "This bundle includes live secrets (openestate.env) — store it as securely as the database itself."
