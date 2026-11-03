#!/usr/bin/env bash
# Tests that backup-native.sh writes private bundles and that restore-native.sh
# can still load a root-only dump. Uses copies of the real scripts in a
# throwaway directory, with fake pg_dump, date, sudo, psql and systemctl on
# PATH; needs only bash and coreutils. The fake `sudo -u postgres` refuses to
# open a file named on its command line unless "other" may read it, which is
# what happens to the real postgres OS user with a root-owned mode-600 dump.
#
#   bash deploy/native/test-backup-permissions.sh
#
# Mutation checks (each must make this test fail):
#   BACKUP_PERMS_IMPL=old           the backup and restore steps used until v0.9
#   BACKUP_PERMS_IMPL=old-restore   the private backup with the old restore
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'chmod -R u+rwX "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }
mode() { stat -c '%a' "$1" 2>/dev/null || echo missing; }
is_mode() { [ "$(mode "$2")" = "$3" ] && ok "$1" || bad "$1 (mode $(mode "$2"), want $3)"; }

# The scripts under test, copied next to their lib.sh; setup-database.sh is a
# stub (role setup is not what is tested here).
N="$TMP/native"
mkdir -p "$N"
cp "$HERE/backup-native.sh" "$HERE/restore-native.sh" "$HERE/lib.sh" "$N/"
printf '#!/usr/bin/env bash\nexit 0\n' > "$N/setup-database.sh"
case "${BACKUP_PERMS_IMPL:-}" in old) sed -i -e '/^umask 077/d' "$N/backup-native.sh" ;; esac
if [ -n "${BACKUP_PERMS_IMPL:-}" ]; then
  # Until v0.9 the restore told psql (as the postgres user) to open the dump.
  sed -i -e 's#psql_admin -d "$DB_NAME" < "${BUNDLE_DIR}/db.sql"#psql_admin -d "$DB_NAME" -f "${BUNDLE_DIR}/db.sql"#' "$N/restore-native.sh"
