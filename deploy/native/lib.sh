#!/usr/bin/env bash
# Shared helpers for the deploy/native/*.sh scripts. Sourced, not executed.

log()  { printf '\033[1;32m[openestate]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[openestate]\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m[openestate]\033[0m %s\n' "$1" >&2; exit 1; }

rand_secret() {
  # 48 bytes -> 64 base64 chars, url-safe, no padding noise.
  openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48
}
rand_hex_32() {
  # 32 bytes -> 64 hex chars for AES-256-GCM encryption keys.
  openssl rand -hex 32
}

# switch_moved_origin SRC_DIR
#
# The project lives at github.com/stemAGH/openestate. A source folder whose
# origin still uses the repository's previous address (https or ssh, with or
# without .git, any letter case) is switched to the new one, keeping its
# protocol, so upgrades don't depend on GitHub's redirect. Any other origin (a
# fork, a mirror) is left alone.
switch_moved_origin() {
  local src_dir="$1" url lower new
  url="$(cd "$src_dir" && git remote get-url origin 2>/dev/null)" || return 0
  lower="$(printf '%s' "$url" | tr '[:upper:]' '[:lower:]')"
  # previous owner name of this repository
  printf '%s' "$lower" | grep -Eq '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)ashishgth/openestate(\.git|/)?$' || return 0
  case "$lower" in
    https://*) new="https://github.com/stemAGH/openestate.git" ;;
    *)         new="git@github.com:stemAGH/openestate.git" ;;
  esac
  (cd "$src_dir" && git remote set-url origin "$new") \
    || die "Could not change the source folder's origin from ${url} to ${new}. Nothing was changed and the previous release is still running. Run: git -C ${src_dir} remote set-url origin ${new}"
  log "The project's address changed: origin in ${src_dir} switched from ${url} to ${new}."
}

# checkout_ref SRC_DIR REF
#
# Fetches exactly REF (a tag, branch or commit) from origin and checks it out,
# detached. Never `git fetch --tags`: a clone made before the history rewrite
# holds tags (v0.1.0 to v0.7.1) that point at old commits, git refuses to
# overwrite them ("would clobber existing tag"), and under `set -e` the old
# one-liner then stopped the whole upgrade without printing a word. A tag is
# fetched with a forced refspec for that one name only; anything else is
# fetched plainly. Any failure stops the upgrade here, in plain English, before
# anything is built or changed.
checkout_ref() {
  local src_dir="$1" ref="$2" out fetched
  if out="$(cd "$src_dir" && git fetch --force --no-tags origin "+refs/tags/${ref}:refs/tags/${ref}" 2>&1)"; then
    fetched="$(cd "$src_dir" && git rev-parse "refs/tags/${ref}^{commit}")"
    if ! out="$(cd "$src_dir" && git checkout --quiet --detach "refs/tags/${ref}" 2>&1)"; then
      die "Could not switch to version '${ref}' after downloading it. git said: ${out}. Nothing was changed and the previous release is still running. If you edited files in ${src_dir}, undo or save those edits and run the upgrade again."
    fi
  elif out="$(cd "$src_dir" && git fetch --force --no-tags origin "$ref" 2>&1)"; then
    fetched="$(cd "$src_dir" && git rev-parse "FETCH_HEAD^{commit}")"
    if ! out="$(cd "$src_dir" && git checkout --quiet --detach FETCH_HEAD 2>&1)"; then
      die "Could not switch to '${ref}' after downloading it. git said: ${out}. Nothing was changed and the previous release is still running. If you edited files in ${src_dir}, undo or save those edits and run the upgrade again."
    fi
  else
    die "Could not download '${ref}' from the source repository. git said: ${out}. Nothing was changed and the previous release is still running. Check that this server can reach the internet (and the remote named 'origin' in ${src_dir}) and that the version name is spelled exactly as published, then run the upgrade again."
  fi
  # v0.8.4 Part N: what is checked out must be exactly what was downloaded.
  local head
  head="$(cd "$src_dir" && git rev-parse HEAD)"
  if [ "$head" != "$fetched" ]; then
    die "After downloading '${ref}' (commit ${fetched}), the source folder ${src_dir} is at a different commit (${head}). Nothing was built or changed and the previous release is still running. Check ${src_dir} for local changes or git hooks, then run the upgrade again."
  fi
  log "Deploying ${head} (${ref})"
}

