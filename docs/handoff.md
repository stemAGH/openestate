# Handoff — current operational state

Living doc, not append-only (unlike CLAUDE.md's Decisions log). Keep it updated
with whatever a new session needs to pick up work immediately; prune stale facts
rather than layering history on top of them. For *why* a decision was made, see
CLAUDE.md's Decisions log; this file is only *what's true right now*.

**Last updated: 2026-11-03. v0.8.5 is released (commit `3ae6d6da`, tag `v0.8.5`);
master is `7b29363` (the post-release docs, release-aware upgrade CI and the
deploy launcher check). In flight: v0.9 item 1, delayed-payment interest (PR #78,
`v0.9-interest-rule`). Its integration with master is being prepared locally on
`integrate/v0.9-on-7b29363` (not pushed); the original worktree's uncommitted work
is backed up at `C:\Users\Ashis\oe-backups\pr78-20261103` (section 4).**

## 1. How we work

- **Who does what.** The owner decides, approves releases and types every
  password. An architect reviews plans and results and gives rulings; the owner
  relays them. Claude Code investigates, plans, builds and verifies, and stops for
  approval before anything outward-facing (a push to master, a tag, a release, an
  advisory).
- **Order of work.** Reproduce a problem deterministically first. Write the tests
  first and show them failing on the current code, then fix, then show them
  passing. Run mutation checks (remove the protection, the test must fail). A
  concurrency test must force its interleaving (CLAUDE.md, "a concurrency test
  must force its interleaving").
- **Git.** Plain commit messages, no attribution lines anywhere (commits, PRs,
  tags, releases, advisories). Master moves only by fast-forward, never force.
  Never rewrite history, tags or releases. Work on a branch, open a PR, and wait
  for its CI.
- **Stop at the first failure.** Never auto-roll-back; report and wait.
- **Secrets.** The owner types every password. A real credential value never goes
  in chat output or a tracked file (CLAUDE.md, "no credential values in any
  committed file"). No real personal address in a tracked file either.
- **Evidence.** A feature is not done until it has been performed in a real
  browser (Playwright counts, see CLAUDE.md) and, for upgrades, on the
  verification VM. A passing test that the same code could not have failed proves
  nothing.
- **Security fixes.** Public wording stays neutral until release; the detail lives
  in a private draft advisory, which is published when the release goes out.
- **Release procedure (as done for v0.8.4).** Branch, PR CI green, owner's OK,
  fast-forward master to the PR head, master CI green (the previous-release jobs
  start from the prior tag), annotated tag on exactly that commit, GitHub release
  (body from `docs/releases/vX-release-notes.md` plus the advisory link at the
  top), publish the advisory straight away and request its CVE, then check a fresh
  clone (tag points at the commit, `package.json` version), delete the merged
  branches. The owner is present from the master push to the advisory.
  Before the first PR run of a new release, review the previous-release CI
  variants. Each failure variant names the migration it exercises (`exercises`
  in the matrix) and starts from the newest release without it, so it keeps
  testing that migration in later releases; a release that adds a migration worth
  its own failure test gets new variants for it. (v0.9's first run failed because
  the variants still described v0.8.4; v0.8.5's because they assumed the previous
  release had migrations.)
- **Security release via a private fork (as done for v0.8.5).** Draft advisory, then
  its temporary private fork; push the fix branch there (CI does not run in it, so
  run the full suite locally); make the release commit there; rehearse that exact
  commit on the VM from a `git bundle` with `upgrade-native.sh` and no `--ref`
  (the installed script would fetch `--ref` from the public origin); then
  fast-forward public master to it, wait for master CI, tag, release and publish.
  Don't use the advisory's merge button: GitHub doesn't document its merge method.
  The fork disappears when the advisory is published.
- **Only one Claude session may use the VM or one working directory at a time.**

## 2. Environment

### Dev machine (Windows)

- Repo at `C:\Users\Ashis\Desktop\Claude Code\openestate`. Shells: Git Bash and
  PowerShell. The git identity is `stemAGH`. `gh` works but is still signed in
  under the old account name (it follows the repository's rename).
- **Test infrastructure is two containers:** `parts-postgres-1` (Postgres 16,
  superuser `openestate_super`, database `openestate_test`, port 5432) and
  `parts-redis-1` (Redis 7, port 6379). Docker Desktop lives at
  `C:\Users\Ashis\AppData\Local\Programs\DockerDesktop\resources\bin`. They are
  provisioned by `scripts/test-setup.sh`, which needs a `psql` client; none is
  installed here (a small stand-in was used before), so the database is simply
  kept migrated (42 migrations as of v0.8.5; 44 with the v0.9 interest-rule
  migrations). **Confirmed 2026-11-03: both are stopped** and were
  not used or changed during the v0.8.5 work. The historical interest job 1400 is
  most likely in `parts-redis-1` (not checked, because the container was left
  stopped); leave it alone.
- **v0.8.5 verification used separate, disposable services (confirmed running
  2026-11-03, not yet removed):** containers `t22-disposable-pg` (Postgres 16,
  data in memory) and `t22-disposable-redis` (Redis 7, saving off), on the standard
  ports 5432/6379, and a clean short-path clone at `C:\oe-t23` (detached at
  `3ae6d6da`, `core.autocrlf=false`). The `psql` stand-ins (`psql` and `psql.cmd`)
  live in the session scratchpad, outside the repo, and only reach
  `t22-disposable-pg`. All of this can be deleted once the owner agrees; deleting
  the containers loses nothing, since their data lives in memory.
- **Windows checkouts and long paths.** With `core.autocrlf=true`, the
  `lint-migration-drops` test fails to parse (CRLF in the script's `#!` line); a
  clone deep in the scratchpad breaks Vite on the 260-character path limit. Use a
  short path such as `C:\oe-t23` with `core.autocrlf=false` for a full local run.
- **Port 3900 and Docker.** Starting Docker Desktop can make Windows reserve ports
  3812-3911, which blocks Playwright's API on 3900 (`EACCES`). Check with
  `netsh interface ipv4 show excludedportrange protocol=tcp`; the owner releases
  them with `net stop winnat; net start winnat` in an administrator shell.
- `.test-env` (git-ignored) holds `DATABASE_URL_TEST`, `DATABASE_URL_TEST_SYSTEM`
  and `REDIS_TEST_URL`. **It does not hold `DATABASE_URL_TEST_SUPER`**, which the
  suites that use `cleanupCompany` need for teardown (the append-only escape
  hatch is superuser-only since v0.8.4). Export it yourself, as the superuser
  login on port 5432, before `pnpm test`.
- **Rebuild `apps/api` before running the suite** (CLAUDE.md, working habits).
  Run the full suite with `pnpm exec turbo run test --force`; `pnpm test --force`
  passes `--force` to pnpm and fails.
- **Playwright:** clear the `throttle:*` keys in the test Redis first (the staff
  reset-confirm and portal-auth buckets are Redis-persisted); the suite finishes
  in under 4 minutes. `fk-orphan-upgrade` runs only when `CI` is set and needs
  `psql`, so it skips here.
- **Windows pitfalls.** Git Bash `/tmp` is not visible to Windows Python (use the
  session scratchpad). `docs/*.md`, `CHANGELOG.md` and similar files use CRLF line
  endings; edit them with tools that keep them, or convert in memory and write
  back CRLF. PowerShell 5.1 strips inner double quotes from `ssh` arguments (see
  the VM notes). `pgrep` is not available (use the PowerShell process list).
- `openestate-partS` is a leftover local clone of the removed private fork and can
  be deleted. A PostgreSQL 17 and a Redis-on-Windows install were made by mistake
  earlier; their services are stopped and disabled and can be uninstalled.
- Docs site: `pnpm --filter @openestate/docs build`.

### CI

- **One CI run per commit.** A pull-request run starts on its own only while the
  PR has no merge conflict with master; if a push gets no run, check for a
  conflict first (PR #74 had one after the rename was squash-merged to master).
- **Manual runs on the same branch cancel each other** (`concurrency:
  cancel-in-progress` per ref), so start at most one with `gh workflow run`, and
  only when no pull-request run started. Manual runs use the nightly-strength
  settings (2000 property runs).
- **A pull_request run's recorded commit is the branch head**, so match runs to
  pushes by that sha, not by the merge commit the run tests.
- Eight jobs run on every PR and on master: lint/typecheck/unit/build, integration
  tests, E2E (Playwright), native install, native upgrade, and three upgrades from
  the previous release's tag with its own script (clean, orphan, lock-timeout).

### The verification VM

One box is in use: `192.168.1.20`, user `textopen`, Ubuntu 24.04, reached from the
dev machine as `ssh openestate-vm` (no password). The alias lives in the dev
machine's `~/.ssh/config` and uses the key `~/.ssh/id_ed25519_openestate_vm`,
created 2026-10-15. **That key is installed only in the `v0.8.4-rehearsal` and
`v0.8.4-verified` snapshots**; after a revert to any older snapshot the owner has
to add it to `~textopen/.ssh/authorized_keys` again (one `echo ... >>` command,
typing the password). IPs on this project drift, so confirm it before trusting it.
Credentials are kept outside this repo; ask a maintainer.

- **State now (confirmed 2026-11-03): running v0.8.5**, upgraded from a revert to
  `v0.8.4-verified` with the installed v0.8.4 script: release
  `20261103052619-3ae6d6da`, health 0.8.5, 42 migrations, all 283 foreign keys
  validated, money totals unchanged from v0.8.4. The pre-upgrade backup is
  `/var/backups/openestate/20261103-052618`. The temporary sudo rule was added for
  the upgrade, then removed by the owner, and its removal was verified
  (`sudo -n true` asks for a password). The private bundle and read-only SQL used
  for the rehearsal are in `~textopen/oe-rehearsal/` (mode 700) and can be deleted.
  This state is **not** saved as a snapshot; `v0.8.4-verified` is still the clean
  base for the next release's rehearsal.
- **Known fixture states:** the `2fa` test account has **2FA turned off** in
  `v0.8.4-verified`, so a manual 2FA check needs it turned back on first (owner's
  approval: it changes a fixture). Two deactivated customer-role accounts with no
  linked customer are flagged by every upgrade and left as they are. **One test
  staff user's password was changed during the 2026-10-15 check** (the owner knows
  which); the change is in the snapshot.
- **`sudo` needs the owner.** `textopen` has no passwordless sudo. For a rehearsal
  the owner adds a temporary rule, `/etc/sudoers.d/90-uiaudit-temp` (NOPASSWD),
  typing their password in their own terminal (`ssh -t openestate-vm`), and it is
  removed at the end of the session. It must never be left in place or baked into
  a snapshot meant as a clean base.
- **Source checkout:** `/opt/openestate-src` (origin is the stemAGH address).
  **Releases:** `/opt/openestate/releases/<timestamp>-<sha>`, with
  `/opt/openestate/current` pointing at the live one. **Health:**
  `curl -s http://127.0.0.1:3000/api/v1/health`. The stray folder
  `/opt/openestate-src/apps/openestate` (28 entries, left by earlier versions) is
  still there on purpose; v0.8.4 upgrades don't add to it.
- **The UIAUDIT test data is the kept regression test bed. Do not delete it.** It
  is the company, project, units and bookings, and the accounts exec-a, exec-b,
  exec-d, mgr, accounts, narrow, 2fa, Buyer One and UIAUDIT-Broker-01. Only the
  old backups under `/var/backups/openestate/` may be pruned.
- **Mobile-app staging also lives on this VM** (set up by another session on
  2026-10-07): HTTPS on port 443 with a self-signed certificate (expires
  2026-11-06), a `cloudflared` service that cannot connect, and `~/oe-staging`
  plus `/opt/openestate-released`. It is present in the `staging-2026-10-09`
  snapshot. Correction (observed 2026-11-03): a `cloudflared` service is also
  active after a revert to `v0.8.4-verified`, so at least that part is in the
  `v0.8.3-clean` line too; `~/oe-staging` was absent in the PR #78 state.
- An older walkthrough box at `192.168.1.100` (user `newopen`, v0.4.0 as of
  2026-08-29) was not used in this release cycle; its state is unverified.

#### Snapshots (VMware, tree as `vmrun listSnapshots` shows it)

```
Snapshot 1                        2026-09-08 original install
  Snapshot 2                      2026-10-02
    pre-P7                        2026-10-07 genuine v0.8.2: build ...d337a736,
                                               35 migrations, plain HTTP,
                                               sudo rule present
      pre-v0.8.3                  2026-10-09 NOT clean: the VM had been moved onto
                                               a release-candidate branch
        staging-2026-10-09        2026-10-09 the VM as the owner works with it:
                                               mobile staging setup, HTTPS, the
                                               portal-fix rehearsal build
      v0.8.3-clean                2026-10-10 v0.8.3 from the public tag: release
                                               ...1f485336, 37 migrations, plain
                                               HTTP, no sudo rule
        v0.8.4-rehearsal          2026-10-15 v0.8.3-clean upgraded with v0.8.3's
                                               own script to wip/v0.8.4 8e058a8c,
                                               42 migrations, origin switched to
                                               stemAGH, no sudo rule; holds the
                                               new SSH key
          v0.8.4-verified         2026-10-15 upgraded with the installed v0.8.4
                                               script to the release commit
                                               5891f99, v0.8.4 verified in the
                                               browser, no sudo rule; the clean
                                               base for the next rehearsal
            pr78-state-2026-11-02-e92babe4
                                  2026-11-03 the VM as the PR #78 (interest-rule)
                                               work left it: build e92babe4,
                                               version 0.9.0, 44 migrations (two
                                               not on master), UIAUDIT data as
                                               then; sudo rule removed before it
                                               was taken. Kept separately; not a
                                               base for a public release
```

`v0.8.4-verified` is the clean base for the next release's rehearsal (the previous
release is then v0.8.4). The v0.8.4-verified checkout has no v0.8.4 tag (upgraded
by sha before tagging); identify the base by HEAD 5891f99, not git describe. Before trusting any snapshot as a base, check the active
build, the git tag and the migration count (`SELECT count(*) FROM
_prisma_migrations`); never assume.

#### Using the VM for tests

- **Confirm no other session (including the mobile-app project) is active** before
  starting.
- **`pre-P7` contains the temporary sudo rule**, so the rule comes back on every
  revert to `pre-P7` and must be removed again at the end of the session.
- **Check the clock first after any revert or resume**, before anything
  time-dependent (2FA codes, reset links, session expiry). Compare `date -u`
  against this PC; do not trust `timedatectl`'s "synchronized" line (it still says
  "no" after a good start on 2026-10-15). A restored snapshot can be anything from
  seconds to almost three days behind.
- **Use Incognito windows for browser checks.** The ordinary Chrome profile keeps
  Secure-only cookies and cached HTTPS redirects from the staging setup, which
  break plain-HTTP sign-ins. One Incognito window can hold one staff and one portal
  session; two staff accounts need two separate browsers.
- **Security checks need a control** that must succeed in the same window.
  Address-bar URLs do not carry the portal sign-in, so use a script in the
  signed-in window.
- **Upgrade with a release tag or a full commit sha, never a branch name**, and for
  a rehearsal use the VM's *existing* `upgrade-native.sh` so the previous
  release's own script is exercised.
- The built-in browser pane of the desktop coding app is a separate browser with
  its own cookies; it can hold a second staff session next to Incognito.
- `psql` over an interactive session paginates; use `psql -P pager=off`.
- **Give the owner commands that survive Windows PowerShell.** Use one
  single-quoted remote command with no inner double quotes, or ask for Git Bash.
- **VMware Tools are not running in the guest,** so `vmrun stop soft` fails. Power
  off from inside (`sudo shutdown -h +0`) before taking a snapshot.

## 3. Release history

### v0.8.5: released 2026-11-03 (commit `3ae6d6da`, tag `v0.8.5`)

Release: https://github.com/stemAGH/openestate/releases/tag/v0.8.5. Advisory
**GHSA-vfmf-36cm-8fg7** (Low, 3.3; session isolation; affects up to 0.8.4),
published 2026-11-03.

- Every sign-in, sign-out or session end gives the staff app and the portal a new,
  empty data cache, and old requests are cancelled and their replies discarded.
- A tab accepts renewed access only for the same user, company and app (and, on
  the portal, the same customer or broker); otherwise it signs itself out with
  "Your session has changed" and resends nothing.
- No migrations, settings or permission changes. **Needs Chrome/Edge 116, Firefox
  124 or Safari 17.4**; only Chromium was tested.
- Master CI on the release commit: 6 of 8 jobs passed; the lock-timeout and
  orphan upgrade variants failed because they need migrations this release
  doesn't have (owner accepted; fix is in `docs/todo.md`).

### v0.8.4: released 2026-10-15 (commit `5891f99`, tag `v0.8.4`)

Release: https://github.com/stemAGH/openestate/releases/tag/v0.8.4. Advisory
**GHSA-x58f-9wjq-rjgj** (Low, 3.3; refresh-token gaps; affects up to 0.8.3).

- The API listens on `127.0.0.1:3000` only (`API_HOST` to change).
- `upgrade-native.sh` refuses to go back to an older version, or to one whose code
  lacks changes the database already has, and names the commit it deploys.
- 71 foreign keys the database lost in v0.2.0 are enforced again (three became
  `ON DELETE RESTRICT`); an orphaned link is kept "not valid" and reported, never
  fixed silently.
- The append-only escape hatch is superuser-only; the portal-link check's function
  belongs to a role that cannot log in.
- New default permissions reach existing system roles on upgrade (per-role seed
  baseline), without taking anything away.
- `restore-native.sh` works on a fresh server; the pnpm "Failed to create bin"
  warnings and the stray folder are gone for upgrades run with the v0.8.4 script.
- Every write to a user's refresh tokens takes one per-user lock, so two refreshes
  at once no longer sign a user out; ending a user's sessions (password or 2FA
  change, deactivation, ...) bumps the session version and revokes the tokens in
  one transaction, and a refresh signs with the version it read under the lock.
- The repository moved to https://github.com/stemAGH/openestate.
- **Known limitation:** delayed-payment interest can't be switched on for a booking
  (v0.9 top item).
- **Operators upgrading from v0.8.3** see four harmless pnpm warnings (v0.8.3's
  own build code), should run `check-foreign-keys.sh` once afterwards, and can
  delete `/opt/openestate-src/apps/openestate`. See the release notes.

### Earlier releases (short)

- **v0.8.3** (2026-10-10, `1f48533`): broker portal document access fix
  (GHSA-gq5m-m6q6-x32p, Low 3.1), sessions that end at once
  (`users.authz_version`), upgrade-script fetch fix.
- **v0.8.2** (2026-10-02): administrators can't act beyond the permissions they
  hold (GHSA-6qrx-8q6w-hvgj, High 7.2).
- **v0.8.1** (2026-09-27): staff and portal sessions separated
  (GHSA-f2p6-fphp-6mjg, Medium).
- **v0.8.0** (2026-09-25): Aadhaar guard on custom fields.
- Full list: `CHANGELOG.md`.

### CVE status

- **GHSA-vfmf-36cm-8fg7:** CVE requested 2026-11-03 at publication; no number yet.
  Check the advisory page around 2026-11-10.
- **GHSA-x58f-9wjq-rjgj:** CVE requested 2026-10-15; no number yet.
- **GHSA-gq5m-m6q6-x32p:** re-requested 2026-10-15 (none was assigned at
  publication on 2026-10-10); no number yet.
- **Re-check both around 2026-10-22** on the advisory pages and re-request any
  that still have none.

## 4. Next

**PR #78 first.** The `v0.9-interest-rule` branch (PR #78; GitHub head
`e92babe`, local worktree `C:\Users\Ashis\Desktop\Claude Code\openestate` at
`d67c7ed` with 10 uncommitted files) is unfinished. It now conflicts with master
(v0.8.5 changed the version fields and release docs), so bring the new master in
with a merge, never a rebase, once the uncommitted work is committed or set aside.
Then the v0.8.5 follow-ups in `docs/todo.md`: version-aware upgrade CI variants,
and the three LOW session-isolation usability items.

**v0.9, "pilot readiness".** Everything is written up in `docs/todo.md` (the
"v0.9 'pilot readiness'" entry at the top lists it). In order:

1. **The interest-rule gap: built, waiting for the VM rehearsal.** Branch
   `v0.9-interest-rule`, built to the owner's rulings (a)–(j) (see the
   `docs/todo.md` entry). Next: the owner confirms no other session uses the VM
   and puts the sudo rule in place, then the rehearsal from `v0.8.4-verified`
   with the installed v0.8.4 `upgrade-native.sh`, upgrading by full commit sha.
   CHANGELOG and release-notes drafts are in the branch.
