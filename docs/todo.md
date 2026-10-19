# Deferred TODOs

Cross-phase follow-ups that were consciously deferred, with the phase where
they're expected to land. Each entry should say *what*, *why deferred*, and
*what unblocks it*.

## v0.9 "pilot readiness": what is planned

The top item comes first; the rest are each written up in their own entry below
(search the heading) and are not ordered.

1. **Delayed-payment interest can't be switched on for a booking** (next entry).
   Built on branch `v0.9-interest-rule`; waiting for the VM rehearsal from
   `v0.8.4-verified`.
2. **"Log out everywhere" should also end other devices' access tokens at once.**
3. **Which cookie the browser keeps after two overlapping refreshes.**
4. **Indexes on the 70 unindexed foreign-key columns** (in "Deferred from v0.8.4
   items A and G").
5. **The erasure CLI hard-delete tool (item Q)** (in "Erasure").
6. **Upgrades refresh the installed systemd unit.**
7. **Lint the root `scripts/` folder.**
8. **A fragile super_admin test.**
9. **Upgrade audit rows list permission keys; the Roles screen's list ids.**

## v0.9 TOP ITEM: delayed-payment interest can't be switched on for a booking

Found in the v0.8.4 VM rehearsal (2026-10-15). Interest rules can be set up
under Masters and `InterestService` accrues correctly, but nothing writes
`Booking.interestRuleId`: no DTO field, no service, no screen. Accrual skips a
booking without a rule, so no interest is ever charged, and the v0.8.4
installment/interest-rule refusals (the `ON DELETE RESTRICT` links) can't be
reached through the app. v0.8.4 states this as a known limitation. The fix
touches the frozen financial core (`Booking`, `BookingService`, the booking
wizard, and how a rule change affects accruals already posted), so it needs a
written plan and owner approval before any code. Decide with it: whether a rule
may be attached after booking, and whether changing it is allowed once interest
has been charged.

**Built (branch `v0.9-interest-rule`, 2026-10-16), to the owner's rulings:** a
rule can be attached at booking (the wizard requires a choice: a rule or "No
delay interest") or later (`PUT /bookings/:id/interest-rule`, permission
`postsales.interest.manage`); interest runs only from the attach date
(`bookings.interest_from_date`); a change or removal settles up to today under
the old rule first, and past interest is never recalculated; no rule is
attached on upgrade (the upgrade prints how many active bookings have none); a
rule in use can't be re-rated or deleted (`bookings_interest_rule_id_fkey` is
now `ON DELETE RESTRICT`); a transfer copies the rule from the transfer date.
Also fixed: two accrual runs at once double-posted a period, and the manual
accrue action charged interest on a cancelled booking. Remaining: the VM
rehearsal, then the release. Two notes for the release:

- `postsales.interest.manage` reaches existing `accounts` and `company_admin`
  roles only through the v0.8.4 seed baseline. An install that skips v0.8.4
  (v0.8.3 or older straight to v0.9) records its first baseline instead, adds
  nothing, and lists the key under "roles that differ from their defaults"; an
  admin grants it in Roles. Say so in the release notes.
- A user without the permission (a sales manager, by default) books without
  the interest choice; the wizard says Accounts sets it from the schedule.

## v0.9 follow-up: compounding waits for the CA

In v0.9 only SIMPLE interest rules can be attached to a booking (attaching a
COMPOUND rule is refused with a 409). `InterestRule.frequency` (DAILY,
MONTHLY, YEARLY) is stored but the accrual never reads it: a COMPOUND rule
would compound every time the daily job runs, which is not what any rule
says. Unblock with the CA's answers (compounding period, day count, whether
GST applies to interest, grace days, any RERA-prescribed rate such as SBI
MCLR + 2%), then make accrual honour `frequency` and lift the refusal in
`BookingInterestRuleService`, with tests against hand-computed figures.

## Follow-up: bookings created without the manage permission have no interest rule

Bookings created without the manage permission have no interest rule and
nothing flags them: add a visible 'No interest rule' marker or filter for
Accounts.

## Follow-up: bulk move bookings between interest rules

Not built (owner ruling j). A rule in use can't be re-rated, so a rate change
(an MCLR change, for example) means creating a new rule and moving each
booking to it with `PUT /bookings/:id/interest-rule`, one booking at a time.
A bulk action ("move every active booking on rule A to rule B from today")
would call the same per-booking change for each, so each booking still
settles up under its old rule, takes its own lock and gets its own audit row.
Needs a screen, a permission decision and a test that a failure part-way
leaves no booking half-moved.

## v0.9: upgrades never refresh the installed systemd unit

`install-native.sh` copies `deploy/native/systemd/openestate-api.service` to
`/etc/systemd/system/` and runs `systemctl daemon-reload`; `upgrade-native.sh`
does neither. A change to the unit in a later release (an environment setting,
a hardening option, a restart policy) never reaches an existing install. Seen
in the v0.8.4 rehearsal: the installed unit still carries the old Documentation
URL. Harmless so far, because no release has changed anything that matters in
the unit. Fix when a release first needs a unit change: copy it, reload, and
say so in the upgrade output.

## v0.8.4: items found during the v0.8.3 release

Each is written up, with its fix and tests, in
[`docs/testing/v0.8.3-plan.md`](testing/v0.8.3-plan.md) (the v0.8.4 parts):

- **Parts M, N, O, P and I: DONE, released in v0.8.4 (2026-10-15).**
  M: the API listens on 127.0.0.1 (API_HOST to change) and trusts only loopback
  proxies. N: the upgrade refuses an older version or a database ahead of the
  checkout. O: CI upgrades from the previous release tag with its own script
  (clean, orphan, lock-timeout). P: pnpm deploy's stray bin warnings hidden and
  the stray tree removed. I: system-role permission sync with a per-role seed
  baseline. The VM rehearsal from `v0.8.3-clean` passed on 2026-10-15 (snapshot
  `v0.8.4-rehearsal`); see CLAUDE.md's v0.8.4 rehearsal entry. The final check
  of the release commit also passed (snapshot `v0.8.4-verified`).

## Deferred from v0.8.4 items A and G (architect decisions, 2026-10-10)

- **A "reschedule an installment with interest charged" flow, after the CA
  review.** v0.8.4 restores `ledger_entries.installment_id`,
  `interest_accruals.installment_id` and `interest_accruals.interest_rule_id`
  as `ON DELETE RESTRICT`, so a payment-plan edit that would delete an unpaid
  installment with interest already charged is refused with a plain message
  instead of leaving dangling pointers. Staff then have no way to reschedule
  such an installment. The right accounting treatment (waive, carry the interest
  to the new installment, or something else) needs the CA review first.
- **No orphan-fix script.** v0.8.4 never changes or deletes rows: a foreign key
  whose column has orphans is added `NOT VALID` and reported. Fixing orphans in
  append-only tables needs the escape hatch (superuser only since v0.8.4) and a
  reviewed procedure; neither is built.
- **Indexes on the 70 unindexed foreign-key columns, v0.9.** Not needed for
  correctness or for validating the constraints (each check is a primary-key
  lookup on the parent). They matter only when a parent row is deleted or its key
  changes, which for most of these parents (users, masters) is rare.
- **DONE, released in v0.8.4 (2026-10-15):** Parts G, A and B, and the
  `forbid_unlinked_portal_role()` ownership fix (now owned by the NOLOGIN role
  `openestate_guard_owner`). M, N, O, P and I followed (see the top of this file).
- **A restored foreign key can be left NOT VALID on a real install** (orphan
  rows). The upgrade prints them and `deploy/native/check-foreign-keys.sh` lists
  them; nothing resolves them yet (see "No orphan-fix script" above). The scan
  was run on the verification VM before release and found none (all 71 links
  validated).

## CVE numbers are pending for two advisories

- **GHSA-gq5m-m6q6-x32p** (v0.8.3, published 2026-10-10): a CVE was requested
  while it was a draft, no number was assigned at publication, and it was
  re-requested on 2026-10-15.
- **GHSA-x58f-9wjq-rjgj** (v0.8.4, Low 3.3, published 2026-10-15): a CVE was
  requested at publication on 2026-10-15.