# version_is_older A B: true when version A (x.y.z, optionally -suffix) is
# older than B. A version with a suffix (0.9.0-rc1) is older than the plain
# release of the same number, which `sort -V` gets wrong.
version_is_older() {
  node -e '
    const p = (v) => { const [n, pre] = String(v).trim().split("-", 2); return { n: n.split(".").map(Number), pre }; };
    const a = p(process.argv[1]), b = p(process.argv[2]);
    for (let i = 0; i < 3; i++) if ((a.n[i] || 0) !== (b.n[i] || 0)) process.exit((a.n[i] || 0) < (b.n[i] || 0) ? 0 : 1);
    if (a.pre && !b.pre) process.exit(0);
    if (a.pre && b.pre && a.pre < b.pre) process.exit(0);
    process.exit(1);
  ' "$1" "$2"
}

# previous_release_tag REPO_DIR: prints the newest v* tag whose version is
# strictly lower than the root package.json version at REPO_DIR's HEAD, using
# version_is_older. Used by CI's upgrade-from-previous-release job: after a
# release, a commit that still carries that release's version must start from
# the release before it, not from the release's own tag. Fails, saying why,
# when no lower tag exists.
previous_release_tag() {
  local repo="$1" head_v t v best="" best_v=""
  head_v="$(cd "$repo" && git show HEAD:package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')" \
    || { echo "Could not read the version from package.json at HEAD in ${repo}." >&2; return 1; }
  for t in $(cd "$repo" && git tag -l 'v*'); do
    v="${t#v}"
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || continue
    version_is_older "$v" "$head_v" || continue
    if [ -z "$best" ] || version_is_older "$best_v" "$v"; then best="$t"; best_v="$v"; fi
  done
  [ -n "$best" ] || { echo "No release tag has a version lower than ${head_v} (the version at HEAD in ${repo})." >&2; return 1; }
  printf '%s\n' "$best"
}

# release_tag_before_migration REPO_DIR MIGRATION: prints the newest v* tag,
# with a version lower than HEAD's, whose tree has no folder for MIGRATION. Used
# by CI's upgrade variants that exercise one migration's failure and recovery: the
# upgrade must cross that migration, so it starts from the last release without
# it rather than from the previous release (which may already contain it, or
# whose upgrade may have no migrations at all). Fails, saying why, when HEAD has
# no such migration or no lower tag lacks it.
release_tag_before_migration() {
  local repo="$1" mig="$2" dir="packages/db/prisma/migrations" head_v t v best="" best_v=""
  head_v="$(cd "$repo" && git show HEAD:package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')" \
    || { echo "Could not read the version from package.json at HEAD in ${repo}." >&2; return 1; }
  (cd "$repo" && git cat-file -e "HEAD:${dir}/${mig}" 2>/dev/null) \
    || { echo "HEAD in ${repo} has no migration ${mig}, so a scenario that exercises it cannot run." >&2; return 1; }
  for t in $(cd "$repo" && git tag -l 'v*'); do
    v="${t#v}"
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || continue
    version_is_older "$v" "$head_v" || continue
    (cd "$repo" && git cat-file -e "${t}:${dir}/${mig}" 2>/dev/null) && continue
    if [ -z "$best" ] || version_is_older "$best_v" "$v"; then best="$t"; best_v="$v"; fi
  done
  [ -n "$best" ] || { echo "No release tag lower than ${head_v} lacks migration ${mig}, so there is no release to upgrade across it from." >&2; return 1; }
  printf '%s\n' "$best"
}

# migrations_not_in MIGRATIONS_DIR: reads applied migration names on stdin and
# prints each one that has no folder in MIGRATIONS_DIR.
migrations_not_in() {
  local dir="$1" name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ -d "${dir}/${name}" ] || printf '%s\n' "$name"
  done
}

