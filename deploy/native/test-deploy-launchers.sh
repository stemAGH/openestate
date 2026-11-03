#!/usr/bin/env bash
# Tests run_api_deploy() and verify_launchers() (deploy/native/lib.sh), which
# build_release() uses around `pnpm deploy`: the deploy command's exit status is
# never masked, the deployed .bin/prisma and .bin/tsx launchers must exist, be
# executable and run, and only then is pnpm's known transient warning for the
# real release's .bin/prisma hidden. Uses a fake deploy command and fake
# launchers in a throwaway directory; needs only bash and coreutils.
#
#   bash deploy/native/test-deploy-launchers.sh
#
# Mutation checks (each must make this test fail):
#   DEPLOY_LAUNCHERS_IMPL=old         the pipeline used until v0.8.5
#   DEPLOY_LAUNCHERS_IMPL=novalidate  launcher checks removed
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }

# shellcheck source=lib.sh
source "$HERE/lib.sh"

case "${DEPLOY_LAUNCHERS_IMPL:-}" in
  old)
    # build_release's deploy line until v0.8.5: hide only the stray tree's
    # lines, check nothing, and take awk's exit status, not pnpm's.
    run_api_deploy() {
      local hide="Failed to create bin at ${2}/node_modules/.bin/"
      shift 2
      "$@" 2>&1 | awk -v h="$hide" 'index($0, h) == 0'
    }
    ;;
  novalidate)
    verify_launchers() { return 0; }
    ;;
esac

API="$TMP/opt/openestate/releases/20261103073419-412430b/api"
STRAY="$TMP/opt/openestate-src/apps/openestate/releases/20261103073419-412430b/api"
BIN="$API/node_modules/.bin"
REAL_WARN=" WARN  Failed to create bin at ${BIN}/prisma. ENOENT: no such file or directory, chmod '${BIN}/prisma'"

# launcher NAME [STATUS]: a fake launcher that answers --version and exits STATUS.
launcher() { mkdir -p "$BIN" && printf '#!/bin/sh\necho "%s 1.0.0"\nexit %s\n' "$1" "${2:-0}" > "$BIN/$1" && chmod +x "$BIN/$1"; }
reset() { rm -rf "$TMP/opt" "$TMP/work" && mkdir -p "$TMP/work" && launcher prisma && launcher tsx; }

# fake_deploy STATUS LINE...: prints each LINE (half to stderr) and exits STATUS.
fake_deploy() {
  local status="$1" i=0 l
  shift
  for l in "$@"; do
    if [ $((i % 2)) -eq 0 ]; then printf '%s\n' "$l"; else printf '%s\n' "$l" >&2; fi
    i=$((i + 1))
  done
  return "$status"
}

# run STATUS LINE...: runs run_api_deploy with fake_deploy; sets RC and OUT.
run() { OUT="$(cd "$TMP/work" && TMPDIR="$TMP/work" run_api_deploy "$API" "$STRAY" fake_deploy "$@" 2>&1)"; RC=$?; }
has()  { case "$OUT" in *"$2"*) ok "$1";; *) bad "$1 (missing: $2)";; esac; }
hasnt() { case "$OUT" in *"$2"*) bad "$1 (should not show: $2)";; *) ok "$1";; esac; }
rc0()  { [ "$RC" -eq 0 ] && ok "$1" || bad "$1 (exit $RC)"; }
rcN()  { [ "$RC" -ne 0 ] && ok "$1" || bad "$1 (exit 0)"; }
VERIFIED="Deployed launchers verified: prisma, tsx"

# A. Both launchers exist, are executable and run.
reset; run 0 "Progress: done"
rc0 "A: good launchers, clean deploy: succeeds"; has "A: says the launchers were verified" "$VERIFIED"; has "A: deploy output still shown" "Progress: done"

# B. Missing prisma.
reset; rm "$BIN/prisma"; run 0 "Progress: done"
rcN "B: missing prisma: fails"; has "B: names prisma" ".bin/prisma"; hasnt "B: no verified message" "$VERIFIED"

# C. Missing tsx (a failed seed is only a warning in install-native.sh).
reset; rm "$BIN/tsx"; run 0 "Progress: done"
rcN "C: missing tsx: fails"; has "C: names tsx" ".bin/tsx"

# D. Launcher not executable.
reset; chmod -x "$BIN/prisma"; run 0 "Progress: done"
rcN "D: non-executable prisma: fails"; has "D: says not executable" "not executable"

# E. Launcher exits non-zero on --version.
reset; launcher tsx 3; run 0 "Progress: done"
rcN "E: tsx --version exits 3: fails"; has "E: says it did not run" "did not run"

# F. The known real-release prisma warning is hidden only once the launchers pass.
reset; run 0 "$REAL_WARN" "Progress: done"
rc0 "F: known warning, good launchers: succeeds"; hasnt "F: known warning hidden" "Failed to create bin"
has "F: explains the hidden warning" "transient launcher warning"; has "F: verified" "$VERIFIED"
reset; rm "$BIN/prisma"; run 0 "$REAL_WARN"
rcN "F: known warning, prisma really missing: fails"; has "F: warning kept when the check fails" "Failed to create bin at ${BIN}/prisma"

# G. A warning for another launcher is not hidden.
reset; run 0 " WARN  Failed to create bin at ${BIN}/tsx. ENOENT: no such file or directory, chmod '${BIN}/tsx'"
has "G: tsx warning shown" "Failed to create bin at ${BIN}/tsx"

# H. A prisma warning at an unexpected path is not hidden.
reset; run 0 " WARN  Failed to create bin at /somewhere/else/node_modules/.bin/prisma. ENOENT: no such file or directory, chmod '/somewhere/else/node_modules/.bin/prisma'"
has "H: prisma warning elsewhere shown" "/somewhere/else/node_modules/.bin/prisma"
reset; run 0 " WARN  Failed to create bin at ${BIN}/prisma. EACCES: permission denied, chmod '${BIN}/prisma'"
has "H: a different error for the real prisma shown" "EACCES"

# I. Other pnpm warnings and errors stay visible.
reset; run 0 " WARN  7 deprecated subdependencies found: glob@7.2.3" " ERR_PNPM_SOMETHING  it went wrong"
has "I: other warning shown" "7 deprecated subdependencies"; has "I: pnpm error text shown" "ERR_PNPM_SOMETHING"

# J. A failing deploy fails, even when its only warning is the allowed one.
reset; run 1 "$REAL_WARN"
rcN "J: deploy exits 1: fails"; has "J: output kept on failure" "Failed to create bin at ${BIN}/prisma"; hasnt "J: no verified message" "$VERIFIED"

# K. The stray tree's warnings are still hidden, and only those.
reset; run 0 " WARN  Failed to create bin at ${STRAY}/node_modules/.bin/vite. ENOENT: no such file or directory, chmod '${STRAY}/node_modules/.bin/vite'" "Progress: done"
rc0 "K: stray-tree warning: succeeds"; hasnt "K: stray-tree warning hidden" "Failed to create bin"; has "K: other output kept" "Progress: done"

# L. A failed check never looks like a built release, and leaves no temp files.
reset; rm "$BIN/tsx"; run 0 "$REAL_WARN" "Progress: done"
rcN "L: failed check returns non-zero"; hasnt "L: no verified message" "$VERIFIED"
LEFT="$(find "$TMP/work" -mindepth 1 | wc -l)"
[ "$LEFT" -eq 0 ] && ok "L: no temporary files left behind" || bad "L: ${LEFT} temporary file(s) left in TMPDIR"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