2. "Log out everywhere" should also bump the session version, so other devices'
   access tokens end at once rather than within 15 minutes.
3. The cookie-ordering follow-up (which cookie the browser keeps after two
   overlapping refreshes).
4. Indexes on the 70 unindexed foreign-key columns.
5. The erasure CLI hard-delete tool (item Q; needs the CA and lawyer answers).
6. Upgrades refreshing the installed systemd unit.
7. Root scripts: nothing under `scripts/` is linted; ESLint finds 17 `no-undef`
   errors in the two `.mjs` files (Node globals not configured).
8. A fragile super_admin test: "no super_admin role at all" fails whenever
   another test file has created a super_admin role, because the super_admin
   sync is unscoped across the shared test database. Likely fix: a scope
   parameter, as done for `syncLeadStages`.
9. Audit rows: the upgrade's `ROLE_PERMS_CHANGED` rows list permission keys,
   while the Roles screen's rows list permission ids. Make them consistent.

## 5. Open owner items

1. **Rotate all test-VM passwords and the Cloudflare tunnel token. This is the most
   important item.** One password was exposed in a chat session, and the tunnel
   token (installed 2026-10-02) was typed on a command line, so it is in the VM's
   auth log and shell history. Rotate the token in the Cloudflare dashboard. The
   tunnel has no ingress rules and cannot connect from this network.