# guard_upgrade SRC_DIR RUNNING_RELEASE_DIR APPLIED_MIGRATIONS
#
# v0.8.4 Part N. Returns non-zero, with a plain message on stderr, when the
# checked-out code would be older than what runs now: an older version number,
# or a database that already has migrations this checkout does not contain.
# There is deliberately no override: going back means restoring a backup.
guard_upgrade() {
  local src="$1" running="$2" applied="$3" target current extra
  target="$(node -p 'require(process.argv[1]).version' "${src}/apps/api/package.json")"
  if [ -f "${running}/api/package.json" ]; then
    current="$(node -p 'require(process.argv[1]).version' "${running}/api/package.json")"
    if version_is_older "$target" "$current"; then
      printf '%s\n' "This would install version ${target}, but this server runs ${current}. An upgrade cannot go back to an older version. Nothing was changed and ${current} is still running. To return to an older version, restore the backup taken before your last upgrade (restore-native.sh), or give the release tag of ${current} or newer." >&2
      return 1
    fi
  fi
  extra="$(printf '%s\n' "$applied" | migrations_not_in "${src}/packages/db/prisma/migrations")"
  if [ -n "$extra" ]; then
    printf '%s\n' "The database already has these changes, which version ${target} does not contain:" >&2
    printf '  %s\n' $extra >&2
    printf '%s\n' "Installing ${target} would run older code against a newer database. Nothing was changed and the current version is still running. Give a newer release tag that contains these changes, or restore the backup or snapshot taken before they were applied." >&2
    return 1
  fi
  return 0
}

# wait_for_health URL [max_tries]
wait_for_health() {
  local url="$1" tries=0 max="${2:-60}"
  until node -e "fetch('$url').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$max" ]; then
      return 1
    fi
    sleep 2
  done
  return 0
}