fi
chmod +x "$N"/*.sh

# Fakes.
B="$TMP/bin"
mkdir -p "$B"
cat > "$B/pg_dump" <<'EOF'
#!/usr/bin/env bash
printf -- '-- synthetic dump\nCREATE TABLE t (v text);\n'
[ -z "${FAIL_PG_DUMP:-}" ] || { echo "pg_dump: connection refused" >&2; exit 1; }
printf -- '-- end\n'
EOF
cat > "$B/date" <<'EOF'
#!/usr/bin/env bash
case "$*" in *'%Y%m%d-%H%M%S'*) echo "${FAKE_TS:-20260101-000000}" ;; *) exec /bin/date "$@" ;; esac
EOF
cat > "$B/sudo" <<'EOF'
#!/usr/bin/env bash
# sudo -u postgres CMD...: as another OS user, a file named after -f must be
# readable by "other".
[ "$1" = "-u" ] && shift 2
prev=""
for a in "$@"; do
  if [ "$prev" = "-f" ] && [ -e "$a" ] && [ $(( 0$(stat -c '%a' "$a") & 4 )) -eq 0 ]; then
    echo "psql: error: $a: Permission denied" >&2; exit 2
  fi
  prev="$a"
done
exec "$@"
EOF
cat > "$B/psql" <<'EOF'
#!/usr/bin/env bash
# The load step (-d DB): from -f FILE if given, else standard input.
file=""; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && file="$a"; prev="$a"; done
case " $* " in *" -d "*) if [ -n "$file" ]; then cat "$file"; else cat; fi > "$PSQL_LOG" ;; esac
exit 0
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$B/systemctl"
chmod +x "$B"/*
export PATH="$B:$PATH" PSQL_LOG="$TMP/psql-input"

ENVF="$TMP/openestate.env"
printf 'DATABASE_URL=postgresql://u:p@localhost/openestate\nDATABASE_URL_SYSTEM=postgresql://s:p@localhost/openestate\n' > "$ENVF"
chmod 640 "$ENVF"
UP="$TMP/data/uploads"
mkdir -p "$UP" && echo "synthetic upload" > "$UP/a.txt"

# backup OUTPUT_DIR [extra args]: runs the backup under the usual root umask.
backup() { local out="$1"; shift; OUT="$( (umask 022; "$N/backup-native.sh" --output "$out" --env-file "$ENVF" --uploads-dir "$UP" "$@") 2>&1)"; RC=$?; }

# 1-5: a new bundle in a new default-style output directory.
O="$TMP/backups/openestate"
backup "$O"
[ "$RC" -eq 0 ] && ok "backup succeeds" || bad "backup succeeds (exit $RC: $OUT)"
D="$O/20260101-000000"
is_mode "1: db.sql is private"            "$D/db.sql" 600
is_mode "2: uploads.tar.gz is private"     "$D/uploads.tar.gz" 600
is_mode "3: openestate.env is private"     "$D/openestate.env" 600
is_mode "4: the bundle directory is private" "$D" 700
is_mode "5: a new output directory is private" "$O" 700
[ "$(cat "$D/db.sql")" = "$(pg_dump x)" ] && ok "the dump is unchanged" || bad "the dump is unchanged"
tar -tzf "$D/uploads.tar.gz" | grep -q 'uploads/a.txt' && ok "the uploads archive is unchanged" || bad "the uploads archive lists uploads/a.txt"
[ -z "$(find "$O" -name '*.incomplete')" ] && ok "no incomplete bundle left after success" || bad "an .incomplete bundle was left after success"

# 6, 8: an existing --output directory keeps its own mode; the bundle in it is private.
for m in 755 750 700 1777; do
  C="$TMP/custom-$m"; mkdir -p "$C"; chmod "$m" "$C"
  FAKE_TS="20260101-00000${#m}" backup "$C"
  is_mode "6/8: existing --output ${m} is left as ${m}" "$C" "$m"
  is_mode "6: the bundle inside --output ${m} is private" "$C/20260101-00000${#m}" 700
done

# 9: a path already at the bundle's place is refused and never written through.
V="$TMP/victim"; mkdir -p "$V"; chmod 755 "$V"
S="$TMP/symlinked"; mkdir -p "$S"
ln -s "$V" "$S/20260101-000009"
FAKE_TS=20260101-000009 backup "$S"
[ "$RC" -ne 0 ] && ok "9: a symlink at the bundle path: refused" || bad "9: a symlink at the bundle path: refused"
[ -z "$(ls -A "$V")" ] && [ "$(mode "$V")" = 755 ] && ok "9: the symlink's target is untouched" || bad "9: the symlink's target was written to or changed ($(ls -A "$V") mode $(mode "$V"))"
mkdir -p "$S/20260101-000008"; echo keep > "$S/20260101-000008/db.sql"
FAKE_TS=20260101-000008 backup "$S"
[ "$RC" -ne 0 ] && ok "9: an existing bundle directory: refused" || bad "9: an existing bundle directory: refused"
[ "$(cat "$S/20260101-000008/db.sql")" = keep ] && ok "9: the existing bundle is not overwritten" || bad "9: the existing bundle was overwritten"
ln -s "$V" "$S/20260101-000007.incomplete"
FAKE_TS=20260101-000007 backup "$S"
[ "$RC" -ne 0 ] && [ -z "$(ls -A "$V")" ] && ok "9: a symlink at the work path: refused, target untouched" || bad "9: a symlink at the work path was followed"

# 10: a failed dump fails the backup and leaves nothing that looks like a bundle.
F="$TMP/failing"
FAIL_PG_DUMP=1 FAKE_TS=20260101-000010 backup "$F"
[ "$RC" -ne 0 ] && ok "10: a failed dump fails the backup" || bad "10: a failed dump fails the backup"
[ ! -e "$F/20260101-000010" ] && ok "10: no bundle directory under the final name" || bad "10: a failed backup left $F/20260101-000010"
case "$OUT" in *"Backup complete"*) bad "10: a failed backup said it completed" ;; *) ok "10: a failed backup does not say it completed" ;; esac
rm -rf "$UP.missing"
FAKE_TS=20260101-000011 OUT="$( (umask 022; "$N/backup-native.sh" --output "$F" --env-file "$ENVF" --uploads-dir "$UP.missing") 2>&1)"; RC=$?
[ "$RC" -ne 0 ] && [ ! -e "$F/20260101-000011" ] && ok "10: missing uploads fails, no bundle" || bad "10: missing uploads (exit $RC)"

# 7: restore loads a root-only dump without the postgres user opening it.
: > "$PSQL_LOG"
R="$(printf 'openestate\n' | "$N/restore-native.sh" --force "$D" --env-file "$ENVF" --uploads-dir "$TMP/restored/uploads" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok "7: restore of a mode-600 dump succeeds" || bad "7: restore of a mode-600 dump (exit $RC: $(printf '%s' "$R" | tail -2))"
cmp -s "$PSQL_LOG" "$D/db.sql" && ok "7: psql received the exact dump" || bad "7: psql did not receive the dump"
[ "$(cat "$TMP/restored/uploads/a.txt" 2>/dev/null)" = "synthetic upload" ] && ok "7: uploads restored" || bad "7: uploads restored"
is_mode "7: restore leaves the bundle private" "$D/db.sql" 600
R="$(printf 'wrong\n' | "$N/restore-native.sh" --force "$D" --env-file "$ENVF" 2>&1)"; RC=$?
[ "$RC" -ne 0 ] && ok "7: restore still needs the database name typed" || bad "7: restore ran without the confirmation"
R="$("$N/restore-native.sh" "$D" --env-file "$ENVF" < /dev/null 2>&1)"; RC=$?
[ "$RC" -ne 0 ] && ok "7: restore still needs --force" || bad "7: restore ran without --force"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
