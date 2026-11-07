#!/usr/bin/env bash
# Read-only report: interest accrued against installments whose label
# suggests a construction/handover stage (Excavation, Plinth,
# Superstructure, Finishing, On Possession, etc.) that predates the
# construction-linked-demand-fix release. See CHANGELOG.md's "Fixed"
# entry for that release — this script is the concrete query it
# references by name.
#
# Every payment-plan milestone used to get a real due date at booking
# time regardless of what it represented, so interest could accrue
# against a construction stage the builder had never actually reached.
# The fix stops this going forward (STAGE_LINKED installments have no
# due date, and therefore no possible accrual, until a stage is raised)
# but does NOT retroactively reverse interest already posted — that is a
# business decision only a human reviewing the specific booking can
# make. This script only lists candidates for that review; it never
# writes anything.
#
# WHY A LABEL HEURISTIC, NOT AN EXACT QUERY: the pre-fix schema never
# captured milestone intent. Installment.milestone_type exists now, but
# every row created BEFORE this migration — including ones that are
# conceptually construction-linked — was backfilled to the column's
# default, DATE_LINKED (correctly: the migration can't retroactively
# know what an old row "meant to be" any more than a human glancing at
# the schema could). The only surviving signal is the label text a
# human typed or a template generated at instantiation time. This
# matches installments.label directly (not payment_plan_milestones.label)
# so it also catches custom (non-template) plans, whose installments
# have no source milestone row to join against at all.
#
# DELIBERATELY EXCLUDES "possession": On Possession is STAGE_LINKED in
# the new model (see internal plan construction-linked-demand-fix.md §5),
# but "On Possession" is also the generic, unaffected, always-DATE_LINKED
# terminal milestone of plans like Down Payment Plan. Matching that
# label would flood this report with installments that were never
# affected by the bug. If your install has its own construction-linked
# templates using a distinct label for the possession/handover
# milestone (not literally "On Possession"), add it to --extra-terms.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ENV_FILE="/etc/openestate/openestate.env"
FORMAT="table"
EXTRA_TERMS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --csv) FORMAT="csv"; shift ;;
    --extra-terms) EXTRA_TERMS="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: sudo ./find-stage-suspect-interest.sh [options]

Read-only. Lists interest_accrual rows against installments whose label
suggests a construction stage, grouped by installment, with the booking
number, installment label, total accrued amount, and the date interest
started accruing against that installment (earliest accrual period start).

  --env-file PATH     Default: /etc/openestate/openestate.env
  --csv               Output CSV instead of an aligned table
  --extra-terms REGEX Additional installment-label pattern to OR into the
                       match (POSIX regex, case-insensitive), e.g. for a
                       custom template's own stage-milestone labels.
USAGE
      exit 0
      ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[ -f "$ENV_FILE" ] || die "${ENV_FILE} not found. Pass --env-file if it lives elsewhere."
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
[ -n "${DATABASE_URL_SYSTEM:-}" ] || die "DATABASE_URL_SYSTEM not set in ${ENV_FILE}."
command -v psql >/dev/null 2>&1 || die "psql client not found. Install it: sudo apt-get install -y postgresql-client"

TERM_PATTERN='(stage|slab|plinth|excavation|superstructure|finishing|structure)'
if [ -n "$EXTRA_TERMS" ]; then
  TERM_PATTERN="${TERM_PATTERN}|(${EXTRA_TERMS})"
fi

# openestate_system (BYPASSRLS) so this sees every company on a
# multi-tenant install, same role backup-native.sh dumps with — SELECT
# only, no write privilege is exercised or needed.
QUERY="
SELECT
  c.name                                            AS company,
  b.booking_number                                  AS booking_number,
  i.label                                            AS installment_label,
  to_char(SUM(ia.accrued_paise)::numeric / 100, 'FM999,999,999,990.00') AS total_accrued_inr,
  MIN(ia.period_start)                               AS interest_started_on,
  COUNT(*)                                           AS accrual_rows
FROM interest_accruals ia
JOIN installments i ON i.id = ia.installment_id
JOIN bookings b      ON b.id = ia.booking_id
JOIN companies c     ON c.id = ia.company_id
WHERE i.label ~* '${TERM_PATTERN}'
GROUP BY c.name, b.booking_number, i.label
ORDER BY c.name, b.booking_number, MIN(ia.period_start);
"

if [ "$FORMAT" = "csv" ]; then
  psql "$DATABASE_URL_SYSTEM" -v ON_ERROR_STOP=1 -P pager=off --csv -c "$QUERY"
else
  psql "$DATABASE_URL_SYSTEM" -v ON_ERROR_STOP=1 -P pager=off -c "$QUERY"
fi