# build_release SRC_DIR RELEASES_DIR -> prints the new release dir path on stdout
#
# Builds and stages a release natively: pnpm build in dependency order,
# then `pnpm --filter @openestate/api deploy --prod`, then manually copying
# each workspace package's dist/ back in. That last step is not redundant:
# pnpm deploy's file selection follows git-tracked files, which excludes
# gitignored dist/ output, so every workspace dependency's dist has to be
# copied in by hand or the deployed API boots with missing modules. Also
# builds the two static frontends and regenerates the Prisma client in
# place.
build_release() {
  local src_dir="$1" releases_dir="$2"
  local release_id
  release_id="$(date -u +%Y%m%d%H%M%S)-$(cd "$src_dir" && git rev-parse --short HEAD 2>/dev/null || echo nogit)"
  local release_dir="${releases_dir}/${release_id}"

  # The whole block's stdout is redirected to stderr: build_release()'s
  # return value is the release path, returned via `$(build_release ...)`
  # command substitution — if pnpm/tsc/vite's own progress output went to
  # real stdout here, it would get captured as part of that return value
  # instead of the path, corrupting every later use of $RELEASE_DIR. This
  # keeps the build fully visible in the terminal while keeping stdout
  # clean for the one `printf` below that's the actual return channel.
  (
    cd "$src_dir" || exit 1
    # openestate.env (sourced by the caller before this runs, so the
    # deployed app gets NODE_ENV=production at runtime) must not leak into
    # the build: pnpm treats NODE_ENV=production as "skip devDependencies,"
    # which silently drops typescript/@nestjs/cli/vite — every `tsc`/`nest`
    # build command below then fails with "not found" instead of a clear
    # dependency error. NODE_ENV=production belongs on the *running*
    # service, never on the build that produces it.
    unset NODE_ENV
    log "Installing workspace dependencies..."
    pnpm install --frozen-lockfile

    log "Building packages in dependency order..."
    pnpm --filter @openestate/db generate
    pnpm --filter @openestate/shared build
    pnpm --filter @openestate/db build
    pnpm --filter @openestate/plugin-sdk build
    pnpm --filter @openestate/generic-sales build
    pnpm --filter @openestate/api build

    log "Building frontends (VITE_API_URL empty — same-origin via nginx)..."
    export VITE_API_URL=""
    pnpm --filter @openestate/web build
    pnpm --filter @openestate/portal build

    mkdir -p "$release_dir"

    log "Deploying API as a standalone production tree..."
    # pnpm 9 bug (seen with 9.15.0 and 9.15.9, the latest 9.x): when the deploy
    # target is outside the workspace, `pnpm deploy` links bins a second time
    # into the target path taken relative to the workspace root but resolved
    # from apps/api, a stray tree such as
    # /opt/openestate-src/apps/openestate/releases/<id>/api. It prints "Failed to
    # create bin at <stray>/node_modules/.bin/<name>" for the dev-only tools that
    # are not there (browserslist, webpack, vite, terser). The real release tree
    # is not affected. Hide exactly those lines and remove the stray tree.
    local rel stray hide tail
    rel="$(realpath -m --relative-to="$(pwd)" "${release_dir}/api")"
    stray="$(realpath -m "apps/api/${rel}")"
    hide="Failed to create bin at ${stray}/node_modules/.bin/"
    pnpm --filter @openestate/api deploy --prod "${release_dir}/api" 2>&1 \
      | awk -v h="$hide" 'index($0, h) == 0' || exit 1
    if [ "${rel#../}" != "$rel" ] && [ "$stray" != "$(realpath -m "${release_dir}/api")" ] && [ -d "$stray" ]; then
      # The stray tree mirrors the path below the common ancestor, ending in
      # this build's new release id, so nothing else can live in it. Its
      # parents are removed only if empty (pnpm created them).
      rm -rf "$stray"
      tail="$rel"
      while [ "${tail#../}" != "$tail" ]; do tail="${tail#../}"; done
      tail="$(dirname "$tail")"
      local dir; dir="$(dirname "$stray")"
      while [ "$tail" != "." ]; do
        rmdir "$dir" 2>/dev/null || break
        dir="$(dirname "$dir")"
        tail="$(dirname "$tail")"
      done
    fi

    # Workspace packages' built dist/ (gitignored, so pnpm deploy's
    # git-tracked-files selection skips them) copied back in at the same
    # relative path the deployed api's node_modules resolution expects.
    for pkg in packages/db packages/shared packages/plugin-sdk plugins/generic-sales; do
      mkdir -p "${release_dir}/api/${pkg}"
      cp -r "${pkg}/dist" "${release_dir}/api/${pkg}/dist"
      cp "${pkg}/package.json" "${release_dir}/api/${pkg}/package.json"
    done
    cp -r packages/db/prisma "${release_dir}/api/packages/db/prisma"

    # Prisma's generated query-engine client (node_modules/.prisma/, built
    # from schema.prisma) isn't carried over by `pnpm deploy` either — its
    # postinstall tries to auto-generate it but the schema isn't in place
    # in the deploy target yet at that point, so it silently no-ops
    # ("could not find your Prisma schema in the default locations").
    # Rather than copying the already-generated one out of $src_dir's own
    # pnpm store (fragile: it depends on the release's and the source's
    # pnpm virtual-store folder names matching exactly, which isn't
    # guaranteed — this broke in practice), just generate it fresh
    # in-place now that the schema is actually there. Source and release
    # share the same filesystem/pnpm content-addressable store, so this
    # is cheap (no new downloads) and unambiguous — no cross-directory
    # glob-matching required.
    "${release_dir}/api/node_modules/.bin/prisma" generate \
      --schema "${release_dir}/api/packages/db/prisma/schema.prisma"

    cp -r apps/web/dist "${release_dir}/web"
    cp -r apps/portal/dist "${release_dir}/portal"
  ) >&2
  local build_status=$?
  # Explicit check, not reliance on `set -e` propagating through this
  # subshell: build_release() is called as `x=$(build_release ...) || die`,
  # and bash disables errexit for commands whose exit status is itself
  # being tested (POSIX "commands run for their status aren't subject to
  # -e") — that suppression was observed to leak into this subshell too,
  # letting a failed build silently fall through to the `printf` below and
  # report success. Checking $? explicitly here doesn't depend on that.
  if [ "$build_status" -ne 0 ]; then
    return "$build_status"
  fi

  printf '%s' "$release_dir"
}