2. **Decide whether the mobile-app staging setup on the VM is still needed.** If
   not, remove it; if so, its self-signed certificate expires 2026-11-06.
3. **Claim the old GitHub name as an organization,** if not yet done, so nobody
   else can register it (the old address still redirects to the new one).
4. **Find a chartered accountant for real-estate GST and TDS.** Needed for the
   interest treatment, rescheduling an installment that has interest, the erasure
   tool's retention rules, and the numbers a pilot will rely on.
5. **Approach a pilot builder.**
6. **Ask a lawyer about DPDP consent, erasure and retention.**
7. **Re-check the CVE requests** (see section 3): the two from October, and
   GHSA-vfmf-36cm-8fg7's around 2026-11-10.
8. **Decide whether to delete the v0.8.5 verification leftovers:** the containers
   `t22-disposable-pg` and `t22-disposable-redis`, the clone `C:\oe-t23`, the
   worktree for this docs branch, and `~textopen/oe-rehearsal/` on the VM.
9. **Decide whether to turn 2FA back on for the `2fa` test account** in the VM
   fixture, so 2FA can be checked by hand in a browser.

## 6. Roadmap

- **Shipped:** all eight build phases (v0.1.0) and the v0.2 to v0.8 releases:
  plotted inventory, lead stages and reports, manager hierarchy, admin reset
  links and admin 2FA reset, audit fixes, the Aadhaar guard, session and
  authorisation security fixes, v0.8.4's database and upgrade hardening, and
  v0.8.5's session isolation in the browser.
- **v0.9 pilot readiness:** section 4.
- **Planned, no release assigned:** uploaded documents for applicants and bookings
  (`docs/plans/uploaded-documents-plan.md`) and booking custom fields. The plan's
  release numbers (documents at v1.0.0, deploy plumbing at v0.9.0, the deferred
  column drop after) predate the "pilot readiness" naming and need reconciling
  when v0.9 is scoped.
- **Waiting on outside answers:** the interest-rescheduling flow (CA), the erasure
  tool (CA and lawyer), phone-as-identifier handling and per-company dedup
  strictness (approved, not built).