Re-check both around 2026-10-22 on the advisory pages
(https://github.com/stemAGH/openestate/security/advisories/GHSA-gq5m-m6q6-x32p and
https://github.com/stemAGH/openestate/security/advisories/GHSA-x58f-9wjq-rjgj);
re-request any that still have no number.

## Done (v0.8.4): the two flaky test races

DONE, released in v0.8.4 (2026-10-15). Both fixed at their cause, each shown by a
forced-interleaving test that failed 5 of 5 on the old code and passed 5 of 5
after the fix (CLAUDE.md, "Every writer of a user's refresh tokens takes the
per-user lock").

1. **`syncLeadStages` (`packages/db`).** The cause was not two syncs at once
   (only one test file calls it). Another test file's cleanup deleted its
   company's config, and with it the "already seeded" marker, after the sync
   had seeded that company; every later sync call then met six stages with no
   marker and failed with P2002 (CI log of the 2026-09-23 scheduled run). Fixed
   by an optional company scope the tests pass; the upgrade still runs it
   unscoped.
2. **The concurrent-refresh test (`apps/e2e`).** Rotation ran as separate
   statements with no lock, so a second refresh arriving between the revoke and
   the insert was refused and cleared the cookies. Now every write to a user's
   refresh tokens runs in one transaction under a per-user advisory lock.

## v0.9: "Log out everywhere" should also end other devices' access tokens at once

Today "Log out everywhere" (staff and portal) revokes every refresh token but
does not bump the session version, so an access token another device already
holds keeps working until it expires (up to 15 minutes). Every other
session-ending action bumps the version too (`TokenService.endSessions`). Make
log-out-everywhere use `endSessions` as well, keeping the calling session's own
behaviour (it signs out too), with a test that another device's access token is
refused on its next request.

## v0.9: lint the root `scripts/` folder

Nothing under `scripts/` is linted; ESLint finds 17 `no-undef` errors in the
two `.mjs` files (Node globals not configured).

`pnpm lint` runs `turbo run lint`, which only reaches workspace packages, so
nothing under the repo's root `scripts/` is linted: `scripts/lint-migration-drops.mjs`
and `scripts/ci/upgrade-scenario.mjs` (a CI gate and the CI upgrade driver), and
the shell scripts. Running ESLint on the folder by hand on 2026-10-15 gave 17
`no-undef` errors in those two `.mjs` files (Node globals such as `process` and
`console` aren't declared for them in `eslint.config.mjs`). Fix: add a Node-globals
block for `scripts/**/*.mjs` to the config and a root lint step (or turbo task)
that covers the folder, then fix what it finds.

## v0.9: a fragile super_admin test

The "no super_admin role at all" test fails whenever another test file has
created a super_admin role, because the super_admin sync is unscoped across the
shared test database. Likely fix: a scope parameter, as done for
`syncLeadStages`.

## v0.9: upgrade audit rows list permission keys; the Roles screen's list ids

The upgrade's `ROLE_PERMS_CHANGED` audit rows list permission keys, while the
Roles screen's rows list permission ids. Make them consistent.

## Direct database bumps of `users.authz_version` don't clear the session-version cache

Direct database bumps of `users.authz_version` (the upgrade sync,
`packages/db/prisma/sync-permissions.ts`) don't clear the Redis
session-version cache, so an old token can be accepted for up to 60s. Harmless
while the sync only adds permissions; any future step that removes access this
way must clear the cache. (The other direction was fixed in v0.9: a token newer
than the cache is checked against the database, so a refreshed session is no
longer signed out; found by PR #78's CI. `e2e-session-authz-version.test.ts`
pins both, the old-token window as a "known window" test.)

## v0.9: which cookie the browser keeps after two overlapping refreshes

Owner decision (v0.8.4): keep today's behaviour and log it. When two refreshes
overlap, both now succeed, but each sets a new cookie and the browser keeps the
one whose response arrives last. The second request rotates the first one's
token, so if the first response arrives last, the browser holds a revoked
token: it still works for 30 seconds (the grace window), and the next refresh
after that, typically 15 minutes later, signs the user out. With the lock the
second response is normally sent second, so this is rare. The full fix: in the
grace path, issue an extra token without revoking the live one, so either
cookie works. Needs its own design (more live tokens per family) and a
real-browser check on staff and portal.

## v0.8.3: `upgrade-native.sh` must survive diverged local tags and fail loudly

The first real `--ref` upgrade of a pre-rewrite clone (the maintainer VM, during
v0.8.2) stopped after the backup, silently: `git fetch --tags` (line 68, inside
`set -e`) rejected the 15 tags `v0.1.0`–`v0.7.1` ("would clobber existing tag"),
and the script printed nothing of its own. Every install cloned before the
history rewrite will hit this. Documented workaround (proven): `sudo git -C
/opt/openestate-src fetch --tags --force origin`. Fix in the script: fetch only
the requested ref with force (e.g. `git fetch --force origin
"refs/tags/$REF:refs/tags/$REF"`, or the equivalent for a branch or sha), and
print a clear error and what to do on any fetch failure instead of exiting
silently. Needs a CI test: a clone with a local tag that points somewhere else
than origin's, then `upgrade-native.sh --ref <tag>` must succeed. Assigned to
v0.8.3: **done (shipped in v0.8.3, Part J).** Note `fix/native-upgrade-ownership-and-stale-ref` (closed PR #44, never
merged, pre-rewrite history) reworked the same section; reuse ideas, not the
branch.

## UI offers actions the server then refuses (found in the v0.8.2 browser run)

The v0.8.2 server checks all held in a real browser, but the screens still
offer the actions first, and the refusal arrives as a toast. Hide or disable
them for the user who can't do them. Candidate UI-audit findings:

1. The Super Admin role page offers Edit, enabled permission tickboxes and
   Update Role, though its permissions are now immutable.
2. A user's own record offers the role dropdown, including Super Admin, and
   only then refuses ("You cannot change your own role").
3. The role editor lets a role holder tick permissions they don't hold.
4. For a non-super admin, a super_admin's page shows an enabled role dropdown,
   Update User and Generate reset link, and the Users list shows an enabled
   Deactivate on that row.
5. Reset 2FA is correctly disabled when 2FA is off, which means the server's
   refusal can't be exercised from the UI for such an account.
6. A refused save shows both a toast and an inline banner at the top of the
   Edit page; fine, but worth keeping consistent across forms.

## Erasure

- **Erasure: CLI hard-delete tool planned (item Q, target v0.9).** Questions
  for the CA and DPDP lawyer: legal retention periods for financial records, and
  when anonymising vs deleting is appropriate.
- Since v0.8.4, an applicant or broker who has a portal account cannot be
  hard-deleted through the app (owner accepted, 2026-10-10); item Q is the
  server-side way.

### Item Q plan: `deploy/native/erase.sh` (v0.9; recorded, not built)

**Shape.** A shell script run on the server; the database part runs as the
PostgreSQL superuser (`sudo -u postgres psql`, or `psql -h` with `--db-host`)
in ONE transaction with `SET LOCAL app.allow_financial_mutation = 'on'`. No API
route, no app code. The target is named by UUID together with its company; the
script first checks the target belongs to that company. Every statement filters
by that company explicitly (the superuser bypasses RLS).

**Decisions (architect and owner, 2026-10-10).**
- **Three modes.**
  - Default: REFUSE a target that has financial records (bookings, receipts,
    ledger, TDS, commissions, refunds, NOCs), listing them.
  - `--anonymise`: blank name, phone, email, PAN, addresses and document files;
    keep the ledger, bookings and amounts.
  - `--include-financial`: full delete, with a warning about tax-record
    retention and changed historical and GST reports.
- **Rows on other people's records** (a co-applicant row on someone else's
  booking; a broker attributed on other customers' bookings;
  `transfers.from_booking_id`): refused by default, listing the affected
  bookings; allowed only with `--include-financial`.
- **Audit log:** rows about the target are kept, with personal fields in
  before/after blanked.
- **Erasure log** keeps the target UUID (with who ran it, when, scope and
  counts per table; no names or phone numbers), so erasure can be re-applied
  after a restore from an older backup.
- **With `--include-financial`,** a unit whose current booking is deleted goes
  back to AVAILABLE, with a unit status-change record.
- **Build scope 1 (one applicant or broker) first;** scope 2 (a whole company)
  after.

**Always:** dry run by default (per-table counts and the files on disk under
`UPLOADS_DIR` that would go); a real run needs `--confirm` plus the target UUID
typed at a terminal (refused without one); `backup-native.sh` runs first and a
failed backup stops everything; the portal user is deleted before its applicant
or broker (the restored `users.applicant_id`/`broker_id` SET NULL would trip the
portal-link trigger); files are deleted after the commit and any that could not
be removed are reported.

**Docs:** backups keep the data until they age out, and restoring one brings
erased data back (re-run from the erasure log); consult a CA and lawyer; no
claim of legal compliance.

**Tests:** dry run changes nothing; a real run removes exactly the listed rows
and files and nothing else (another applicant, another company and the balances
of untouched bookings unchanged); a financial target is refused without a flag;
`--anonymise` keeps every amount; the app and system roles cannot run it; no
typed confirmation, no run; a failed backup deletes nothing. Every refusal
mutation-checked.

## `Failed to create bin ... ENOENT` warnings during upgrade builds

**DONE in v0.8.4 (part P).** Upgrades run with the v0.8.4 script no longer print
the warnings or add to the stray `apps/openestate` folder; confirmed on the VM on
2026-10-15. Folders left by earlier versions stay until the operator deletes
them. The text below is the original finding.

Every `upgrade-native.sh` build prints four pnpm warnings (browserslist,
webpack, vite and one more) of the form `Failed to create bin at
.../releases/<id>/api/node_modules/.bin/<name>. ENOENT`. Pre-existing: the
2026-09-17, -25 and -27 upgrade logs and the v0.8.2 rehearsal log all carry the
same four. Harmless so far (builds and health checks pass); likely devDependency
bins pnpm links in the deployed `api` tree that don't exist there. Find out
which and silence or fix it.

## Remove `SessionSurfaceGuard`'s pre-0.8.1-token fallback (v0.8.3)

**Done: shipped in v0.8.3 (Part L).** Original note:

The guard still infers a session's surface from `applicantId`/`brokerId` for
tokens issued before v0.8.1 had a `surface` claim. Removal is in
`docs/testing/v0.8.3-plan.md`. Not before 2026-10-04 (7 days after v0.8.1
shipped), and removing it forces a one-time re-login for any session older than
that and for any install that upgraded straight from v0.8.0.

## The privilege-misuse detection queries are not in the repo

The three read-only queries used for v0.8.2 (reset links and 2FA resets by an
actor lacking the target's permissions; user role changes, with self-changes
flagged; role-permission edits; plus a count of role-change/reset rows with no
actor) live in a script on the maintainer's machine and VM. Consider adding it
to `deploy/native/`. Its limits are real and belong in its header: it compares
against roles' current permissions, rows written before 0.7.1 have no actor, and
edits to a role's permissions were not logged before 0.8.2.

## Aadhaar guard covers custom-field values only — free text is unchecked

v0.8.0 checks custom-field VALUES (staff writes) and redacts machine-written
lead and import notes. Everything else that takes free text is unchecked, so a
person can still type an Aadhaar number into: applicant name, address and
alternate phones; follow-up notes; `dumpRemarks` on a disposition; ticket
messages (staff and portal); and the inbound-lead `name` and `email` fields.
Extending the value check to these needs a decision per field about
reject-versus-redact and about the false-positive cost on names and addresses,
so it is a tracked item and not a quiet default.

Also: the name check blocks आधार, which is a false positive for the ordinary
Hindi word for "base" (आधार मूल्य). The error suggests मूल instead. Revisit
only if a real user hits it often.

## HIGH PRIORITY: audit UPDATE rows record after-values only (before = null)

**What:** the audit extension writes every UPDATE with `before = null` and
`after = the request's data` (`packages/db/src/audit.extension.ts`,
`auditOrThrow` for `update`). This holds for every audited model. An
UPDATE row says what a field became, never what it was, which
contradicts CLAUDE.md's security rule ("before/after diff").

**Why deferred:** found during v0.8.0 work; the owner scheduled the fix
as its own PR after v0.8.0. v0.7.1 fixed the rows that weren't written at
all, which was the larger gap.

**What unblocks it:** reading the row before the update inside the same
transaction (one extra SELECT per audited update), plus a decision on
whether updateMany/upsert get the same treatment (next entry).

## Bulk writes and upserts on audited models write no audit row

**What:** the audit extension hooks `create`, `update` and `delete` only.
14 call sites in `apps/api/src` write audited models through other
operations and leave no row:
`roles/roles.service.ts:70,110,112,146` (`rolePermission.createMany`/
`deleteMany`: creating, editing and deleting a role's permissions),
`brokers/broker-commission-rule.service.ts:79,117,118`
(`brokerCommissionSlab.createMany`/`deleteMany`),
`brokers/broker.service.ts:118` (`brokerBankDetail.updateMany`),
`inventory/unit.service.ts:239` and `inventory/import-export.service.ts:225`
(`floor.upsert`), `masters/lead-stage/lead-stage.service.ts:170` and
`presales/applicant.service.ts:348` (`inquiry.updateMany`),
`auth/auth.service.ts:336` and `portal-auth/portal-auth.service.ts:466`
(`user.updateMany`). The two `user.updateMany` calls are in the
sign-in/password flows, which write their own explicit audit rows;
role-permission changes have none.

**Why deferred:** out of v0.7.1's scope, which was the rows the existing
hooks were meant to write.

**What unblocks it:** deciding per operation what a row should hold
(`createMany`/`updateMany` return counts, not rows), then either hooking
them in the extension or writing explicit rows at those call sites.

## `audit_logs` is not append-only at the database level

**What:** CLAUDE.md calls audit rows "immutable", but `audit_logs` has no
`forbid_financial_mutation`-style trigger and `openestate_app` holds
UPDATE and DELETE on it. The application never updates or deletes audit
rows, but nothing in the database stops it.

**Why deferred:** owner decision (v0.7.1): tracked, not fixed in that PR.

**What unblocks it:** a migration adding a trigger like the ledger's, plus
the same maintenance escape hatch (`app.allow_financial_mutation`) for
test teardown, which deletes audit rows today.

## Does any production write still reach the audit extension's "no transaction in context" path?

**What:** after v0.7.1, an audited write with no transaction in context
is logged at error level (`[audit] no transaction in context: <model>
<action> <id> was not audited`) but still succeeds without a row. The
v0.7.1 fix removed the known cause (un-awaited queries in `withTenantTx`
callbacks). Whether anything else still reaches this path is unknown.

**Why deferred:** owner decision (v0.7.1): log-only for now.

**What unblocks it:** watch for that log line on a real install (the
journal) and in the CI and Playwright logs. If it never appears, make
the path throw, the same as a failed audit write.

## `prisma migrate diff` shows drift between the database and schema.prisma

**What:** diffing a freshly migrated test database against
`schema.prisma` produces three statements:

```sql
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_source_inquiry_id_fkey";
ALTER TABLE "portal_password_resets" DROP CONSTRAINT "portal_password_resets_created_by_id_fkey";
ALTER INDEX "inquiry_disposition_history_company_id_inquiry_id_changed__idx"
  RENAME TO "inquiry_disposition_history_company_id_inquiry_id_changed_a_idx";
```

The two foreign keys are deliberate: both columns follow the scalar-FK
policy (a plain `@db.Uuid` column in the schema, the constraint added in
the migration; CLAUDE.md Phase 4, "Relation policy"). Prisma can't see
them, so it proposes dropping them. The index rename is Postgres
truncating a 63+ character name differently from Prisma's own
truncation. The practical risk: running `prisma migrate dev` would
generate a migration that drops two real foreign keys, and anyone
applying it without reading it would lose them.

**Why deferred:** pre-existing, found during v0.8.0 work; not related to
the change that found it.

**What unblocks it:** deciding between declaring the relations in the
schema (with `relationMode` or a back-relation) and documenting that
`migrate dev` output must always be reviewed for these three lines.

## Low priority: consider a clock-skew warning at startup or in the health check

**What:** a wrong server clock breaks TOTP 2FA (codes are time-based),
and produces wrong interest accrual, financial-year boundaries and audit
dates. Nothing in the app notices. A startup log line, or a field in
`/api/v1/health`, comparing the server's clock against a trusted source
(the database's `now()` is the same machine's clock in a single-host
install, so it would need an external reference or an operator-configured
tolerance) would surface it.

**Why deferred:** not observed in production. Found on a test VM that had
been suspended and resumed a week behind while `timedatectl` still said
"System clock synchronized: yes" (`docs/handoff.md`, 192.168.1.20).

**What unblocks it:** deciding what to compare against without adding a
mandatory external dependency (CLAUDE.md principle 1: self-hostable, no
mandatory SaaS). Probably an optional check, off unless configured.

## Low priority: pnpm "Failed to create bin" warnings during the native upgrade build

**DONE in v0.8.4 (part P):** see the entry above. The text below is the original
note.

**What:** `upgrade-native.sh` builds print four warnings of the form
`WARN Failed to create bin at .../.bin/<name>. ENOENT: no such file or
directory` for `browserslist`, `webpack`, `vite` and `terser`, with the
release directory's path appearing twice in different forms
(observed on the 192.168.1.20 upgrade to `b83ef31`, 2026-09-24). The
upgrade still completed, migrated and passed its health check.

**Why deferred:** cosmetic; cause unknown. The shims are dev-tooling
binaries the running API never calls. Unknown whether earlier upgrades
printed them too.

**What unblocks it:** reading the same build on a clean checkout (the CI
`native-install` job's log) to see whether it's specific to upgrading in
place, then tracing `pnpm deploy`'s bin linking against the release
directory's layout.

## Verify on VM at next deployment

Items deferred to real-hardware testing. **Status as of the v0.6.0
verification session on 192.168.1.20 (2026-09-17)**, real browser
click-throughs via `claude-in-chrome`, disposable test accounts:

- **2FA/TOTP enrolment and recovery codes — DONE, staff and portal,
  with one real bug found (logged separately, see "SECURITY-RELEVANT
  (staff-only): the staff TOTP-verify code input has a hardcoded
  `maxLength={6}`" above).** Staff: enrollment, TOTP-code login, and
  forced-password-change all verified with real outcomes (a disposable
  `company_admin` user). Portal: enrollment, TOTP-code login, and — this
  is the one genuinely new information the portal pass produced —
  full-recovery-code login **succeeded** (typed with real keystrokes,
  landed on the real broker dashboard) and the same code was correctly
  **rejected on reuse**, confirming the portal field has no equivalent
  `maxLength` bug and one-time consumption works on both surfaces.
- **Broker NOC → cancel → clawback → statement PDF — PARTIALLY
  VERIFIED, not fully verified.** Every step that has real UI was
  exercised and passed with real, cross-checked outcomes: broker
  creation, a `FLAT_PERCENT` commission rule, a booking with the broker
  attached (via `BookingWizard`'s confirm-step broker select), commission
  accrual (₹10,500 on a ₹5,25,000 GST-inclusive booking), a partial
  ₹4,000 payment (request → approve → pay), cancellation correctly
  **blocked** with the exact expected error before an NOC existed,
  the broker portal's real Approve click, cancellation **succeeding**
  after approval, the resulting Outstanding balance flipping to exactly
  **−₹4,000.00** (matching the hand-derived clawback formula:
  `CLAWBACK_REVERSAL = -(accrued-paid)` then `CLAWBACK_RECOVERY = -paid`
  under the default `RECOVER` policy — not ₹0, not still positive), and
  the downloaded broker statement PDF matching that figure exactly,
  row-for-row (ACCRUAL → PAYMENT → CLAWBACK_REVERSAL →
  CLAWBACK_RECOVERY). **The one step NOT exercised through real UI:
  requesting the NOC itself** — see the new entry below, "Staff has no
  UI to call `POST /bookings/:id/noc/request`" — which was done via an
  authenticated in-page `fetch()` (the real access token captured from
  the app's own outgoing request, not fabricated) because no button for
  it exists anywhere in `apps/web`. Because of that one substitution,
  this item is not a full "verified in a real browser" claim per this
  file's own primary lesson — everything downstream of the NOC existing
  (approve, cancel, clawback, statement) is fully real-browser-verified;
  the request step itself is not.
- **The live cross-origin click between the staff and portal login
  screens — DONE, both directions, from genuinely logged-out state.**
  Staff `/login` (unauthenticated) → "Customer or broker? Go to the
  portal" → landed on the real portal (in this case the already-
  authenticated broker's own dashboard, since a portal session was
  still live from the 2FA pass — a valid pass per the code's own
  documented "authenticated visitor skips the redirect" behavior, not
  the blank-page/404 the link was built to catch). Then, after
  explicitly signing out of the portal too: portal `/portal/login`
  (unauthenticated) → "Staff member? Go to the staff login" → landed on
  the real, rendered staff `/login` form — the strictest possible signal,
  confirming the historical basename bug does not recur.

- **v0.6.1's staff recovery-code fix — NOT YET DONE, due after the VM is
  upgraded to v0.6.1.** Playwright covers it end to end, but no human has
  looked at it. On 192.168.1.20: sign in to a 2FA-enabled staff account
  whose recovery codes you hold, with a full recovery code typed on a real
  keyboard; check the "Lost your
  phone? Use a recovery code" toggle's wording on staff and portal, and on
  a real phone confirm the keyboard each mode brings up (number pad for the
  6-digit code, full keyboard with letters and a dash in recovery mode).
  The keyboard part is reasoned from `inputMode`, not verified.

- **v0.7.0's admin 2FA reset and `--clear-2fa` — NOT YET DONE.** CI's
  native-install job runs the script on a fresh install, and Playwright
  covers both in-app resets, but neither has been run on a real, upgraded
  install. On the VM: turn 2FA on for a disposable staff user and a
  portal user; reset each from the staff app and sign in with the
  password alone; confirm the audit rows on Admin → Audit Log; run
  `reset-admin-password.sh` without the flag on a 2FA account and read the
  warning, then with `--clear-2fa`.

**Not yet restored**: the claim removed from `docs/docs/installation.md`
(see the "User-facing docs had drifted from this log" entry in
CLAUDE.md's decisions log for why it was removed) — the NOC item above
is only partially verified, so this stays deferred until a session
either builds the missing "Request NOC" UI and re-verifies through it,
or makes a deliberate, documented decision that the `fetch()` substitution
is an acceptable permanent verification method for a UI-less endpoint.

## Staff has no UI to call `POST /bookings/:id/noc/request` — a genuine gap, not a "look elsewhere" case

Found during the v0.6.0 VM verification session (2026-09-17), while
trying to exercise the broker NOC → cancel → clawback flow through real
UI clicks only. Confirmed by grep, not assumption: `apps/web/src`
contains zero references to `/nocs`, `noc/request`, or any caller of
`POST /bookings/:id/noc/request` anywhere. NOC **approve/reject** has
real UI, but only on the **broker portal**
(`apps/portal/src/pages/BrokerNocs.tsx` → `/portal/broker/nocs/:id/approve`
`/reject`) — there is no staff-side equivalent either (`NocController`'s
`/nocs/:id/approve`/`/reject` also have zero `apps/web` callers).

**This is a genuine product gap, not a case of "the trigger is meant to
live somewhere else."** Reasoned from the code, not guessed: `NocService
.request()` is documented in its own file as "staff-only" (`noc.service.ts`'s
class-level comment); the permission gating it, `POSTSALES_NOC_REQUEST`,
is staff-only in `roles.ts`; and the domain logic itself only makes sense
one way — an NOC (No Objection Certificate) is something the **broker**
grants to the **company**, releasing it to cancel a booking the broker
sourced without dispute. The company (staff) is necessarily the party
that has to ask for it; a broker cannot meaningfully "request their own
NOC" from themselves. There is no other reasonable owner for this
trigger, so this isn't a case of looking in the wrong place — the button
simply doesn't exist. Same shape as every other "backend built and
tested, UI never wired up" gap this project's history is full of
(construction updates, project edit, the base-line GST rate picker,
before each was eventually fixed).

**Reachable today only via**: a raw authenticated request. The
verification session used an in-page `fetch()` with the real access
token captured from the already-logged-in app's own outgoing request
(monkey-patching `window.fetch` briefly to read the `Authorization`
header off a real client-side navigation, then restoring it) plus the
real CSRF cookie — not a fabricated token, not a bypass of the guard
chain, just filling in for a missing button using the same credentials
the button would have used. This is not a substitute for a real "Request
NOC" button and should not be treated as sufficient verification going
forward.

**Unblocked by**: adding a "Request NOC" action somewhere reachable from
a broker-sourced booking — `InstallmentSchedule.tsx` (next to the
existing "Accrue Broker Commission"/"Cancel Booking" buttons, which
already know the booking's `brokerId`) is the obvious home, mirroring
how "Accrue Broker Commission" itself was added there. A staff-side
NOC approve/reject UI (mirroring `BrokerNocs.tsx`) is a separate,
lower-priority gap — cancellation only needs the broker's own approval,
not a staff mirror of it.

## `upgrade-native.sh` produces no persistent log — fix before v0.8.0

Confirmed by reading `deploy/native/upgrade-native.sh` and `deploy/native/lib.sh`
directly. `log()`/`warn()`/`die()` (`lib.sh`) are plain `printf` to stdout/
stderr — no file, no `logger`, no journald wiring for the script itself (only
the *deployed* `openestate-api` service gets journald, via its own systemd
unit, which is a separate thing). The one place the script deliberately
captures output to a file — `MIGRATE_LOG` and `SYNC_LOG`, both
`mktemp`+`tee`'d during the migration and sync-permissions steps — gets
`rm -f`'d in **every** code path immediately after use (`upgrade-native.sh`
lines ~139/142/145 for `MIGRATE_LOG`, ~195 for `SYNC_LOG`), success or
failure alike. So the entire run's output — every step, not just
migrate/sync — exists nowhere but the invoking terminal's own scrollback.
If that terminal disconnects (a dropped SSH session, a closed screen/tmux
pane, a CI runner that doesn't capture stdout to an artifact) mid-upgrade
or right after a failure, there is nothing left to diagnose from — not even
which step it got to.

**Fix before v0.8.0**, not after — v0.8.0 exists specifically to prove the
upgrade mechanism itself (a boot-required-setting rollout, gated on the
healthcheck), and the whole point of that release is to be trustworthy
evidence for self-hosters running it unattended on their own infrastructure.
A failure on someone else's server, with this gap unfixed, leaves them
with nothing to send back except "it didn't work." Straightforward fix:
tee the whole script's output (not just the two steps that already tee) to
a real, timestamped file under something like `/var/log/openestate/` or
`/opt/openestate/releases/<timestamp>/upgrade.log`, and don't delete it —
`backup-native.sh`'s bundles already establish the precedent of leaving an
artifact behind under `/var/backups/openestate/`; this needs the same
treatment for upgrade runs specifically, not just backups.

## For v0.7.0: branch protection on `master` was bypassed by the v0.6.0 release

**Found by accident** while investigating why `pnpm-lock.yaml` showed as
modified (during v0.6.1 prep, 2026-09-17). The v0.6.0 release session's
transcript shows it pushed the release commit `924e55f` and the `v0.6.0` tag
straight to `master`, with no PR. GitHub replied: "Bypassed rule violations for
refs/heads/master: 5 of 5 required status checks are expected." The push
went through anyway.

**The tagged release commit has never passed CI.** The CI run on `924e55f`
(run `35186063739`) was cancelled, probably because the next push to
`master` replaced it. `aa0849e`, the release-notes commit on top, passed.
So `master` is green, but that doesn't show `924e55f` itself is. The
`v0.6.0` tag points at a commit with no successful CI run of its own.

**Why this matters more than the one push:** the project rule "open a PR for
every branch, CI must be green, squash-merge" only protects anything if
GitHub actually enforces the protection. This push shows it doesn't for
whoever is pushing, most likely because the account is an admin and "do not
allow bypassing" is off.

**What would close it:**
- Check the `master` protection settings: enforce for administrators,
  disallow bypassing required checks, and consider requiring a PR.
- Decide whether release commits also go through a PR. Nothing
  explains why the v0.6.0 release was pushed directly.
- Optionally, re-run CI on `924e55f` (e.g. `gh workflow run` against that
  SHA) so the tagged commit has a result of its own.

## For v0.7.0: API e2e tests don't use the app's own validation pipe

**Found during v0.6.1 red-first testing** (2026-09-17). All 40
`apps/api/test/e2e-*.test.ts` files bootstrap with nestjs-zod's stock
pipe (`import { ZodValidationPipe } from 'nestjs-zod'`). `apps/api/src/main.ts`
uses the app's own pipe in `apps/api/src/common/pipes/zod-validation.pipe.ts`
instead, which reports what failed (e.g. `code: Invalid code format`) rather
than a generic `Validation failed` (see CLAUDE.md's toast-audit entry).
The same bad recovery code showed both:
- the API test got `"message":"Validation failed"`
- the Playwright harness, which runs the real `main.ts`, got
  `"message":"code: Invalid code format"`

**Impact today:** validation results match. Both pipes run the same schema
and pass the parsed value on. But no API test checks the error message users
actually see, and any test that asserts on a 400's `message` checks a string
production never sends.

**Fix:** have the API e2e tests share one bootstrap helper that registers
the app's own pipe (or call the same setup function `main.ts` uses). That
brings in `main.ts`'s other global setup too, not just the pipe. Do it on
its own branch; it touches every e2e test file.

## For v0.7.0: no `.gitattributes`, so line endings depend on each machine's git config

The repo has no `.gitattributes`. So how git handles line endings comes
entirely from each contributor's own git config. On this Windows machine
that's `core.autocrlf=true` from `C:/Program Files/Git/etc/gitconfig`. The
committed files and the working copies both use LF, so every
`git add`/`git diff` warns "LF will be replaced by CRLF the next time Git
touches it."

**This is behind the stale lockfile flag** (same investigation as the entry
above). After the v0.6.0 release rewrote `pnpm-lock.yaml` with identical
bytes (see CLAUDE.md's note under "v0.6.0 released" on why
`pnpm install --lockfile-only` is a no-op here), the file kept showing as
modified until its cached timestamp was refreshed with
`git update-index --refresh`. Every hash and size matched, and `git diff` was
empty. Our working explanation is that `autocrlf` stops a normal
`git status` from refreshing the timestamp, because a checkout would write
different bytes (CRLF) from what's on disk (LF). That fits everything we saw,
but hasn't been proven.

**Fix:** add a `.gitattributes`, most likely `* text=auto eol=lf` plus
explicit `binary` entries as needed, then run `git add --renormalize .`
once. After that, line endings no longer depend on each machine's settings.
Needs its own branch: renormalizing can touch many files, and the diff needs
reviewing on its own, not mixed into a feature change.

## Nightly property test now takes ~32min at 2000 runs — consider sharding across matrix jobs instead of one long job

The nightly (`schedule`/`workflow_dispatch`) CI run was silently cancelling
during `postsales-property.test.ts`'s 2000-run property test for at least
three runs, unnoticed. Root-caused and fixed in two layers (see the PR that
merged this entry for full detail and real run-ID evidence): a redundant
full re-run of the test inside the "Fail if any test was skipped" step, and
the test's own hardcoded `it()` timeout (30min, sized for the 500-run
PR/push path) firing independently of the job-level timeout. Both are
fixed — a real `workflow_dispatch` run confirmed `integration-tests` green
at full 2000-run strength.

**The real timing evidence this fix produced, which is the actual reason
to revisit the sharding question**: at 2000 runs, the job's "Run
integration tests" step alone took the full **32m26s** for the whole job
(property test dominates that). The test's own timeout now has an 80min
ceiling to leave headroom inside the job's 90min budget. **32+ minutes is
a long time for a single test to run before a real ledger regression is
discovered** — it's a large part of why the original cancellation went
unnoticed for three consecutive nightly runs: a single long-running job is
easy to lose track of, and a red run that takes 30+ minutes to fail is
much less likely to get looked at promptly than one that fails in a few
minutes.

**Why not sharded now**: this exact tradeoff was already considered once
and deliberately deferred in favor of the time-based 500/2000 PR-vs-nightly
split (see CLAUDE.md's Phase 4 decisions, "Ledger property test:
nightly-2000 / PR-500 split, not CI-matrix sharding") — the reasoning there
was that a 4-way matrix (400–500/shard) would 4x the runner minutes for the
same total coverage per run (sharding parallelizes wall time, not cost),
plus shard-partitioning complexity for fast-check's seed/skip mechanics,
for no correctness benefit over the simpler split. That reasoning about
*cost* still holds. What's new is the *observability* argument: a 4-way
matrix would turn one 32-minute job into four ~8-minute jobs running in
parallel, at the same total runner-minute cost, but with each individual
job finishing (and therefore failing, if it's going to fail) in a fraction
of the wall-clock time — directly addressing the "unnoticed for three runs
because nobody was watching a 30+ minute job" failure mode, independent of
the runner-cost tradeoff that was the sole consideration last time.

**What would actually decide this**: whether GitHub Actions' own
notification/status visibility for a long-running scheduled job is really
the reason the original cancellation went unnoticed (plausible, but not
directly verified — no one has checked whether a shorter-duration failure
would actually have surfaced faster in practice, e.g. via how failure
notifications are configured for this repo). If so, sharding earns its
complexity cost specifically for faster failure detection, not (per the
Phase 4 reasoning, still valid) for lower total cost. Revisit alongside
that question rather than sharding on wall-clock time alone.

## Three known-timing-sensitive test failures, not re-investigated (contention-class, evidence already in hand)

Found in a real full-`pnpm test` run on the walkthrough VM (2 CPU cores,
live production traffic sharing the box — see CLAUDE.md's `scripts/
test-setup.sh` verification entry for the full context): `e2e-portal-
throttle.test.ts`'s "throttle state survives a fresh app instance" test and
`webhook-delivery.test.ts`'s "N concurrent exhausted deliveries produce
exactly N counted failures" test both failed, once each, in that run only.

**Why not chased further**: both are pre-existing tests whose own names
describe exactly the kind of race/timing assertion this project's history
(Phase 7→8, Phase-0-follow-up) already treats as expected to flake under
real resource contention, not something to re-diagnose from a single
occurrence. The same session's isolated re-runs of three OTHER files that
failed in the same full run (`e2e-master-creation`, `e2e-tickets`,
`presales-reports`) all passed cleanly once contention was removed,
which is the standard diagnostic this project uses to tell "real bug"
from "contention flake" — that evidence was judged sufficient without
repeating it for these two as well.

**What would actually close this**: re-run each of these two files in
isolation (not the full suite) two or three times; if they pass every
time, that confirms contention and this entry can be deleted; if either
fails again in isolation, it is real and needs its own investigation.

**Third instance, 2026-09-23, real GitHub Actions CI, not the VM**: the
`Integration tests (Postgres + Redis)` job on `master`'s merge commit for
PR #49 (admin-side 2FA reset) failed once on
`e2e-totp-lockout.test.ts > staff > concurrent wrong codes cannot slip
past the lock: exactly 5 of 8 are checked` — `Error: read ECONNRESET`, a
transport-level connection reset, not a failed assertion. That test is
byte-for-byte untouched by #49 (the PR only added a new `E3h` case to the
same file, confirmed with `git show <merge-sha> -- apps/api/test/
e2e-totp-lockout.test.ts` before re-running anything). A re-run of just
that CI job passed cleanly. Same contention class as the two VM instances
above, on a different runner (GitHub-hosted, not the VM) — the same
"an already-flaky concurrency test occasionally hits a transport-level
error under real resource contention" shape, not a new bug class.

**If this recurs**: check first whether it's the SAME test — this one, or
either of the two VM instances above — before assuming a regression. The
diagnostic is the same one this entry already uses: re-run just that one
CI job or test file in isolation. If it passes clean, it's this class. If
it fails again in isolation, or a different test fails, it needs its own
investigation.

## `ci.yml`'s `scripts/test-setup.sh` wiring — not verified by an actual GitHub Actions run

`integration-tests` now calls `scripts/test-setup.sh` (with
`TEST_PG_ADMIN_USER=openestate_super`/`PGPASSWORD` routing it into TCP
mode against the service container) instead of carrying a second,
hand-maintained copy of the same role/migrate/seed SQL. Validated by YAML
parse, step-order inspection, and tracing the exact code path the script
takes in TCP mode against known-good behavior verified elsewhere in the
same session — but not by an actual push. Creating a throwaway
non-`postgres`-named superuser role to structurally rehearse the
container-admin shape locally was blocked by the same system-settings-
adjacent safety boundary that blocked fixing the VM's clock drift in the
same session. **The real proof is the next push's `integration-tests`
run** — if it goes red, read this entry first before assuming a fresh
bug: the most likely failure modes are (a) `openestate_super`'s password
not matching `POSTGRES_PASSWORD` on the service container (verified
identical by direct comparison of both hardcoded values, but worth
re-checking first) or (b) `$GITHUB_ENV` not receiving the three
`DATABASE_URL_TEST*`/`REDIS_TEST_URL` lines from `.test-env` correctly.

## `pgrep` isn't available in the Windows dev shell

"Nothing is running" checks before a build or a test run must use the
PowerShell process list, not `pgrep`:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
```

Found while shipping 0.8.1: `pgrep` is not installed in the Git Bash shell
on the dev machine, so `pgrep -f vitest 2>/dev/null` printed nothing
because it failed, and several earlier "nothing running" checks proved
nothing. The same rule is in CLAUDE.md's working habits.

## Local test containers: two pairs claim the same ports

This development machine has two Postgres+Redis container pairs that both
bind 5432 and 6379: `oe-test-pg`/`oe-test-redis` (the throwaway test
infrastructure `.test-env` points at) and `openestate-manual-pg`/
`openestate-manual-redis`. Only one pair can run at a time. After Docker
Desktop restarts, neither is running, and starting the wrong pair means the
tests connect to a database that isn't the provisioned test database —
failures there look like application bugs. Start `oe-test-pg` and
`oe-test-redis` explicitly. Either rename the manual pair's ports or delete
it; the repo itself uses no containers (see CLAUDE.md), so this is a
machine setup issue, not a repo one.

## Test-infra flakiness from `syncLeadStages`' unscoped scan — timeboxed, root cause not fixed

**Fixed in v0.8.4:** `syncLeadStages` takes an optional company scope and the
tests pass it, so a test's sync no longer reaches other test files' companies.
The cleanup workarounds described below stay in place (owner decision); they
are now redundant, not harmful. The rest of this entry is the history.

**Honest root cause, stated plainly**: `syncLeadStages` (`packages/db/prisma/
sync-permissions.ts`) does a deliberately UNSCOPED whole-database
`company.findMany()` — correct for its real job (an upgrade must reach every
company, not just some). The test suite runs many files in parallel against
ONE SHARED Postgres database. Put those two facts together and any test
fixture's company is fair game for `syncLeadStages` to reach into, any time
`sync-lead-stages.test.ts` happens to be running concurrently — which, under
`pnpm test`'s default parallelism, is most of the time.

Everything built this session in response — the 14-file
`leadStage.deleteMany`/`companyConfig.deleteMany` additions, and
`packages/db/test/helpers/delete-company-safely.ts`'s retry loop — makes
test cleanup TOLERATE that interference. **Neither one stops the
interference itself.** `syncLeadStages` still reaches into every other
test's fixtures on every call; the fixes only make it survivable once it
does. Worth being precise about that distinction so a future session doesn't
mistake "cleanup no longer throws" for "the tests are isolated from each
other," which they aren't.

**The fix is INCOMPLETE, not just imperfect — say so plainly.** The 8
`apps/api/test` files that create a company still only have the simple
`leadStage.deleteMany` + `companyConfig.deleteMany` before their
`company.delete()` — the SAME sequence that was proven insufficient for the
6 `packages/db/test` files (a real, ~40%-of-runs-observed gap between those
deletes and the final company delete, where `syncLeadStages`' already-
in-flight per-company transaction can land and recreate what was just
deleted). None of the 8 apps/api files have the retry helper. **"No failure
observed there yet" is not "fixed" — it means the race is live and simply
hasn't been hit by chance yet**, for the same reason a rarely-taken branch
with no test isn't "verified working." Treat these 8 files as still exposed
until either they get the same retry treatment or the real fix below lands.

**Two real candidate root fixes — recorded, NOT built this session:**

**(a) An optional `companyId` scope on `syncLeadStages`/
`syncSuperAdminPermissions`**, so a test can ask "sync just this one company"
instead of the function always scanning every company in the database.
Directly stops the interference at the source — a scoped call genuinely
cannot reach another test's fixture.
**Tradeoff, stated honestly**: the production call path (`upgrade-native.sh`,
`seed.ts`) needs the UNSCOPED behavior — an upgrade has to reach every
company, not one. A test that only ever calls the scoped form no longer
exercises the exact scan `syncLeadStages` actually runs in production
(`company.findMany()` with no filter, iterating the full result). Any test
that specifically wants to prove the unscoped-scan behavior itself (there is
at least one — the "does NOT resurrect" test relies on iterating past
already-marked companies) would still need the unscoped form, so this
wouldn't be a clean full replacement, only an option most fixtures could
take to stop being reachable.

**(b) Database-per-worker, or a serial (non-parallel) vitest project for
files that call an unscoped sync.** Removes the SHARED half of "shared
database across parallel workers" instead of the unscoped-scan half.
**Tradeoff**: database-per-worker means provisioning N throwaway databases
(migrating and seeding each) instead of one, adding real setup time and
complexity to `scripts/test-setup.sh` and CI; a serial project for the
handful of unscoped-sync-adjacent files is cheaper to build but makes the
full suite slower by however long those files take run-not-in-parallel,
and doesn't help if a NEW file elsewhere in the suite also starts an
unscoped scan without anyone remembering to add it to that project's list —
the same "someone has to remember" fragility as the current per-file
cleanup fixes, just at a different layer.

Neither is built. This entry exists so a future session facing this same
class of flake doesn't have to re-derive the root cause or re-discover
these two options — it can start here and pick one deliberately, or find a
better one, rather than adding a 15th parallel cleanup fix.

**Caveat on this session's own evidence, so it isn't over-trusted later**:
the initial ~40%-of-runs figure and the "second, narrower race" diagnosis
came from a batch run against a freshly-reset database and are reasonably
trustworthy. But a separate data point — a `packages/db/vitest.config.ts`
`maxForks` cap tried, then reverted, mid-investigation — was evaluated
against a database that later turned out to be polluted by this session's
OWN earlier ad hoc debugging (an orphaned company with real `LeadStage`
rows and no marker, confirmed by direct query, left over from before the
cleanup fixes existed). At least one subsequent "still failing" full-suite
run was one of a batch where an EARLIER run in the same batch had been
killed by a 10-minute tool timeout mid-transaction — a hard kill, not a
clean failure, and a plausible independent source of the SAME kind of
pollution. Both were treated in this session's own closing summary as
supporting evidence that the retry helper's fix was reliable. **That
conclusion should be read as UNTESTED, not established** — the maxForks
experiment in particular was never cleanly re-run against a verified-clean
database on its own, so no real conclusion about whether concurrency
capping would help or hurt should be carried forward from it either way.

## `BrokerBankDetail.isPrimary` has a real, still-open race condition

Found while designing `LeadStage.isDefault`'s enforcement (Phase 0 of
feature-completion-plan.md — see CLAUDE.md's decisions entry). Verified
by reading the code directly, not assumed: `BrokerBankDetail.isPrimary`
is enforced only by a transactional clear-then-set (`updateMany` inside
a transaction), with no database constraint backing it. Two concurrent
requests setting a different bank detail as primary for the same broker
can both leave `isPrimary: true` under READ COMMITTED — nothing prevents
it. `LeadStage.isDefault` deliberately did NOT copy this pattern (a
partial unique index instead); `BrokerBankDetail` itself was left
untouched, out of scope for that phase. **What unblocks it**: a
`CREATE UNIQUE INDEX ... WHERE is_primary` partial index on
`broker_bank_details (broker_id)`, same shape as `LeadStage`'s, plus a
migration to resolve any bank detail that's already in the broken state
(more than one primary per broker) before the index can be added. Low
urgency — no financial money-movement reads `isPrimary` directly today
(confirmed by grep before filing this) — but worth fixing before
anything starts trusting it as a hard invariant.

## Built: lead ownership & manager hierarchy (v0.4) — what's still open from that work

`User.managerId` + `TeamScopeService` + the CI guard landed in v0.4 (see
CLAUDE.md's "v0.4 — lead ownership and manager hierarchy" decisions entry
for the full writeup). Three things that entry deliberately left open:

- **`managerWiseInteractions()` (`presales/reports.service.ts`) is now
  unblocked.** It's reported every active sales_manager's own
  directly-logged interactions, not a team roll-up, since Phase 3 —
  explicitly because no manager hierarchy field existed. It exists now.
  Upgrading this to a real team roll-up (each manager's count including
  their subtree, via `TeamScopeService.getVisibleUserIds`) is a natural
  next step, but wasn't part of v0.4's asked-for scope — left as its own
  small follow-up rather than built unprompted.
- **`Booking` core CRUD (`booking.controller.ts`) stays unscoped.** Only
  the Reports module scopes postsales data by owner (Phase 4-UI
  precedent); the booking list/detail endpoints themselves show every
  booking in the company to any staff user with the permission,
  regardless of who created it. v0.4 deliberately didn't touch this —
  Booking wasn't part of the "lead ownership" report's own scope, only
  Inquiry/Applicant/FollowUp/Booking-*reports* were. Likely to come up
  as a real pilot request once a company has enough sales reps that
  "every rep can see every other rep's bookings" starts to matter —
  worth designing for explicitly when it does, not scoped preemptively
  now.
- **Global search** — doesn't exist yet (confirmed by grep, not
  assumed). Must be built with `TeamScopeService` wired in from the
  first commit, not retrofitted after — building it search-first would
  recreate exactly the "forgotten on a new endpoint" risk
  `team-scope-guard.test.ts` exists to prevent.

## Phone as identifier — still approved, not yet built

- **Phone as identifier, without a DB uniqueness constraint.** A hard
  `@@unique` on `primaryPhoneNormalized` is incompatible with real,
  legitimate cases the report named (family members sharing a number,
  brokers on one office line) and would either reject them outright or
  falsely merge a telco-reassigned number onto the wrong historical
  person. Instead: a persisted per-pair "confirmed distinct" decision
  (e.g. `ApplicantDistinctPair(companyId, applicantAId, applicantBId,
  decidedById, decidedAt)`) so a human's "these are different people"
  call, once made, stops the same warning resurfacing for that exact
  pair — composes with the existing `ApplicantMerge` machinery for the
  opposite decision. Automated paths (inbound lead API, bulk import)
  keep auto-link-on-match as the default (unchanged, deliberate Phase 7
  reasoning — no human is present to ask), gaining a per-company
  `CompanyConfig` toggle to always-create-and-flag instead, for a
  company that knows its market has heavy phone-sharing. No
  telco-reassignment detection — this project's own phone-normalization
  precedent (Phase 3) already rejected guessing here: a false "these are
  different people" costs a re-ask later, a wrong auto-merge costs a
  business potentially servicing the wrong person's booking.

## Plotted inventory (plan §14) — three findings from the Phase E walkthrough

Found during Phase E's real-browser LAND_BASED lifecycle walkthrough
(create project → group → plots → book → receipt → generate documents →
cancel) on the verification VM, v0.4.0, commit `d118d89`.

**Allotment letter renders "Tower , Floor ," for a LAND_BASED booking.**
`ALLOTMENT_LETTER`'s `MERGE_FIELD_REGISTRY` entry
(`packages/shared/src/documents.ts`) includes `towerName`/`floorLabel`;
`buildLetterContext()` (`apps/api/src/pdf/document.service.ts`) resolves
both to `''` when the booking's unit has no floor
(`booking.unit.floor?.tower.name ?? ''`) — a plot has no tower/floor by
definition. This is NOT a crash and NOT a literal `{{token}}` leak (both
were explicitly checked, live, against a real generated PDF) — the merge
resolves cleanly to an empty string, exactly as the code is written to
do. But a template phrased the way an admin would naturally write one
("Tower {{towerName}}, Floor {{floorLabel}}") renders with a visible
blank/dangling-comma gap: confirmed live by generating a real Allotment
Letter against a real plot booking and reading the PDF directly.
`DEMAND_LETTER` is unaffected — its own registry entry doesn't include
`towerName`/`floorLabel` at all, so this is specific to
`ALLOTMENT_LETTER`. The real fix is conditional merge-field syntax (a
`{{#if fieldName}}...{{/if}}`-style block that omits a whole
clause/line when its field(s) are empty) in `resolveMergeFields` and
`validateTemplateMergeFields` — a genuine templating feature, not a bug
fix, since the current mechanism is pure string substitution with no
conditional construct at all. Until built, the workaround lives at the
template-authoring layer: a company running both HIGH_RISE and
LAND_BASED projects needs either two separate allotment-letter
templates or one written to avoid tower/floor phrasing entirely.

**No project delete or deactivate UI exists.** `DELETE /projects/:id`
(`ProjectController`/`ProjectService.remove()`, a hard
`tx.project.delete()`) has zero frontend callers anywhere in
`apps/web` — confirmed by grep of `Projects.tsx` and
`ProjectDetail.tsx`, not assumed. There is also no deactivate path:
`Project.isActive` is set at creation but deliberately excluded from
the edit form (see the `Project.isActive has no enforced meaning
anywhere` entry above — it's enforced nowhere in the API either). A
project created by mistake — wrong shape (immutable after creation),
wrong code, wrong company — cannot be removed or even hidden through
the product at all; this session's own walkthrough project
("E2E Land Walkthrough Farms") is now permanently on the demo company's
project list for exactly this reason, once it acquired a booking. Same
class of gap as the project-edit gap already fixed this pass (backend
capability existed, UI never wired it up), and it will bite a real
pilot user during their own first-time setup — creating a throwaway
project to learn the screen, or picking the wrong shape by mistake, is
an entirely ordinary first action. Unblocked by: a Delete Project
button (with a confirmation, reusing the booking-count-confirmation
pattern already built for `areaLocationId` edits) for a project with
zero bookings; for a project with any booking history the button
should be disabled/explained rather than attempted-and-failed, since
the ledger's append-only FK protection will very likely reject a hard
delete once a booking exists (not independently re-verified this
session — no delete control exists to click — but consistent with
every other financial-linkage protection this codebase enforces).

**No letter-template delete (or edit/deactivate) UI exists.**
`apps/web/src/pages/admin/LetterTemplates.tsx` only supports create and
list — confirmed by reading the file directly, during this walkthrough's
own cleanup step, after creating two real templates
("Standard Allotment Letter", "Standard Demand Letter") to generate the
PDFs above and finding no way to remove them afterward. Every other
master table in this codebase gets an Active checkbox + PATCH via the
generic factory pattern (`Masters.tsx`); Letter Templates has its own
dedicated page that never wired the equivalent in. Cosmetic/tidiness
gap, not a correctness or security issue. Unblocked by wiring the same
generic-master PATCH pattern into this page.

## Must-fix-before-pilot (found on the pre-pilot walkthrough)

Three gaps found walking a realistic project through the real product.
All three have since been fixed.

**Fixed: staff construction-update UI.** `ProjectDetail.tsx` now has a
Construction Updates panel (create with title/description/date, attach
photos, list, delete) wired to `ConstructionUpdateAdminController`,
which was already fully built and tested (Phase 6, real IDOR tests,
real Playwright coverage on the portal render side) but had zero
caller anywhere in `apps/web`. See CHANGELOG.md's `[0.3.0]` entry.

<!-- Original finding, kept for context on what "fixed" resolved: -->
- ~~No staff UI to publish a construction update or attach a progress
  photo.~~ `ConstructionUpdateAdminController` is fully built and tested
  (Phase 6, real IDOR tests, real Playwright coverage on the portal
  render side) but has zero caller anywhere in `apps/web`. A customer's
  portal "construction progress" section will only ever show something
  if a developer hand-crafts one via the raw API — confirmed by grep,
  not assumption. Needs a list+create+photo-attach screen, comparable in
  size to the Letter Templates admin page built for v0.2's PDF gap.

**Fixed: project edit.** `ProjectDetail.tsx` now has an Edit Project
form wired to the pre-existing `PATCH /projects/:id` endpoint (the
backend already accepted partial updates; only the UI was missing).
`code` is excluded from the update schema — it's used to match projects
during bulk inquiry CSV import, so it's immutable rather than
error-handled. Changing `areaLocationId` on a project with existing
bookings shows a confirmation naming the booking count first (existing
bookings' GST is a one-time snapshot and is never retroactively
altered). See CHANGELOG.md's `[Unreleased]` entry.

**Fixed: the base-line GST rate picker.** A booking's cost-line GST
resolution (`booking.service.ts`) falls back through: the line's own
rate → its charge type's rate → the booking's `BASE` line's rate — and
with no rate ever settable on the base line, this was reprioritised
ahead of the other two gaps above because it fails *silently* (a wrong
number on a printed document, no error) where the other two fail loud
or merely create friction. `BookingService.createBooking` now rejects
the whole booking if any line's rate can't be resolved, and
`BookingWizard.tsx` has a real rate picker on the base line
(auto-selected only when exactly one active rate exists). See
CHANGELOG.md's `[Unreleased]` entry for the full writeup, including how
already-created zero-GST bookings are surfaced (boot-time log + admin
banner + a "Zero-GST bookings" CSV report) rather than silently altered.

**Pilot checklist (operations).** Check these before a pilot server goes live:

- **The server clock must be NTP-synced** (`timedatectl` says `System clock
  synchronized: yes`, and `date` matches a trusted clock). 2FA codes and
  password-reset links fail otherwise, and a virtual machine resumed from a
  snapshot can say "synchronized" while hours behind. See the clock-skew entry
  above and the 0.8.3 section of the installation guide.

## `Project.isActive` has no enforced meaning anywhere

Found while building the project-edit form: `isActive` is set at
creation (default `true`), shown as a read-only Yes/No column on the
Projects list — and never read anywhere else. Grepped the whole API for
any query filtering on it (booking's available-unit lookup, reports,
the portal's `getMyProperties`) — zero hits. Deliberately left out of
the edit form rather than shipping a toggle whose effect is unclear:
flipping it today would look like it does something and do nothing.
Before adding it to the edit form, decide and implement what it should
actually gate — the obvious candidates are hiding an inactive project
from new-booking unit selection and/or from the portal — and update
this note once it has a real, tested effect.

## UNIT custom field values have no frontend capture or display path

## Pre-sales (Phase 3)

- **Escalation: notify the project manager instead of all company managers,
  once a project→manager mapping exists (Phase 5 or 6).** Today
  `EscalationService.runForCompany` notifies every active `sales_manager` in
  the company because no project→manager (or user→manager) reporting-line
  field exists in the schema yet. The same simplification affects the
  "manager-wise interaction" report (reports each manager's own logged
  interactions, not a team roll-up). Unblocked by adding a team-hierarchy /
  project-ownership mapping.

## Financial core / brokers (Phase 5)

- **Encrypt `Applicant.pan*` using the new `PanEncryptionService` (Phase 5).**
  `Applicant.panCiphertext`/`panMasked`/`panKeyVersion` have existed since
  Phase 4, but nothing has ever written or read them —
  `Applicant.panCiphertext` is always null today. Phase 5 builds the first
  AES-256-GCM PAN encrypt/decrypt utility (`PanEncryptionService`, modeled
  on `TotpService`'s identical implementation) but wires it only to the new
  `Broker.panCiphertext`. Retrofitting `Applicant` — an API field on the
  applicant create/update DTOs plus a PAN input on the applicant form — is a
  follow-up, not part of Phase 5's stated scope. Unblocked by nothing; the
  encryption service already exists and is directly reusable.

## Auth / rate limiting (Phase 1, widened in Phase 6)

- **FIXED in v0.6.1 (code and automated tests; not yet on a VM) —
  SECURITY-RELEVANT (staff-only): the staff TOTP-verify code input has a
  hardcoded `maxLength={6}`, which makes recovery-code login through the
  real UI impossible.** v0.6.1 removed the limit, added a recovery-code
  toggle on both surfaces, and made `totpVerifySchema` trim and uppercase
  the code; see CLAUDE.md's "v0.6.1 — staff recovery-code input" entry.
  Still owed: a manual pass after the VM is upgraded (see "Verify on VM at
  next deployment" above), and a check on a real phone of the keyboard each
  mode brings up. A staff user who has lost **both** their authenticator
  and their recovery codes now has a way back in: the admin 2FA reset
  (v0.7.0). The original report follows, unedited.
  `apps/web/src/pages/TotpVerify.tsx`'s `code` input
  sets `maxLength={6}`, but a real recovery code
  (`TotpService.generateRecoveryCodes()`) is `XXXXX-XXXXX` — 11 characters.
  Typing a full recovery code with real keystrokes truncates it to 6
  (confirmed live on 192.168.1.20's v0.6.0 install: `FA897-AF930` became
  `FA897-`), which then fails the client-side zod resolver
  (`totpVerifySchema`'s `code` regex, `^(\d{6}|[0-9A-F]{5}-[0-9A-F]{5})$`)
  before the request ever reaches the network — the login attempt never
  even hits `POST /auth/totp/verify`. **The backend is correct and
  unaffected** — `totpVerifySchema` already accepts both the 6-digit and
  the 5-5 recovery format (its own code comment records a *previous*
  incident where a digits-only schema rejected every recovery code, fixed
  server-side); this is purely a client-side input constraint that
  contradicts its own backend contract.
  `apps/portal/src/pages/Login.tsx`'s equivalent TOTP field has **no**
  `maxLength` at all — so this is staff-only, and is a violation of
  CLAUDE.md's mirrored-auth standing rule (a defect found on one surface
  is a question about the other) in one specific direction. **Combined
  with the "planned admin-side 2FA reset" noted in the next entry below —
  which doesn't exist yet, confirmed by reading `AuthController`/
  `AuthService`: `totp/disable` is self-service only
  (`req.user.sub`), there is no admin-facing endpoint that touches
  another user's `totpEnabled` — a staff user who loses their
  authenticator today has NO recovery path at all: not self-service
  (this bug), not administrative (doesn't exist).** Found during v0.6.0
  VM verification, specifically by typing the real recovery code with
  real keystrokes into the field — a scripted `.value=` set (bypassing
  the DOM's own `maxLength` enforcement) would have silently passed the
  full value through and never revealed the truncation, exactly the
  "real typing vs. scripted value-set" gap CLAUDE.md's own "Boundary of
  browser-automation verification" section warns about. Fix is
  presumably just removing/widening the `maxLength` (and possibly
  loosening `inputMode="numeric"`, which some mobile keyboards use as a
  hint to suppress the `-` character) — not attempted yet, deliberately
  batched with other fixes after the full v0.6.0 verification sweep
  finishes, per instruction.
- **FIXED in v0.7.0 (automated tests; not yet on a VM) — SECURITY-RELEVANT:
  2FA and password-change events write no audit row.** Every 2FA and
  password event on both surfaces now writes one row through
  `authAuditData` (`apps/api/src/auth/auth-audit.ts`) in the transaction
  that makes the change; the admin 2FA reset shipped with it. See CLAUDE.md's
  v0.7.0 entries. The original report follows, unedited.
  `AuthService` and `PortalAuthService` use `SYSTEM_PRISMA`, which
  carries no audit extension, so `User`'s `AUDITED_MODELS` registration
  never fires for these calls. Affects both staff and portal surfaces.
  Means no operator can determine whether a 2FA compromise occurred.
  Should be closed before or alongside the planned admin-side 2FA reset,
  which would otherwise also write no trail. **Safe to fix without
  touching the audit architecture** — the same manual
  `auditLog.create()`-inside-a-`SYSTEM_PRISMA`-transaction pattern already
  used for `RESET_LINK_ISSUED`/`PORTAL_RESET_ISSUED` applies directly
  here, so this doesn't need a design decision first, just the same
  treatment applied to a few more call sites. **See the entry directly
  above** — until an admin-side 2FA reset actually exists, this "planned"
  feature is also the only thing that would give a locked-out staff user
  a way back in, so the two gaps compound.
- **Redis-backed `ThrottlerStorage` for the default/`portal-auth`/
  `portal-read` buckets.** CLAUDE.md's security rules call for
  `@nestjs/throttler` + a Redis store; `app.module.ts`'s single
  `ThrottlerModule.forRoot([...])` call (all three named buckets, see the
  Phase 6 commit 4 decisions log entry for why there is now exactly ONE
  call, not two) has used the package's default in-memory storage since
  Phase 1 — fine for a single-instance deploy, but it means rate-limit
  state isn't shared across replicas and resets on restart. Fixing this
  needs a new dependency (`@nestjs/throttler-storage-redis` or
  equivalent) plus touching the frozen Phase 1 `ThrottlerModule.forRoot`
  call — out of Phase 6's approved scope. Unblocked by adding that
  dependency and wiring one shared Redis-backed storage instance for the
  single throttler registration.
- **`PermissionsGuard` is default-allow: a route with no
  `@RequirePermissions` lets any valid JWT through without looking at what
  it carries.** This is the root cause of the 2FA bypass fixed on
  `fix/temptoken-scope-enforcement`, where a password-only tempToken could
  strip or take over 2FA through the undecorated `totp/*` routes. That fix
  (`TwoFactorPendingGuard`) contains the blast radius for the one token
  that must never act as a session; it does not remove the policy. 19 of
  317 routes are undecorated today (the self-service routes in `auth/` and
  `portal-auth/`, plus `GET /company/terminology` and `GET /portal/branding`),
  and any route added later without a decorator is open to every valid
  token too. Flipping to default-deny, with an explicit opt-in for "any
  signed-in user" routes, touches every controller and needs its own
  branch and its own full testing. **Narrowed in 0.8.1, still open:**
  `SessionSurfaceGuard` now refuses a portal session on every staff route
  and a staff session on every portal route, so default-allow only
  matters within one surface.
- **FIXED in 0.8.1 — SECURITY-RELEVANT: staff and portal auth aren't bound
  to their own users.** Access and 2FA-pending tokens now carry a
  `surface` claim; `SessionSurfaceGuard` refuses a token on the other
  surface's routes; staff login, refresh and 2FA verify refuse portal
  accounts, and portal 2FA verify refuses staff accounts. This also
  covers the related finding that a portal session could call staff API
  routes (the broker role's `reports.broker.view` let brokers read the
  staff broker reports). See CLAUDE.md's 0.8.1 entry. The original report
  follows, unedited.
  A pending-2FA token issued by one surface is accepted by the
  other surface's `totp/verify` — portal verify will issue a staff user a
  portal-shaped token, and staff verify a portal user a staff-shaped one
  with no `applicantId`. Separately, staff login resolves users by email
  without excluding portal-linked users. No privilege escalation was
  found: portal controllers refuse tokens with no `applicantId` ("Not a
  customer portal session") and portal refresh refuses staff users. But
  this is the same shape as the tempToken scope bug — a credential
  accepted where nobody intended, harmless until some future endpoint
  makes it harmful. Needs its own analysis.
- **SECURITY-RELEVANT: one recovery code can be spent twice by two
  concurrent requests.** `verifyTotp` (staff and portal) consumes a
  recovery code with a read-then-write — load the array, splice, save — so
  two simultaneous requests with the same code both find it and both get a
  session. Pre-existing. The fix is the same shape as `reserveTotpAttempt`
  (`apps/api/src/auth/totp-lockout.ts`): a single atomic statement that
  removes the code only if it is still present.
- **FIXED in 0.8.1: `totp/verify`'s rate limit counts each endpoint
  separately.** A 2FA-pending token is now accepted only by its own
  surface's verify endpoint (403 on the other), so one user's attempts
  can reach only one endpoint and the per-user limit is 5, not 10. The
  lockout counter on the user row stays as a second layer. The original
  report follows, unedited.
  A pending-2FA token is accepted by both the staff and the portal verify
  endpoint, and the throttler keys each handler on its own, so the
  per-user 5-per-5-minutes limit allows 10 across the two. The stated
  budget only holds end to end because the TOTP lockout counter lives on
  the user row. Remove the lockout and the effective limit doubles.
- **Later hardening: separate JWT signing secrets per surface.** Staff and
  portal tokens are signed with one `JWT_ACCESS_SECRET`; 0.8.1 separates
  them with a signed `surface` claim checked by a guard. A second secret
  would make a staff strategy unable even to verify a portal token. It
  adds a setting every existing install must have at boot, so it waits
  until v0.9.0 proves `upgrade-native.sh` can add one safely.
- **Low priority (UX): a broker whose session predates a permission change
  gets a 403, not a refresh.** Access tokens carry a snapshot of the
  role's permissions; the frontends refresh on 401 only. After the 0.8.1
  upgrade a broker signed in beforehand sees an error on their dashboard
  until the access token expires (up to 15 minutes) or they reload. Same
  for any role change made while a user is signed in. A possible fix:
  refresh once on a 403 before showing it.
- **`ConsoleCommunicationProvider` logs full message bodies, so portal
  self-service password-reset tokens (`PortalPasswordResetProcessor`) reach
  server logs in plaintext.** Reset tokens still reach the logs through this
  path. Admin-issued reset tokens, staff and portal, no longer go through
  the provider at all. Not a simple redaction: on an install with no
  SMS/email provider, that log line is today the only delivery path for
  portal self-service reset — decide alongside the portal reset design.
- **A reset link issued at the same moment its user is deactivated can
  survive a later reactivation.** Deactivation consumes outstanding links,
  and redemption refuses an inactive account and uses the link up, so the
  ordinary deactivate→reactivate case is closed. The race that remains:
  admin issuance (`UsersService.forcePasswordReset`,
  `PortalAuthService.issueAdminPasswordReset`) and the self-service
  processor check `isActive` before their transaction, not under the
  user-row lock. So a link can be created just after `deactivate()` has
  consumed the existing ones. If nobody tries that link while the account
  is inactive and an admin reactivates it within 30 minutes, the link
  works. Needs two admins acting on the same user at once. Fix: re-check
  `isActive` inside the locked transaction on each issuance path.
- **`PasswordReset.consumedAt` now means "used", "superseded by a newer
  link", or "invalidated by a password change or deactivation"** — the
  table can't tell them apart; needs a `supersededAt`-style column.
- **A used, an expired, and a superseded reset token all produce the same
  "Invalid or expired reset token" message**, so an admin can't tell a
  customer why their link failed. Distinguishing them needs the
  `supersededAt` column above.
- **Known exposure, not new: reset and invite tokens travel in the URL
  query string, so nginx's access log records them.** Staff
  (`/reset-password?token=`), portal (`/portal/reset-password?token=`) and
  portal invite links (`/portal/invite/:id?token=`) all load a page with
  the raw token in the query, and nginx's default log format writes the
  full request line. Anyone who can read the access log can read live
  tokens, and on Ubuntu that can include the `adm` group, who may not have
  database access. What limits it today: reset tokens expire in 30 minutes
  and work once; invites expire in days. The reset and invite pages load
  nothing from other sites, so no `Referer` leaks the token (that changes
  if either page ever loads an external asset). Options, not taken: carry
  the token in the URL fragment (`#token=`, never sent to the server),
  which needs a change on every page that reads it; or drop query strings
  from the nginx log format for those paths.
- **No test drives two concurrent redemptions of the same reset token.**
  Coverage gap only. The single-use claim is one atomic statement
  (`UPDATE ... WHERE consumed_at IS NULL RETURNING id`), so by inspection
  only one caller can win. A test would fire two confirms with
  `Promise.all` and expect exactly one 204; each file's IP-keyed confirm
  budget is 5 per 5 minutes, so it needs room for 2.
- **`password_resets.created_by_id` has no foreign key to `users`**, while
  `portal_password_resets.created_by_id` (added for admin-issued portal
  resets) does. Give the staff table a matching FK when a migration touches
  it for another reason — not worth a migration of its own.
- **The portal self-service reset processor doesn't supersede admin-issued
  reset links**, though an admin-issued link does supersede pending
  self-service ones. Asymmetric by omission, not design: the processor was
  deliberately left unmodified when admin-issued portal links were added.
- **`deploy/native/reset-admin-password.sh` sets a staff password without
  consuming that user's outstanding reset links.** Every in-app way a
  password gets set now consumes them, so a stale link can't overwrite the
  new password. This break-glass CLI doesn't: a link issued before the CLI
  reset stays usable until it expires (30 minutes). The fix is one more
  `UPDATE password_resets SET consumed_at = now() WHERE user_id = ... AND
  consumed_at IS NULL` in its SQL block. Deferred because changing the
  script means redoing its VM verification. v0.7.0 changed the script
  anyway (`--clear-2fa`) and kept this out only because that release's
  scope was frozen, so the next VM pass has to cover the script regardless
  and this one-line fix costs no extra verification.
- **`reset-admin-password.sh` has no way to clear 2FA without also
  resetting the password.** The common sole-admin case is "lost my phone,
  still know my password"; today `--clear-2fa` always sets a new password
  too. A `--keep-password` option would skip the hash-and-write step.
- **`reset-admin-password.sh` hasn't been through shellcheck since
  `--clear-2fa` was added.** `bash -n` passes, the generated SQL was
  executed against a real Postgres, the flag's branches were run under the
  script's own `set -euo pipefail`, and CI's native-install job now runs
  the script for real — but shellcheck isn't installed on the development
  machine and no CI job runs it. Adding
  `sudo apt-get install -y shellcheck && shellcheck deploy/native/*.sh` to
  CI would cover every deploy script, not just this one.
- **Self-service `totp/disable` asks for no re-authentication**, staff and
  portal. A stolen signed-in session can turn 2FA off without the password
  or a code. Pre-existing; the admin reset doesn't change it.
- **The Audit Log page shows every action other than CREATE and UPDATE in
  red**, the colour it uses for deletions. `RESET_LINK_ISSUED`,
  `TOTP_ENABLED`, `PASSWORD_CHANGED` and the rest all look like deletions
  (`apps/web/src/pages/admin/AuditLog.tsx`). Cosmetic, but an admin
  scanning for destructive changes will misread them.
- **Portal invites don't supersede each other**: re-sending an invite
  leaves every earlier invite link live for its full multi-day expiry
  (`INVITE_EXPIRY_DAYS`). Reset links supersede; invites don't.
  Pre-existing and out of scope for the reset-link work, but the asymmetry
  deserves a deliberate decision rather than staying an accident.

## Portal (Phase 6)

- **Staff services' self-wrapped `runWithTenant({companyId})` calls are
  redundant with `TenantContextInterceptor`'s ambient context for call
  sites that are genuinely staff-only — but "harmless" was the wrong word
  for the general case, and Phase 6 commit 4's decisions log entry
  supersedes the earlier note below.** Before Phase 6 commit 2, staff
  services (`ApplicantService`, `CommissionService`, `NocService`,
  `BookingService`, etc.) each wrapped their own tenant context from the
  controller's `req.user.companyId`, independently of any ambient
  middleware/guard context — this pattern is *why* the
  middleware-before-guards bug (and later the Guard-`enterWith` bug) went
  undetected for every staff route across five prior phases: staff
  services never depended on ambient context at all, only portal services
  (added in Phase 6) were exposed. What Phase 6 commit 2 got wrong: it
  concluded self-wrapping was *therefore* harmless in general. Phase 6
  commit 4 found a real counter-example — `NocService.approve()`/
  `reject()` became BOTH staff- and broker-portal-facing in commit 3, and
  the self-wrap silently stripped the ambient `portalBrokerId`, producing
  a fail-OPEN IDOR (a portal session briefly got staff-level DB
  visibility, not just narrower access). The property "this self-wrap is
  harmless" depends on which controllers call the method — today AND in
  any future phase — which can't be verified by reading one file in
  isolation. Two structural fixes now make this the runtime's job instead
  of the reviewer's: `runWithTenant()` throws if a same-company call
  would replace an active portal scope, and `runScoped()` (promoted to
  `packages/db`, was private to `NocService`) is the blessed helper for
  any future dual-purpose service. See CLAUDE.md Phase 6 commit 4
  decisions for the full audit of every currently portal-reachable
  service (all clean, only `NocService` needed the fix) and the
  guardrail's test coverage.

  Removing ~50+ staff-only call sites' self-wrap in favor of pure ambient
  context remains a separate, not-yet-done cleanup — still low-risk now
  that the guardrail exists as a backstop, but still requires a
  through-the-wire supertest per touched controller before merging (the
  Phase 6 commit 2 standing rule) to catch any that turn out to be
  portal-reachable after all.

## Plugins (Phase 7)

- **Plugin execution has no worker-thread/process isolation — a genuine
  synchronous infinite loop in a plugin hook blocks the single Node event
  loop and cannot be preempted by `PluginRuntimeService.invoke()`'s
  `Promise.race` timeout.** Stated plainly in CLAUDE.md Phase 7 decisions
  and in the plan's Trust Model section: first-party plugins ship as
  reviewed npm workspace packages inside this repo, not untrusted code in
  a marketplace, so the isolation boundary (package-boundary — no
  `@openestate/db` dependency at all; capability-gated `Proxy` context;
  timeout+catch-all `invoke()` wrapper) defends against the Phase 6-style
  *composition* bug class and against accidental misbehavior, not against
  deliberately hostile code. If this project ever accepts untrusted
  third-party plugins, real isolation (a `worker_threads` sandbox or a
  separate process per plugin invocation, with message-passing instead of
  direct object references for `PluginContext`) is required before that
  trust boundary can move. Unblocked by: a decision to support untrusted
  plugins at all, which has real design cost (message-passing context,
  serialization limits on what `ctx.http`/`ctx.leads` can return, a new
  process-lifecycle story) — not attempted speculatively here.
- **Redis-backed `ThrottlerStorage` gap (see the Phase 1/6 entry above)
  will also apply to the `lead-inbound` named throttler once it's added
  in commit 2** — same single `ThrottlerModule.forRoot([...])` call,
  same in-memory-storage limitation, no new gap introduced, just noting
  the surface area grows by one more bucket.

## GSTIN checksum digit not verified (format regex only)

`updateCompanyConfigSchema.companyGstin` (packages/shared/src/company.dto.ts)
validates the 15-char GSTIN structure via regex but does not verify the
final check-digit (a mod-36 algorithm). Deferred rather than risking a
subtly wrong implementation that silently rejects real, valid GSTINs —
worse than no check at all for an admin trying to onboard their real
company. Add real checksum verification once validated against a set of
known-correct GSTIN/check-digit pairs (not from memory).

## UNIT custom field values have no frontend capture or display path

The backend fully supports UNIT custom field values (validation, storage,
portal-strip) since v0.2.3 — the gap is entirely in `apps/web`. APPLICANT
and INQUIRY get values captured inline on the "Add Inquiry" form
(`Inquiries.tsx`); PROJECT gets them on the "Add Project" form
(`Projects.tsx`, added on the pre-pilot walkthrough). UNIT has neither: a
unit is only ever created via Bulk-Generate (one shared set of parameters
applied to many units at once — the wrong shape for a per-unit value like
"facing direction") or CSV import, and there is no single-unit edit screen
to hang a form on at all. Building one is a real, standalone UI addition
(a new "Edit Unit" affordance), not a small wiring fix like the other
three — sized alongside the project-edit gap below, not built opportunistically.
Confirmed by a real pre-pilot walkthrough: defining a UNIT field through
the admin Custom Fields page has zero effect anywhere else in the product,
exactly the same failure shape the original v0.2.3 gap analysis wanted to
close for every entity.

## Dormant permission constants: `POSTSALES_DOCUMENT_*` and `PORTAL_DOCUMENT_UPLOAD`

**What:** four constants in `packages/shared/src/permissions.ts` —
`postsales.document.read`, `postsales.document.upload`,
`postsales.document.delete` and `portal.document.upload` — are checked by
no route anywhere in `apps/api` (grepped). They are nonetheless granted
in `packages/shared/src/roles.ts`:
- sales_manager and sales_executive: read + upload (explicit)
- company_admin: all three `postsales.document.*` (via the `postsales.*`
  prefix)
- super_admin: all four
- customer: `portal.document.upload`

Seeding and `sync-permissions` have put them in the `permissions` table
and in `role_permissions`.

**Why it matters:** they look like the obvious names for uploaded
documents, and reusing them would silently widen roles on upgrade: every
existing sales_executive would gain access to KYC scans, and every
customer a portal upload capability, with no admin decision. The uploaded-
documents plan (`docs/plans/uploaded-documents-plan.md`, §2d) uses new
`postsales.uploaded-document.*` names for exactly that reason.

**Why deferred:** deleting a constant from the code removes nothing from
the database — `syncPermissions` only inserts. A real cleanup needs:
- a migration deleting these keys' `role_permissions` and `permissions`
  rows
- removing the constants and their entries in `ROLE_PERMISSIONS`

Custom roles an admin built may include them — harmless, since nothing
checks them, but the Roles UI still lists them until the rows go.

**Unblocked by:** v0.9.0 shipping the replacement permissions. Clean up in
any release after that, so the new names exist before the old ones
disappear. (`POSTSALES_BOOKING_UPDATE` was dormant in the same way; it
stops being dormant in v0.7.0, which uses it for booking custom-field
edits.)

## SECURITY: `RolesService.update()` doesn't check the grantor already holds a permission before granting it

**What:** `RolesService.update()` (and `.create()`) let a caller with
`admin.role.update` set a role's `permissionIds` to any list of valid
permission ids — including permissions the caller's own role doesn't hold.
There is no check anywhere in the method that the grantor's current
permission set is a superset of what they're about to grant. Found while
scoping the uploaded-documents plan
(`docs/plans/uploaded-documents-plan.md`), which needed to reason about who
can reach a newly-added permission.

**Severity, reasoned, not assumed:** grepped `packages/shared/src/roles.ts`
directly. On a fresh install, only `company_admin` (via its `admin.*`
prefix filter) and `super_admin` (via `Object.values(P)`, every
permission) hold `admin.role.update` — no lesser system role
(`sales_manager`, `sales_executive`, `accounts`, `customer`, `broker`)
lists any `ADMIN_ROLE_*` permission through any path. So today, on a
fresh install, this gap lets an already-maximally-trusted role (one of the
only two roles that can edit ANY role's permissions at all) grant itself
something it doesn't yet hold — not an escalation across a boundary this
system currently defines. **Low severity for that specific reason.** It
would extend further if an admin has deliberately granted a lesser custom
role `admin.role.update` — that role would inherit the same self-grant
ability, but only because an equally privileged actor chose to hand it
that permission first.

**Fix, not built:** `RolesService.update()`/`.create()` should reject (or
silently drop, with a clear response) any `permissionIds` entry the
calling user's own current permission set doesn't already contain — the
standard "you cannot grant what you don't hold" rule most RBAC systems
enforce and this one doesn't. Needs its own test proving a role WITH
`admin.role.update` but a narrower permission set (a hypothetical custom
"role-editor" role, say) cannot use it to grant itself something broader.

**Unblocked by:** nothing technical — it's a straightforward service-layer
check. Deferred because it's a pre-existing gap unrelated to any feature
currently being built, not because it's hard.

**Still open after 0.8.1.** 0.8.1 added a different check to
`RolesService.update()`: a portal role can hold only `portal.*`
permissions. That doesn't stop a grantor giving a staff role what they
don't hold themselves.

## Legacy system-written keys inside `custom_fields`

`InquiryService.createFromLead` writes `{ leadNote }` and
`InquiryImportService` writes `{ importNotes }` directly into
`Inquiry.custom_fields`. These are server-generated, not client input,
so they are not a validation hole — but they are undefined keys living
in a column that is otherwise admin-defined, and they show up in the
"orphaned value" UI as `(inactive)`.

They are preserved rather than rejected (v0.2.3's
`resolveValuesForWrite` carries unknown STORED keys through untouched,
so an imported inquiry stays editable), which is correct behaviour but
not a clean design. The tidy-up is a real `notes` column on `Inquiry`
and a migration moving those two keys onto it. Low priority; noted so
the next person to see `leadNote` in a custom-fields display knows it
is expected, not corruption.

## `toCsv` emits nothing at all for an empty result set

`apps/api/src/presales/csv.util.ts`'s `toCsv` returns `''` when
`rows.length === 0` — so a report with no rows downloads as a
completely blank file, with no header row to show what the columns
would have been. Pre-existing, affects all seven presales reports
equally (not specific to the v0.2.3 custom-field columns, which are
derived from the rows). Fixing it means passing the expected headers in
explicitly rather than deriving them from `rows[0]`.

## `Inquiry`'s other optional FK fields aren't validated against the caller's company either

Code review of the Phase 0 lead-stage diff (before it shipped) found and
fixed the missing check for `stageId` — `InquiryService.create()`/
`update()` never confirmed a client-supplied `stageId` belongs to the
caller's own company before persisting it; the DB foreign key only
proves the row exists somewhere in `lead_stages`, not that it's in
scope. Fixed via `LeadStageTransitionService.assertStageBelongsToCompany`.

**Not fixed in the same pass, and this is the gap**: `projectId`,
`sourceId`, `inquiryTypeId`, `preferredUnitTypeId`, and `temperatureId`
on `Inquiry.create()` have the identical shape — none of them are
re-checked against `companyId` before the `tx.inquiry.create()` call
(only `applicantId` is, via an explicit `tx.applicant.findFirst({where:
{id, companyId}})`). A caller who obtains another company's id for any
of these could set a cross-tenant reference the same way `stageId`
used to allow. Scoped out of the `stageId` fix specifically because it
was a targeted review fix, not an invitation to widen the diff into
every sibling field — but the underlying gap is real and the fix
pattern is now established (mirror `assertStageBelongsToCompany`'s
shape for each master/relation). Whoever picks this up should audit
`InquiryService.update()`'s DTO fields too, not just `create()`'s.
explicitly rather than deriving them from `rows[0]`.

## Should logging a follow-up on a closed lead reopen it?

`FollowUpService.create()`'s status-advance ternary
(`status: inquiry.status === 'OPEN' ? 'CONTINUED' : inquiry.status`)
only flips OPEN to CONTINUED — a DUMPED or SUCCESSFUL inquiry's status
is left exactly as-is when a new follow-up with a `nextActionAt` is
logged against it. This has been the actual behavior since item 1 of
the Follow-Up Page spec work landed; a stale comment above it claimed
otherwise for a while (fixed, not the point of this entry).

The open product question: should logging an interaction on a closed
lead reopen it? Current behavior says no — a rep can log a note against
a DUMPED or SUCCESSFUL inquiry (there's no guard against that either)
without it silently coming back to life in the active pipeline. That
seems like the safer default (a closed lead shouldn't resurrect via a
side effect of logging a call), but nobody has actually asked for
either behavior — this is speculative, not SOP-mandated. Whoever
changes it should decide deliberately, not fix it as a "bug."

## `UserForm` wipes anything typed before the user record finishes loading

`apps/web/src/pages/admin/UserForm.tsx` calls `reset()` once the user,
roles and users-list queries have all arrived, and that overwrites every
field — so anything an admin types into the edit form before then is
silently lost. Pre-existing. Surfaced by a flaky `user-role-edit.spec.ts`
(it typed the new name the moment the URL matched; the role, picked
later, survived and the name didn't), and worked around in the spec by
waiting for the form to be populated — not fixed in the app. A real
admin on a slow connection hits the same thing.

## `apps/e2e`'s CI job has a real, pre-existing intermittent flakiness under concurrency — found while shipping the pre-sales reporting suite, not caused by it

**v0.8.4:** the refresh-rotation race this entry traces the failures to is
fixed (per-user lock on every refresh-token write; see the "Done (v0.8.4)"
entry above). If E2E failures of this shape come back, investigate them fresh
rather than assuming this race.

Building the reporting suite's own Playwright coverage
(`presales-reports.spec.ts`, PR #27) surfaced a genuine, reproducible
problem in the `e2e-playwright` CI job itself: a **rotating subset** of
the suite's heaviest, most login-intensive specs — `team-scope.spec.ts`,
`ticket-reply.spec.ts`, `user-role-edit.spec.ts`,
`successful-to-booking.spec.ts`, `rapid-reload-session.spec.ts` — fails
intermittently, at the exact test-timeout ceiling (30.0-30.1s, not a
partial-progress miss), across otherwise-identical CI runs.

**Proven unrelated to that PR's own changes, not assumed.** After five
different fix attempts each targeting a specific hypothesis (below) left
the same two specs failing every time, `presales-reports.spec.ts` was
removed from the branch ENTIRELY and pushed as a pure diagnostic (run
[33245056896](https://github.com/stemAGH/openestate/actions/runs/33245056896),
job 99081209383). The job still failed — but with a **different** pair
of specs (`successful-to-booking.spec.ts` + `user-role-edit.spec.ts`)
than the pair that had been failing with the new spec present
(`team-scope.spec.ts` + `user-role-edit.spec.ts` — seen across runs
[33242845925](https://github.com/stemAGH/openestate/actions/runs/33242845925),
[33243617317](https://github.com/stemAGH/openestate/actions/runs/33243617317),
[33244004498](https://github.com/stemAGH/openestate/actions/runs/33244004498),
[33244405582](https://github.com/stemAGH/openestate/actions/runs/33244405582)).
That rotation — a different pair failing depending on what else is in
the suite, at the same fixed ceiling regardless — is the signature of
real, load-dependent contention, not a specific spec's logic being
wrong. Two "success" runs on `master` from just before this PR
(`33065667370`, `33066407872`, both 35/35 with zero retries) were
initially taken as evidence the branch introduced the problem — that
turned out to be two lucky samples, not proof of master's true
underlying rate; the diagnostic above is the actual evidence.

**Root mechanism, from Playwright's own trace artifacts, not
speculation**: the browser is sitting on `/login` at the exact moment
of failure, mid-test, even though the test code believes it's several
steps past login. `page.goto()` is a real browser navigation (not a
React Router client-side transition) — it remounts the whole SPA and
re-fires `AuthProvider`'s mount-time `/auth/refresh` call. This project
already documents and partially mitigates this exact race
(`REFRESH_REUSE_GRACE_SECONDS`, the "rapid-reload-logout" fix in
CLAUDE.md's Decisions log) — the new finding is that under **real CI
concurrency** (many spec files' own logins and page reloads landing in
the same narrow window, not just React StrictMode's double-effect
pattern the original fix targeted), the existing grace window can still
be exceeded.

**Wrong turns ruled out, in order, so a future session doesn't re-walk
them:**
1. *Fixture contention on the shared `mastersCrud` company's Users list*
   (`Users.tsx` paginates at `limit: 20`; many concurrent specs create
   users against the same company). Plausible-looking, and partially
   true as a contributing factor, but eliminated as the SOLE cause: even
   after moving the affected test onto a fully independent company
   (zero shared rows), the same two specs kept failing identically.
2. *The shared default rate-limit bucket* (100 req/60s, IP-keyed,
   `app.module.ts`) being exhausted by this PR's own added `/auth/login`
   calls. Real and fixed on the **backend** integration-tests job
   (unrelated 429s on `e2e-tickets`/`e2e-plugins` went away after
   consolidating `e2e-presales-reports.test.ts` from 7 logins to 3) —
   but the E2E/Playwright job runs a completely separate API process
   with its own separate budget, and reducing this PR's own Playwright
   login count (down to a single login, then down to zero via the
   diagnostic) never changed the E2E outcome.
3. *Needs more time, not a hang* — raised Playwright's CI timeout from
   30s to 45s. The same two specs failed at 45.0-45.1s instead, exactly
   on the new ceiling rather than somewhere in between — ruling out
   "genuinely slow but progressing" and pointing at a real stuck state
   instead. Reverted.
4. *This PR's own extra page reload* — replaced a `page.goto()` with a
   client-side nav-link click to cut one avoidable `/auth/refresh` call.
   Real and directionally correct (contributes less load), but not
   sufficient on its own — the same failures persisted until the
   zero-spec diagnostic finally isolated the true scope of the problem.

**What would actually close this**: the refresh-rotation race needs to
tolerate real concurrent load, not just React StrictMode's synchronous
double-invoke. Candidate directions: widen
`REFRESH_REUSE_GRACE_SECONDS` (a config change, but see its own
Decisions-log entry for the security trade-off that name already
documents — widening it further isn't free); or make the specific
heaviest specs (`team-scope`, `user-role-edit`, `ticket-reply`,
`successful-to-booking`) reuse an already-authenticated session instead
of each doing several sequential fresh logins in one test, the same
"extend an existing fixture's login, don't add a new one" discipline
this file's own portal-auth-throttle entry already established for a
different bucket. Either way, per CLAUDE.md's standing rule, a real
change to the refresh/auth path needs its own real-browser
click-through on both staff and portal before it ships — a materially
bigger undertaking than this entry, and deliberately not attempted as a
side effect of an unrelated feature PR.

**Standing note, not a licence to wave off E2E failures generally**: a
failure in a spec you just touched, or a NEW failure appearing in a spec
you didn't, is still yours to investigate until proven otherwise — the
rotation described here was established with a real diagnostic (removing
the suspect code and confirming the failure persists unchanged in kind),
not assumed from "E2E is flaky" folklore. This entry documents one
specific, evidenced instance of pre-existing contention; it does not mean
future E2E red is presumed innocent.