# Prints a plain-English block for any existing staff-surface-shaped problem
# the v0.8.2 trigger does not (and cannot) fix retroactively: users whose role
# is a portal role but who carry no applicant_id/broker_id link. Read-only,
# never fatal. A plain SELECT run by this script rather than a RAISE NOTICE
# in the migration, because nothing guarantees `prisma migrate deploy`
# forwards notices to the admin's terminal.
#
# Uses the same connection choices as upgrade-native.sh's run_as_superuser:
# DB_HOST (+ PG_SUPERUSER / PG_SUPERUSER_PASSWORD) for a remote database,
# otherwise the local `postgres` OS user over the Unix socket.
#
# OPENESTATE_DB_NAME overrides the database name (default openestate). A caller
# may set PGOPTIONS (for example to make the session read-only); it is passed
# through sudo explicitly because sudo resets the environment.
_findings_rows() {
  # $1 = SQL. Prints rows; prints __QUERY_FAILED__ if the query could not run.
  local db="${OPENESTATE_DB_NAME:-openestate}"
  if [ -n "${DB_HOST:-}" ]; then
    PGPASSWORD="${PG_SUPERUSER_PASSWORD:-}" psql -h "$DB_HOST" -U "${PG_SUPERUSER:-postgres}" -d "$db" -tAF ' | ' -c "$1" 2>/dev/null || echo "__QUERY_FAILED__"
  else
    sudo -u postgres env PGOPTIONS="${PGOPTIONS:-}" psql -d "$db" -tAF ' | ' -c "$1" 2>/dev/null || echo "__QUERY_FAILED__"
  fi
}

# v0.8.4: every foreign key the database has not validated, with how many rows
# point at a row that no longer exists ("orphans"). The v0.8.4 migrations add
# the 71 restored foreign keys NOT VALID and validate each one that has no
# orphans; a link with orphans stays NOT VALID (new and changed rows are still
# checked) and is listed here. Read-only: it only counts. Used by
# upgrade-native.sh after migrating and by check-foreign-keys.sh.
UNVALIDATED_FK_SQL="SELECT c.conrelid::regclass, a.attname, c.confrelid::regclass,
       (xpath('/row/k/text()', query_to_xml(format(
          'SELECT count(*) AS k FROM %s x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s p WHERE p.%I = x.%I)',
          c.conrelid::regclass, a.attname, c.confrelid::regclass, pa.attname, a.attname), false, true, '')))[1]::text,
       c.conname
  FROM pg_constraint c
  JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = c.conkey[1]
  JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
 WHERE c.contype = 'f' AND NOT c.convalidated
 ORDER BY 1, 2"

# Returns 0 if every foreign key is validated, 2 if some are not, 1 if the
# query could not run. Never changes anything.
print_unvalidated_foreign_keys() {
  local rows
  rows="$(_findings_rows "$UNVALIDATED_FK_SQL")"
  if [ "$rows" = "__QUERY_FAILED__" ]; then
    warn "Could not check for foreign keys that are not validated (non-fatal). Run deploy/native/check-foreign-keys.sh later."
    return 1
  fi
  if [ -z "$rows" ]; then
    log "Foreign keys: all validated."
    return 0
  fi
  warn "================================================================"
  warn "FINDING: these links between tables point, in some existing rows, at"
  warn "rows that no longer exist (\"orphans\"). New and changed rows are"
  warn "checked, but the database could not confirm the existing rows, so the"
  warn "link is marked NOT VALID. Nothing was changed or deleted, and the"
  warn "application works as before. Keep this list: fixing those rows needs a"
  warn "reviewed procedure, which is not part of this release."
  warn "  table | column | points to | orphan rows | constraint"
  printf '%s\n' "$rows" | while IFS= read -r line; do warn "  ${line}"; done
  warn "================================================================"
  return 2
}

print_post_migrate_findings() {
  local portal_sql="SELECT u.id, u.name, coalesce(u.email, u.phone, '-'), r.slug, u.is_active
                      FROM users u JOIN roles r ON r.id = u.role_id
                     WHERE r.is_portal AND u.applicant_id IS NULL AND u.broker_id IS NULL
                     ORDER BY u.created_at"
  # A NON-system role carrying the slug 'super_admin' is possible on installs
  # from before 0.8.2 whose company lacked the seeded row. v0.8.2 does not
  # treat such a role as super_admin (the seeded system role is identified by
  # isSystem + slug), so an admin should know it exists.
  local fake_sql="SELECT r.id, r.company_id, r.name, (SELECT count(*) FROM users u WHERE u.role_id = r.id)
                    FROM roles r WHERE r.slug = 'super_admin' AND NOT r.is_system ORDER BY r.created_at"
  # v0.8.4: only superusers should be able to use the append-only escape
  # hatch. Any non-superuser role that is a member of openestate_maintenance
  # (directly or through another role) can, so list them. No script grants
  # this membership; a row here means someone did it by hand.
  local maint_sql="SELECT rolname, rolcanlogin FROM pg_roles
                    WHERE NOT rolsuper AND rolname <> 'openestate_maintenance' AND rolname !~ '^pg_'
                      AND pg_has_role(oid, 'openestate_maintenance', 'MEMBER') ORDER BY rolname"
  local rows fake maint
  rows="$(_findings_rows "$portal_sql")"
  fake="$(_findings_rows "$fake_sql")"
  maint="$(_findings_rows "$maint_sql")"

  if [ "$rows" = "__QUERY_FAILED__" ] || [ "$fake" = "__QUERY_FAILED__" ] || [ "$maint" = "__QUERY_FAILED__" ]; then
    warn "Could not run the post-migration checks (non-fatal). Run them by hand in psql against the openestate database:"
    warn "  unlinked portal-role accounts: SELECT u.id, u.email, r.slug FROM users u JOIN roles r ON r.id=u.role_id WHERE r.is_portal AND u.applicant_id IS NULL AND u.broker_id IS NULL;"
    warn "  non-system roles named super_admin: SELECT id, company_id, name FROM roles WHERE slug='super_admin' AND NOT is_system;"
    warn "  non-superuser members of openestate_maintenance: SELECT rolname FROM pg_roles WHERE NOT rolsuper AND rolname <> 'openestate_maintenance' AND pg_has_role(oid, 'openestate_maintenance', 'MEMBER');"
    return 0
  fi

  if [ -z "$rows" ] && [ -z "$fake" ] && [ -z "$maint" ]; then
    log "Post-migration checks: no unlinked portal-role accounts, no non-system 'super_admin' roles, and no non-superuser members of openestate_maintenance found."
    return 0
  fi
  if [ -n "$maint" ]; then
    warn "================================================================"
    warn "FINDING: these database roles are members of openestate_maintenance,"
    warn "so they can change or delete append-only financial rows (ledger,"
    warn "receipt allocations, TDS, interest, commission ledger). Only the"
    warn "postgres superuser should be able to. No OpenEstate script grants"
    warn "this; remove it unless it was added on purpose:"
    warn "  REVOKE openestate_maintenance FROM <role>;"
    warn "  role | can log in"
    printf '%s\n' "$maint" | while IFS= read -r line; do warn "  ${line}"; done
    warn "================================================================"
  fi
  if [ -n "$rows" ]; then
    warn "================================================================"
    warn "FINDING: these accounts have a customer/broker (portal) role but no"
    warn "applicant or broker link. Before v0.8.2 such an account could sign in"
    warn "to the STAFF app; v0.8.2 refuses that, and the database now rejects"
    warn "creating or editing one. These existing rows were left untouched."
    warn "Review each in Admin -> Users, then deactivate it or give it a staff role."
    warn "  id | name | email-or-phone | role | active"
    printf '%s\n' "$rows" | while IFS= read -r line; do warn "  ${line}"; done
    warn "================================================================"
  fi
  if [ -n "$fake" ]; then
    warn "================================================================"
    warn "FINDING: these roles are named 'super_admin' but are NOT the seeded"
    warn "system role. v0.8.2 does not treat them as super_admin. Review who"
    warn "holds them in Admin -> Roles / Users."
    warn "  role id | company id | name | users holding it"
    printf '%s\n' "$fake" | while IFS= read -r line; do warn "  ${line}"; done
    warn "================================================================"
  fi
}
