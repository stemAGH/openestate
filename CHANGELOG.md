# Changelog

All notable changes to OpenEstate are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Draft for v0.9.0; release notes draft:
[v0.9.0](docs/releases/v0.9.0-release-notes.md). Two migrations: one adds
`bookings.interest_from_date`, and both switch the booking-to-interest-rule link
to refuse deletes (added NOT VALID, then validated when no row points at a
missing rule). No new environment variable.

### Added

- **Delayed-payment interest can be switched on for a booking.** Choose a rule
  (or "No delay interest") in the booking wizard, or attach, change or remove one
  later from the installment schedule's new "Delay interest" panel, which also
  has "Accrue interest now". Interest runs only from the day the rule is
  attached; changing or removing a rule charges interest up to that day under
  the old rule first, and interest already charged is never recalculated. Only
  simple-interest rules can be attached for now. A transfer carries the rule to
  the new booking from the transfer date. API: `PUT /bookings/:id/interest-rule`.
- **New permission `postsales.interest.manage`** (attach, change or remove a
  rule), for Accounts and Company Admin. Manual accrue accepts it or the
  existing waive permission.
- **The upgrade prints how many active bookings have no interest rule.** None is
  attached automatically.

### Changed

- **A rule attached to an active booking keeps its rate.** Changing its rate type
  or rate in Masters is refused with a message; it can't be deleted while a
  booking uses it (the database refuses, and the app says so). Renaming or
  marking it inactive still works.

### Fixed

- Two accrual runs for one booking at the same moment could charge the same
  period twice. Accrual now takes a per-booking lock.
- The manual accrue action could charge interest on a cancelled or transferred
  booking.
- After an upgrade that adds permissions, some users could be signed out for up
  to a minute.

### Upgrade notes

- `postsales.interest.manage` reaches existing Accounts and Company Admin roles
  only on an install that has been on v0.8.4. From v0.8.3 or older it is listed
  under "System roles that differ from their default permissions"; grant it in
  Admin → Roles.

## [0.8.4] - 2026-10-15

A hardening release: it protects upgrades and the database, and **it changes
some behaviour**; read "Behaviour changes" before upgrading. Five migrations: two
change only database ownership and access rules, two restore 71 links between
tables, and one adds a table (`role_seed_baselines`). No new required
environment variable; one optional (`API_HOST`). Release notes:
[v0.8.4](docs/releases/v0.8.4-release-notes.md).

### How to upgrade

```bash
cd /opt/openestate-src/deploy/native
sudo ./upgrade-native.sh --ref v0.8.4
```

- **Give the release tag, never a branch name**, as before.
- **This upgrade prints four harmless pnpm warnings** ("Failed to create bin at
  /opt/openestate-src/apps/openestate/releases/…"). Your installed v0.8.3 script
  builds it, and its build code has the bug v0.8.4 fixes. The release is complete.
  The same bug has left a small folder, `apps/openestate`, in your source checkout
  on every install and upgrade; you can delete it (see the release notes).
- **Afterwards, run `sudo /opt/openestate-src/deploy/native/check-foreign-keys.sh`
  once.** It only reads, and lists any of the 71 restored links that existing rows
  keep "not valid". The v0.8.3 script can't print that list itself.
- **If the upgrade stops at a migration** and the next attempt says "P3009", mark
  the failed migration as rolled back with the one command in the release notes,
  then run the upgrade again.

### Behaviour changes

- **The API listens on `127.0.0.1:3000` only.** Until now it listened on every
  network interface, so anyone on your network could reach port 3000 directly and
  skip nginx. Installs using the bundled nginx see no difference. If something
  reached port 3000 from another machine (a remote reverse proxy, load balancer or
  monitoring check), set `API_HOST=0.0.0.0` (or the address to listen on) in
  `/etc/openestate/openestate.env`, restart the service, and firewall port 3000 so
  only that proxy can reach it. The API now believes forwarded headers only from a
  proxy on the same machine.
- **The upgrade script refuses to go backwards.** From v0.8.4, `upgrade-native.sh`
  stops before backing up, building or changing anything if the version you name is
  older than the one running, or if your database has changes that version lacks.
  There is no option to force it; to go back, restore the backup taken before your
  last upgrade. It also checks that what it builds is exactly the commit it
  downloaded, and prints it ("Deploying <commit> (<version>)").
- **An installment with interest charged can't be deleted, and an interest rule
  with charged interest can't be deleted.** Editing a payment plan in a way that
  would remove such an installment, or deleting such a rule, is refused with a plain
  message. (No interest is charged in practice yet; see Known limitation.)
- **An applicant or broker who has a portal account can't be hard-deleted in the
  database.** The app never hard-deletes them; this matters only to someone
  deleting rows directly.

### Security

- **The append-only escape hatch is superuser-only.** The database setting that
  lets maintenance change or delete ledger, receipt-allocation, TDS, interest and
  commission-ledger rows used to work for any database role, including the ones
  the application logs in as. It now works only for the `postgres` superuser.
- **The v0.8.2 portal-link check can no longer be switched off by the
  application's system role.** That role owned the database function behind the
  check, so it could drop it (and the trigger with it) or weaken it. The function
  now belongs to a role that cannot log in. Hardening, not a reported
  vulnerability: using it needed the system role's database password.
- **The API is no longer reachable on port 3000 from the network** (see Behaviour
  changes).

### Fixed

- **71 links between tables are enforced by the database again.** A migration
  in August 2026 (v0.2.0) removed them by accident. They are restored: every new
  or changed row is checked. Existing rows are checked too, and a link whose
  existing rows point at something that no longer exists is kept "not valid"
  instead of stopping the upgrade; the upgrade prints those, and
  `deploy/native/check-foreign-keys.sh` lists them at any time. No row is changed
  or deleted.
- **Editing a payment plan no longer deletes an installment that has interest
  charged**, and deleting an interest rule that has charged interest is refused.
  Both now get a plain message instead of leaving records pointing at nothing.
- `restore-native.sh` creates the database roles a backup refers to before
  loading it, so a restore onto a fresh server works.
- **No more "Failed to create bin" warnings or stray `apps/openestate` folder** on
  installs and upgrades made with the v0.8.4 scripts (a pnpm bug). Folders left by
  earlier versions stay until you delete them.
- **The upgrade script names the commit it deploys** and stops if what it would
  build differs from what it downloaded.
- **Two refreshes at the same moment no longer sign a user out** (staff and
  portal), for example when a browser restores several tabs at once. Every change
  to one user's sign-in tokens (sign-in, refresh, sign-out, and ending sessions
  after a password, 2FA or account change) now happens one at a time for that
  user, so each sees the others' results. Ending a user's sessions now also ends
  a refresh that is in progress at that moment.
- A flaky test in the database package no longer fails CI at random.

### Added

- **New default permissions now reach existing system roles on upgrade.** Each
  system role remembers the default permission set it was last synced to; an upgrade
  adds only permissions that are new to that default. A permission an admin removed
  stays removed, and nothing is ever taken away. The first upgrade records the
  starting point, adds nothing, and prints how each role differs from its default
  for an admin to review.
- **The repository moved to https://github.com/stemAGH/openestate.** The upgrade
  script switches a source folder that still points at the old address to the new
  one (keeping https or ssh) and says so; a fork or mirror is left alone.
- **Checks that keep the database's protections in place:** CI compares every
  constraint and trigger with a committed list and proves every foreign key refuses
  a bad row, and a new migration may not drop a constraint, trigger, policy or
  function unless it is marked and approved.
- **CI upgrades from the previous release** with that release's own script, in three
  variants (a clean database, one with an orphaned row, and one where a busy table
  makes a migration time out and the documented recovery is used), and checks that
  going back is refused.

### Known limitation

- **Delayed-payment interest can't be switched on for a booking.** Interest rules
  can be set up, but nothing in the app attaches one to a booking, so no interest is
  charged in practice. A fix is planned for v0.9.

## [0.8.3] - 2026-10-10

A security release. **Every install should upgrade.** Two migrations: one adds a
column (`users.authz_version`), the other only changes database access rules (no
table or data changes). No new environment variable; no change to install, backup,
restore or uninstall. Advisory:
[GHSA-gq5m-m6q6-x32p](https://github.com/stemAGH/openestate/security/advisories/GHSA-gq5m-m6q6-x32p).

### How to upgrade

```bash
cd /opt/openestate-src/deploy/native
sudo ./upgrade-native.sh --ref v0.8.3
```

- **Always give the upgrade script a release tag, never a branch name.** The
  `upgrade-native.sh` that ships with v0.8.2 and earlier, run with
  `--ref master`, checks out the *local* copy of `master` in your source
  checkout, which is usually weeks behind GitHub, and silently builds and installs
  that old code over your newer database. A tag is safe. (From v0.8.3 on the script
  fetches exactly the ref you name.)
- **If the upgrade stops with "would clobber existing tag"** (a clone made before
  the repository's history was rewritten), force the tag fetch once, then run the
  upgrade again:

  ```bash
  sudo git -C /opt/openestate-src fetch --tags --force origin
  cd /opt/openestate-src/deploy/native && sudo ./upgrade-native.sh --ref v0.8.3
  ```

- **The server clock must be time-synced.** `timedatectl` should say
  `System clock synchronized: yes`. A wrong clock makes 2FA codes and
  password-reset links fail, and a virtual machine resumed from a snapshot can have
  a stale clock while still reporting "synchronized". Check `date` after resuming
  one.

### Security

- **A broker portal session could download a customer's stored documents.**
  Reaching a document needs its ID, which the portal never lists to a broker, so
  this is hard to exploit; it needs a signed-in broker account (Low severity).
  Through the document download routes, a signed-in broker could fetch any stored
  document (receipts, statements, demand letters, and the staff-only allotment and
  reminder letters) belonging to a booking that broker sourced. The database access
  rules behind the portal also let a broker session read the installment, payment
  plan, receipt, receipt allocation, ledger and document-dispatch rows of such
  bookings; we found no route that returned those rows to a broker. Fixed in both
  places.
  A broker session can now only fetch its own commission statements; a customer
  session only the types its portal lists (statement, receipt, demand letter) and,
  as before, only for its own bookings; and the database rules no longer give a
  broker session access to any customer booking or money row. Customers could never
  reach another customer's documents: for them the only change is that they can no
  longer fetch, by ID, types their portal does not list (the staff-only allotment
  and reminder letters), for their own bookings. A customer's own access, including
  a co-applicant's, and staff access are otherwise unchanged. Affected: all
  versions up to 0.8.2. The rule change uses `ALTER POLICY`, so there is no moment
  during the upgrade when the portal scope is missing. No data is changed and
  nothing needs cleaning up afterwards.

- **A session now ends the moment it stops being authorised (UA-116).** Until
  now an access token stayed valid until it expired (up to 15 minutes), because
  the token was never checked against the database: a deactivated user could keep
  working in an open browser. Every signed-in request (staff and portal) is now
  refused with 401 "Your session has ended. Please sign in again." once, since the
  token was issued, the user was deactivated, their role changed, their role's
  permissions were edited, their password was changed or reset by an admin, or an
  admin reset their 2FA, or the user turned their own 2FA on or off (other
  sessions end; the browser it was done in refreshes once); re-inviting an
  existing portal account (which replaces
  its password) counts as a password change. The browser first tries to refresh:
  a session that is still allowed (for example after a role edit) carries on with
  a new token; one that is not lands on the sign-in page with that message. A
  self-service password change keeps the browser it was made in signed in and
  ends every other session, as before. Each user carries an authorisation version
  (one new column, `users.authz_version`), copied into every token and compared on
  each request through a Redis cache shared by all API instances (updated in the
  same code that changes the version; about 1 ms per request locally). If Redis
  is unavailable the check reads the database; it never lets a request through
  unchecked. Limits: `reset-admin-password.sh` and the upgrade's permission sync
  change the version in the database but cannot reach Redis, so a session they end
  stops within 60 seconds instead of at once. Every session open at the moment of
  upgrade is asked to refresh once (tokens issued before this version carry no
  authorisation version); nothing is visible unless the refresh token has also
  expired.

- **A token without a `surface` claim is now refused.** Since v0.8.1 every
  access and 2FA-pending token carries a signed `surface` claim (`staff` or
  `portal`). The guard still guessed the surface of a claim-less token from its
  customer or broker ids, so that sessions issued before v0.8.1 would keep
  working. That window has passed: a token with no valid claim now gets 401
  ("Your session is out of date. Please sign in again.") on every route. Access
  tokens live 15 minutes, so in practice nothing is visible: the browser's silent
  refresh issues a token with the claim. Tokens that carry a claim are unaffected;
  a wrong-surface or inconsistent claim is still 403.

### Fixed

- **`upgrade-native.sh --ref` no longer stops silently on a diverged tag.** It
  used `git fetch --tags && git checkout`, which git refuses on a clone made
  before the history rewrite (tags `v0.1.0` to `v0.7.1` point at old commits:
  "would clobber existing tag"); the script then exited after its backup without
  saying why. It now fetches only the requested tag or branch, forced, and any
  download failure stops the upgrade with a plain-English message before
  anything is built or changed. A CI test covers a diverged local tag and is
  itself checked against the old line. Limit: an install still running the old
  script needs the one-time `git fetch --tags --force origin` (see the
  installation guide) to reach this version.

- **Audit log times were wrong by the server's time zone offset.** Rows written
  by the generic audit trail (every create, update and delete on a record) took
  the database session's local clock instead of UTC, while the application reads
  those columns as UTC. On a server whose PostgreSQL time zone is not UTC (for
  example Asia/Kolkata) they were stamped 5 h 30 min in the future, so the Audit
  Log showed wrong times and, because it sorts by that value, an out-of-order
  timeline next to the correctly stamped sign-in and password events. New rows
  are now written in UTC. **Rows written before this upgrade are not changed**:
  on a server not in UTC, older create/update/delete entries may still show times
  offset by the server's time zone (by 5 h 30 min on Asia/Kolkata); nothing is
  lost, and a server running in UTC is unaffected. The same fix applies to five
  other raw timestamps: when a staff or portal password-reset link, a portal
  invite or an invite burned by too many wrong attempts is marked used, when the
  round-robin assignment last picked a team member, and when a webhook endpoint
  was auto-disabled. (On a non-UTC server, round-robin order may favour members
  already assigned before the upgrade for up to the zone offset in hours, then
  settles.) `number_sequences` timestamps are deliberately unchanged.

## [0.8.2] - 2026-10-02

A security fix. **Every install should upgrade.** One migration (a database
trigger; no table or column changes); no new environment variable; no change
to install, backup, restore or uninstall. Advisory:
[GHSA-6qrx-8q6w-hvgj](https://github.com/stemAGH/openestate/security/advisories/GHSA-6qrx-8q6w-hvgj).

### If your upgrade stops with "would clobber existing tag"

This affects installs whose source checkout was cloned **before the repository's
history was rewritten**. On those copies the tags `v0.1.0` to `v0.7.1` still point
at the old commits, and git refuses to overwrite them. `upgrade-native.sh` takes
its backup, then exits right after git prints `[rejected] ... (would clobber
existing tag)`; it prints nothing of its own. Nothing has been changed and your
current version keeps running. Copies cloned after the rewrite are not affected.

Fix: force the tag fetch (the public tags are authoritative, and nothing of yours
lives in a tag), then run the upgrade again:

```bash
sudo git -C /opt/openestate-src fetch --tags --force origin
cd /opt/openestate-src && sudo ./deploy/native/upgrade-native.sh --ref v0.8.2
```

### Security

- **An administrator could act beyond their own permissions.** Anyone who
  could create or edit users, or edit roles, could give any user, including
  themselves, a role holding permissions they did not have (up to
  `super_admin`), issue a password-reset link or clear the 2FA of any
  user they could manage (so the link was shown on their screen and later
  actions were recorded under the victim's name), deactivate a
  `super_admin`, or add permissions to a role, including their own.
  Confined to one company; no cross-tenant access. Every such action is
  now checked against the caller's **current** permissions in the database
  (not the token they logged in with): you can only act on a user, or grant
  a role, whose permissions you already hold; nobody can change their own
  role; only a `super_admin` can act on a `super_admin`; and the last
  active `super_admin` cannot be demoted or deactivated.
- **An account with a customer or broker role but no applicant/broker link
  could sign in to the staff app** (all versions up to 0.8.1; 0.8.1 only
  stopped new ones being created). Staff login, 2FA verify and refresh now
  refuse any account whose role is a portal role, and a database trigger
  rejects creating or editing such an account. Existing ones are not
  changed: `upgrade-native.sh` lists them after migrating.

### Changed

- **Behaviour changes to know about:**
  - Nobody can change their own role (ask another administrator).
  - Only a `super_admin` can edit, deactivate, reset the password or 2FA of,
    or change the role of a `super_admin`. The last active `super_admin`
    cannot be demoted or deactivated.
  - You can only give a user, or a role, permissions you hold yourself.
    Two administrators with identical permissions can still act on each other.
  - **The `super_admin` role's permissions can no longer be edited, and the
    role cannot be deleted.** It always holds every permission (the upgrade
    keeps it complete), and the slug `super_admin` is reserved. Edit other
    roles as before.
- Editing a role's permissions now writes an audit row (`ROLE_PERMS_CHANGED`).

### Workarounds (until you can upgrade)

Grant user- and role-management permissions (`admin.user.*`, `admin.role.*`)
only to administrators you fully trust, and review any custom role that
holds them.

### After upgrading

Review who holds `super_admin` or `company_admin`, and any custom role with
user- or role-management permissions. Review `RESET_LINK_ISSUED` and
`TOTP_RESET_BY_ADMIN` audit rows. The upgrade output lists any unlinked
portal-role accounts: deactivate them or give them a staff role.

## [0.8.1] - 2026-09-27

A security fix. **Every install should upgrade.** One migration (row-level
data only, no schema change); no new environment variable; no change to
install, backup, restore or uninstall.

### Security

- **Portal sessions could reach staff API routes.** A signed-in customer
  or broker on the portal could call staff API routes: the server didn't
  check which login a session came from, only which permissions its role
  held. The seeded broker role held one staff permission (for its
  dashboard), so any broker could read the staff broker reports: every
  broker's commission figures and contact details, and customer-level
  detail of other brokers' bookings. Separately, a customer or broker
  account could sign in through the staff login and get a staff session.
  Each session is now tied to the login it came from, and a portal
  session is refused on every staff route (and a staff session on every
  portal route), whatever its role's permissions.
- **Affected versions:** all releases up to and including 0.8.0.
- **You can't tell whether this was used.** Reads aren't audited. nginx's
  access log records each request's path, status and client address, but
  not the access token, so a broker reading `/api/v1/reports/brokers/...`
  looks the same as a staff user doing their job. An install has no
  reliable record of which API calls a portal session made.
- **Staff login refuses portal accounts.** Customers and brokers can no
  longer sign in through the staff login; they use the portal as before.
  Each surface's 2FA step also accepts only its own sign-in.

### Changed

- **The upgrade removes staff permissions from customer and broker roles.**
  Portal roles can now hold only portal permissions. The upgrade removes
  any others, including ones an admin granted on purpose, prints how many
  it removed and from which roles, and writes one audit row per role
  changed (visible in Admin, Audit Log). On a default install it removes
  one: the broker role's `reports.broker.view`.
- **The broker dashboard has its own permission**,
  `portal.broker.dashboard.read`, granted to the broker role on upgrade.
  **Brokers signed in during the upgrade may see an error on their
  dashboard for up to 15 minutes**, until their session renews; reloading
  the page fixes it sooner.
- **Admin, Roles:** a customer or broker role can only be given portal
  permissions, and the edit screen lists only those. The API refuses
  anything else with a message naming the permissions.
- **Admin, Users:** a customer or broker account can only be given a portal
  role, and a staff account only a staff role. A role from another company
  is refused with a clear error (it previously failed with a server error).

Database: one migration, `20260927120000_portal_broker_dashboard_permission`
(adds the permission and grants it to broker roles).

## [0.8.0] - 2026-09-25

A safety net against accidentally storing Aadhaar numbers in custom fields.
It is deterrence, not prevention, and its limits are listed below. One
migration (a column with a default, metadata-only); no new environment
variable; no change to install, upgrade, backup, restore or uninstall. One
new standalone, read-only script. Booking custom fields, once planned for
this release, are not in it.

### Added

- **Aadhaar safety net on custom fields.** OpenEstate does not collect
  Aadhaar numbers, and custom fields are free-form, so this adds three
  checks against *accidental* storage. It is a safety net, not a guarantee
  and not something to describe as blocking Aadhaar storage.
  - A custom field whose name or label refers to Aadhaar (Aadhaar, Aadhar,
    Adhaar, Adhar, or आधार) is refused when created or renamed, on the
    admin form, the API, and when installing a plugin that seeds one.
  - A value that looks like an Aadhaar number (12 digits, first digit 2 to 9,
    optionally grouped 4-4-4 with spaces or hyphens, with a valid Verhoeff
    check digit) is refused when a custom-field value is saved by staff.
    Values already stored are not re-checked, so an existing record can
    still be edited.
  - A field that legitimately holds a 12-digit number, such as a bank
    account, can be exempted (Admin, Custom Fields, "Allow 12-digit values").
    The change is audited, the field is badged in the list, and the exemption
    is refused on a field named after Aadhaar.
- **Machine-written notes are redacted rather than refused.** The inbound
  lead API, a plugin's lead creation and the Excel importer have no one to
  show an error to, so an Aadhaar-like number in the note they store is
  replaced with `[Aadhaar-like number removed]`.
- **Existing values are masked on detail screens and in the inquiries CSV
  export** (`XXXX XXXX 1234`). This is masking on display and export only:
  the raw value is still stored and is still returned by the API.
- **`deploy/native/find-aadhaar-like-values.sh`**, a read-only report of
  which custom fields already hold Aadhaar-like values, with counts and no
  values. It is standalone and is not run by install or upgrade.

**Limits, stated plainly.** About 1 in 10 random 12-digit numbers look valid
and are refused. A number with a single mistyped digit fails the checksum
and is not caught, and so is one written with other separators. The check
covers custom-field values only, not names, addresses, phone numbers,
notes or other free text (tracked in `docs/todo.md`).

Database: one new column, `custom_field_definitions.allows_twelve_digit_values`
(`NOT NULL DEFAULT false`, a metadata-only change). No new environment
variable.

## [0.7.1] - 2026-09-24

A security fix to the audit log: most create, update and delete actions
were never recorded, audit rows carried no user or IP address, and a
failed audit write could report success for a change that was never
saved. All three are fixed. No migration, no new environment variable,
no deploy-script change.

### Security

- **Most create, update and delete actions wrote no audit row.** Before
  v0.7.1, 53 write paths recorded nothing in the audit log, among them
  users, applicants and consents, projects, towers and units, brokers
  and commission rules, GST and TDS rates, letter and SMS templates,
  custom fields, follow-ups, NOC requests, communications, receipt
  reprints, and assigning a broker to a booking. **The missing history
  can't be recovered.** Treat audit history from before v0.7.1 as
  incomplete. These actions are audited from v0.7.1 on.
- **Audit rows had no user or IP address.** Nearly every row written
  before v0.7.1, including bookings and receipts, shows "System" in
  Admin → Audit Log instead of the person who acted. Rows now record the
  signed-in user and their IP, staff and portal. Background jobs and the
  inbound-lead API still show "System": no person made those changes.
- **A failed audit write could report success for a write that was never
  saved.** Before v0.7.1, if writing an audit row failed, the API could
  still report success (for example, 201 with an id) for a change that
  was never saved, including in the financial core. v0.7.1 makes such
  failures visible errors, and logs each one at error level with the
  record type, action and id, never field values.
- Audit rows no longer depend on a global setting to record money
  amounts, and secrets are redacted however deeply they're nested in a
  change.

### Still missing (tracked in docs/todo.md)

- An UPDATE row records the new values only, not the old ones.
- Bulk writes and upserts on audited records write no row: 14 places in
  the code, listed in docs/todo.md. **Changing a role's permissions
  (creating a role with permissions, editing them, deleting a role) is
  not audited.** Nor are: replacing a broker commission rule's slabs,
  setting a broker's primary bank account, moving inquiries to another
  stage when a lead stage is retired, re-pointing inquiries when
  applicants are merged, and creating a floor as a side effect of unit
  create or import. (The two bulk user updates in sign-in and password
  flows write their own explicit audit rows.)
- The audit log is protected by the application, not by the database: a
  database user with write access could still alter or delete rows.

## [0.7.0] - 2026-09-23

An admin can now clear a user's two-factor authentication, on staff and
portal accounts, and the break-glass script can do the same for a sole
admin. Until now, anyone who lost both their authenticator and their
recovery codes had no way back in: a password reset still left them at a
code prompt they couldn't answer. 2FA and password changes are now
written to the audit log. No migration, no new environment variable, no
new permission.

### Added

- **Admin 2FA reset for staff users.** Admin → Users → a user → *Reset
  2FA* (`POST /users/:id/reset-2fa`). Clears the TOTP secret, the recovery
  codes and any 2FA lockout, and signs the user out everywhere. Their
  password is unchanged; they sign in with it and can set 2FA up again.
  The button is disabled when the user has no 2FA. It isn't offered for
  your own account (use Settings) or for portal users (use their record).
  Deactivated users can be reset.
- **Admin 2FA reset for customer and broker portal accounts.** *Reset
  portal 2FA* on the customer's or broker's record in the staff app
  (`POST /admin/portal-2fa-resets`), with the same effect.
- **`reset-admin-password.sh --clear-2fa`**, for when the only admin has
  lost their phone and there is nobody to click the button. Without the
  flag the script resets the password as before and leaves 2FA on; if the
  account has 2FA on, it now says so on stderr and tells you to re-run with
  `--clear-2fa`.
- **Audit log entries for 2FA and password events**, staff and portal:
  `TOTP_ENABLED`, `TOTP_DISABLED`, `TOTP_RESET_BY_ADMIN` (in-app or from
  the script, with `surface` `staff`, `portal` or `cli`),
  `PASSWORD_CHANGED` (by the user, at first sign-in, or by accepting a
  re-sent portal invite) and `PASSWORD_RESET_USED`. None of them contains a
  password, a 2FA secret, a recovery code or a reset token.

### Fixed

- **Turning 2FA off didn't clear the 2FA lockout.** Someone who got
  locked out by wrong codes, turned 2FA off and straight back on within
  five minutes had the first code from their new authenticator refused.
  Staff and portal.
- **`reset-admin-password.sh` claimed to bypass 2FA "entirely".** It
  never did; its header and `--help` now say what it does.

### Security

- Resetting someone's portal 2FA needs `admin.user.update` (company admins
  and super admins), **not** the `admin.portal-invite.send` that gates the
  portal password-reset link. Sales managers hold the latter; holding both
  would let them take over a broker's account and approve NOCs as that
  broker.
- **After a 2FA reset, the user's other devices can stay signed in for up
  to 15 minutes.** The reset revokes every refresh token, so no session can
  be renewed, but an access token already issued stays valid until it
  expires (`JWT_ACCESS_EXPIRES_IN`, 15 minutes by default). If you are
  resetting 2FA because an account may be compromised, that window still
  applies.

### Upgrading

Nothing extra: no migration, no environment change, and the reset uses an
existing permission, so company admins have it straight after the upgrade.

## [0.6.1]

A bug-fix release. Staff users could not sign in with a two-factor recovery
code: the code field stopped accepting input after six characters, and
recovery codes are eleven. Separately, a recovery code typed in lowercase
was rejected on both staff and portal. No migration, no new environment
variable.

### Fixed

- **Staff recovery-code sign-in works.** The staff two-factor code field
  (`apps/web/src/pages/TotpVerify.tsx`) had a hardcoded `maxLength={6}`, so
  typing a recovery code (`XXXXX-XXXXX`) cut it off at `XXXXX-` and the form
  refused it before sending anything. A staff user who had lost their
  authenticator therefore had no way back in, because there is also no
  admin-side 2FA reset yet. The limit dates from Phase 1, when the screen
  was built; the portal field never had it. Found while verifying v0.6.0
  on a real install.
- **Recovery codes are accepted in lowercase and with surrounding spaces.**
  `totpVerifySchema`, shared by the staff and portal verify endpoints and
  the staff form, now trims and uppercases the code before checking its
  format. A phone keyboard that doesn't capitalise, or a code copied with a
  trailing space, no longer fails. The accepted codes, the rate limit and
  the lockout are unchanged.

### Added

- **A "Lost your phone? Use a recovery code" toggle on the staff and portal
  two-factor screens.** It changes the field's keyboard hint (`inputMode`
  from `numeric` to `text`, plus `autoCapitalize="characters"`,
  `autoComplete="off"` and spell-check off) and its label and help text.
  The field accepts a 6-digit code or a recovery code in either mode.
  Switching clears the field and any error.

### Not yet verified

- **The mobile keyboard behaviour is reasoned from `inputMode`, not
  verified on a real device.** The intent is a numeric keypad for the
  6-digit code and a full keyboard, able to type letters and the dash, in
  recovery mode. Each phone's browser decides which keyboard to show, and
  no real phone has been checked yet.
- **The recovery toggle has been exercised by Playwright but not looked at
  by a human.** The automated specs press real keys, check the wording and
  the keyboard hint, and sign in end to end on both surfaces. A manual pass
  is planned after the verification VM is upgraded to this release.

### Tests

- New Playwright specs sign in with a recovery code on staff and portal,
  typed with real key presses, and assert the field holds the whole code
  before submitting. They also cover lowercase input, the toggle, and a
  reused code being refused.
- A harness spec pins that Playwright's `fill()` and `pressSequentially()`
  respect `maxlength` in this Chromium, so a truncating field can't pass
  unnoticed after a browser upgrade.
- Schema unit tests, and an API test for a lowercase, space-padded
  recovery code.

## [0.6.0]

Two features: admins can now issue copyable, one-time password-reset links
for staff and portal users with no mail server required, and the staff and
portal login screens link to each other. Also closes four security gaps
found reviewing the reset-links work before merge.

### Added

- **Admins can generate a one-time password-reset link for a staff user**
  (`POST /users/:id/force-password-reset`, `ADMIN_USER_UPDATE`) or for a
  portal user — customer or broker — (`POST /admin/portal-password-resets`,
  `ADMIN_PORTAL_INVITE_SEND`). Both answer with a complete, ready-to-share
  URL and a 30-minute expiry, shown once on the Admin → Users, Applicant
  360, and Broker Detail screens with a Copy button. There is no mailer in
  this project by design, so delivery is the admin's job — WhatsApp, phone,
  in person — the same way portal invite links already work. A portal
  target with no portal account yet gets a clear "no portal account, send
  an invite instead" message rather than an error; a deactivated target is
  refused with 409. Issuing a new link for the same user immediately
  supersedes any earlier unused one for that user.
- **The staff and portal login screens now link to each other.** Staff
  login links to `/portal/`; portal login links back to `/`. Both are
  plain anchor tags, not client-side router links — the portal app is
  mounted under a `/portal` router basename, so a router-aware link from
  inside it would resolve back to itself. Correct in production, where
  both apps share one origin behind nginx; the two links 404 under
  `pnpm dev`'s separate dev-server ports, which is expected and not worth
  working around.

### Security

- **Admin-issued STAFF password-reset tokens no longer pass through
  `CommunicationProvider`.** This project's only communication provider
  logs message bodies in plaintext, so an admin-issued staff reset token
  previously reached the server log the moment it was issued. It now
  reaches only the admin who requested it, in the API response. **This is
  narrower than "reset tokens no longer reach logs":** admin-issued portal
  reset links never went through the provider to begin with, but the
  separate, self-service portal password-reset flow (a portal user
  requesting their own reset, with no admin involved) still sends its raw
  token through the same logging provider — that path is unchanged by
  this release.
- **Every other way a user's password gets set now consumes that user's
  outstanding reset links**, so a stale admin-issued link can no longer
  overwrite a password the user has since changed themselves. Covers
  staff change-password, staff force-change-password (first login), portal
  change-password, and portal invite consumption for an existing account.
- **A deactivated account can no longer redeem a password-reset link.**
  Both the staff and portal confirm endpoints now refuse an inactive
  account, and deactivating a user immediately consumes any outstanding
  reset link for them.
- **Reactivating a deactivated account does not revive a reset link that
  was consumed when the account was deactivated** — a link killed by
  deactivation stays dead even if the account is later reactivated.

## [0.5.0]

A security release. It closes a two-factor authentication bypass and makes
2FA codes resistant to guessing — both found during pre-launch review, see
the advisory in [SECURITY.md](SECURITY.md). It also ships everything merged
since v0.4.0: the Docker removal, plotted/farmhouse inventory, the lead-stage
pipeline, the pre-sales reporting suite and the fixes listed below.

### Upgrade notes — read this before upgrading

- **13 database migrations run on upgrade.** One of them,
  `20260914120000_user_totp_lockout`, adds two columns to `users`
  (`failed_totp_attempts`, `totp_locked_until`). Adding them is
  metadata-only, but `users` is read on almost every request, so the
  migration still needs a brief exclusive lock. `upgrade-native.sh` gives
  up after `MIGRATION_LOCK_TIMEOUT` (15s by default) and leaves the previous
  release running; if that happens, retry during a quieter period.
- **New optional setting: `TOTP_VERIFY_THROTTLE_LIMIT`, default 5** — 2FA
  code attempts allowed per user per 5 minutes. Leave it unset unless you
  have a specific reason; it's documented in
  `deploy/native/openestate.env.example`.
- **The step between entering a password and entering a 2FA code now
  expires after 5 minutes instead of 15.** Someone who takes longer than
  that to enter their code signs in again.
- Also read "Removed" (Docker is no longer an install path) and the
  minimum-password-length change under "Security".

### Removed

- **Docker is gone as an install path.** `deploy/docker-compose.yml`, the
  three Dockerfiles under `deploy/docker/`, `deploy/.env.example`,
  `deploy/nginx/*.conf` and `.dockerignore` are deleted, along with CI's
  container-build job and Dependabot's `docker` ecosystem entry.
  OpenEstate installs natively — `sudo ./deploy/native/install-native.sh`
  against a PostgreSQL/Redis/nginx you run yourself — which has been the
  only supported production path since native install became primary; the
  container stack had already been demoted to unsupported contributor
  tooling and is now removed rather than left to rot untested.
  **If you are still running the old Docker Compose stack**, nothing in
  this release touches a running container and nothing is removed from
  your server — but that stack will receive no further updates. Migrate
  by standing up a native install against the same database
  (`install-native.sh --skip-database` if your PostgreSQL is already
  provisioned) and pointing your reverse proxy at it.
- **Docker is gone from the repo entirely, including for tests.**
  `deploy/docker-compose.test.yml` and `deploy/docker/init-db/` are
  deleted too — no Dockerfile or Compose file exists anywhere in this
  project now. `scripts/test-setup.sh` provisions the test database
  against a PostgreSQL you already run, delegating role creation to
  `deploy/native/setup-database.sh` (the same script a real install
  uses) and writing a `.test-env` you `source` before `pnpm test`.
  Test Postgres/Redis moved from 5433/6380 to the standard 5432/6379,
  since the odd ports only ever existed to avoid colliding with the
  host's own services from inside a container. `teardown` drops only a
  database whose name ends in `_test`, never the roles (they're
  cluster-wide, and a developer may have another test database on the
  same cluster). Test provisioning's role names are now
  `openestate_test_app`/`openestate_test_system`, not
  `openestate_app`/`openestate_system` — see the "Security" section
  below for why, and for the shared-cluster guard this superseded and
  removed.

### Security

- **Fixed: a password alone could turn off or take over an account's
  two-factor authentication.** With 2FA on, signing in with a password
  returns a short-lived token that is only meant for the next step, entering
  the code. The server also accepted that token on other endpoints — the
  ones that set up, confirm and turn off 2FA, change the password, and sign
  out every session. Anyone who knew an account's password could therefore
  turn its 2FA off, or enrol their own authenticator app, sign in, take the
  new recovery codes and leave the real owner's authenticator rejected.
  Staff and customer/broker portal accounts were both affected. The token is
  now refused everywhere except code entry — including on any endpoint added
  in future — a normal session can no longer call code entry, and the token
  expires after 5 minutes instead of 15. Present in every release from
  v0.1.0 through v0.4.0.

- **Fixed: 2FA codes on staff accounts could be guessed by brute force.**
  Staff code entry had no rate limit of its own and wrong codes counted
  toward nothing, so anyone holding a password could keep guessing the
  six-digit code. (Portal code entry was limited per network address.) Both
  now allow 5 attempts per user per 5 minutes, however many addresses they
  come from, and 5 wrong codes in a row — TOTP or recovery codes alike —
  lock code entry for 5 minutes, answered with a 429 saying to wait and
  sign in again. That lock is separate from the password lockout, so wrong
  codes can't be used to lock an owner out of their own account, and a
  correct code clears it. Present in every release from v0.1.0 through
  v0.4.0.

- **Minimum password length raised from 8 to 12 characters, everywhere a
  password is set.** All 7 password-setting schemas
  (`packages/shared/src/user.dto.ts`'s `createUserSchema`,
  `auth.dto.ts`'s `changePasswordSchema`/`forceChangePasswordSchema`/
  `passwordResetConfirmSchema`, and `portal-auth.dto.ts`'s
  `portalInviteConsumeSchema`/`portalPasswordResetConfirmSchema`/
  `portalChangePasswordSchema`) move from `.min(8)` to `.min(12)`, with
  no composition rule, denylist, or strength library added — length
  only, per NIST 800-63B guidance that composition rules push users
  toward predictable patterns without meaningfully raising entropy.
  Login itself (`loginSchema`/`portalLoginSchema`) and the
  "confirm your current password" fields keep their existing `.min(1)`
  — those verify a password, they don't set one, so this is
  **prospective only**: an existing account's current password, of any
  length, keeps working for login indefinitely. The 12-character floor
  applies only the next time a password is set (self-service change,
  forced first-login change, admin-triggered reset, portal invite
  consume) — nobody is locked out by this release. The five frontend
  submit-button gates that mirrored the old `8` (`Settings.tsx`,
  both apps' `ResetPassword.tsx`, `Security.tsx`, `InviteConsume.tsx`)
  and `deploy/native/reset-admin-password.sh`'s own length check and
  help text move to 12 in the same commit, so the UI and the
  break-glass CLI can't accept what the API now rejects.

- **Deactivating a user (`POST /users/:id/deactivate`) now revokes their
  refresh tokens immediately.** Previously it only set `isActive: false`;
  `refreshTokens()` already checked that flag and correctly refused to
  renew, but nothing cut off an already-issued access token, so a
  deactivated user kept full API access until it expired on its own (up
  to `JWT_ACCESS_EXPIRES_IN`, 15 minutes by default). `UsersService
  .deactivate` now calls `TokenService.revokeAllForUser` right after the
  database write, the same pattern `AuthService.forceChangePassword`
  already uses. Portal-linked users (customer/broker accounts) are rows
  in the same `User` table and go through this identical endpoint — not
  a separate, mirrored implementation — so they're covered by the same
  fix, not a second one. No migration; already-deactivated users are not
  retroactively affected — deactivate them again (or reactivate then
  deactivate) if you need an existing deactivated account's old sessions
  cut off immediately.

- **Test provisioning no longer uses the same Postgres role names as a
  real install.** `scripts/test-setup.sh` (via
  `deploy/native/setup-database.sh --app-role-name/--system-role-name`)
  now creates `openestate_test_app`/`openestate_test_system`, not
  `openestate_app`/`openestate_system`. Postgres roles are cluster-wide:
  running tests against a cluster that also hosts a real install used to
  reset that install's role passwords to the throwaway test values,
  breaking it until its own `setup-database.sh` was re-run — a real
  incident, not a hypothetical one. Different names make the collision
  structurally impossible rather than merely guarded against, so the
  shared-cluster existence-check guard this used to require (refuse to
  provision on a cluster that already has an `openestate` database or
  `openestate_app`/`openestate_system` roles, override with
  `TEST_ALLOW_SHARED_CLUSTER=1`) is removed along with it — it no longer
  detects anything that can happen. A real install's own
  `openestate_app`/`openestate_system` are completely unaffected; this
  only changes what test provisioning uses.

### Fixed

- **Correctness bug: construction-linked payment plans could show a
  customer overdue, and accrue delay interest, against a construction
  stage the builder had not reached.** Every payment-plan milestone
  previously got a due date at booking time regardless of what it was
  meant to represent. Installments are now either DATE_LINKED (due at
  booking date + offset — unchanged behaviour) or STAGE_LINKED (no due
  date until a staff user marks the construction stage complete and
  raises demands for it, from a new "Construction Stages" panel on the
  project detail page). **This release does not retroactively reverse
  interest already accrued, or correct demand letters already issued,
  against a stage that may never have actually been reached** — those are
  ledger entries, and reversing them is a business decision only a human
  reviewing the specific booking can make, not something a migration
  should decide for you. **To find potentially affected rows, run
  `deploy/native/find-stage-suspect-interest.sh` on your install** — a
  read-only report (no write, ever) listing every `interest_accrual`
  against an installment whose label suggests a construction/handover
  stage (Excavation, Plinth, Superstructure, Finishing, On Possession,
  etc.), with the booking number, installment label, total accrued
  amount, and the date interest started accruing against it. This is a
  **label-text heuristic, not an exact identification** — the pre-fix
  schema never captured milestone intent, so there is no precise query;
  the script's own header explains exactly what it does and doesn't
  catch (see also its `--extra-terms` flag for a custom template's own
  stage-milestone labels).

### Added

- **`PORTAL_AUTH_THROTTLE_LIMIT` makes the portal-auth rate-limit bucket
  configurable** (`app.module.ts`), alongside the already-configurable
  `DEFAULT_THROTTLE_LIMIT` — both are now documented in
  `apps/api/.env.example` and `deploy/native/openestate.env.example`,
  where neither had been before. **Unset, the limit stays 5 requests per
  5 minutes per IP, exactly as before** — this changes no behaviour on
  any existing install. The bucket guards portal login, invite-consume
  and password-reset, so it should stay tight; the one legitimate reason
  to raise it is many portal users sharing a single public IP, where the
  5-per-5-minutes budget is shared across all of them rather than being
  per person. The immediate motivation is CI: Playwright's harness runs
  one API process for the whole suite, so every spec's portal login
  draws on one IP-keyed budget, which had been causing intermittent 429s
  in unrelated specs.

- **TOTP 2FA enrolment now shows a scannable QR code**, on both the
  staff Settings page (`/settings`) and the customer/broker portal's
  Security page (`/security`), instead of only a 32-character base32
  secret to type by hand. The manual-entry secret is still shown below
  the QR image as a fallback for a device that can't scan.

- **`Bank.ifscPrefix` (a real, optional Prisma column) is now exposed
  through the master API and admin UI**, via `master.factory.ts`'s
  existing `extraFields` mechanism — the same pattern that already
  exposed `AreaLocation`'s columns and `ChargeType.hsnSac`/`gstRateId`.
  Closes the last piece of docs/todo.md's "AreaLocation/Bank have real
  optional columns the API never exposes" gap (AreaLocation's half was
  already fixed in a prior session). Not read by any business logic —
  reference data only, so no format is enforced beyond the column's own
  11-character length.

- **Phase A of two-shape inventory (plotted / farmhouse groundwork).**
  Schema-only step: `Project.shape` (HIGH_RISE or LAND_BASED, immutable
  after creation), a shared `AreaUnit` enum (SQFT / SQYD / SQM / ACRE
  / GUNTA), new `inventory_groups` table for LAND_BASED grouping
  (Sector / Block / Cluster / Phase), and the columns a LAND_BASED
  `Unit` needs — `landAreaEntered` + `landAreaEnteredUnit` (source of
  truth for pricing, no divide-through-sqft rounding) plus derived
  `landAreaSqft` for reports, `landRecordRef`, `facing`, `lengthFeet`,
  `breadthFeet`, `rateUnit` (default SQFT), and an optional
  `builtUpRatePaise` for farmhouses that price land and structure
  separately. Existing HIGH_RISE units are backfilled with
  `shape='HIGH_RISE'` and their existing `floor→tower→project` walk;
  every existing booking's ledger stays byte-identical (verified
  directly against the migrated database). A row-level CHECK
  constraint (`units_shape_hierarchy_chk`) enforces the exact
  per-shape hierarchy — HIGH_RISE requires a floor and no group,
  LAND_BASED forbids a floor — so a wrong-shape row can never be
  written. LAND_BASED create/booking paths are NOT wired yet; this
  release only lands the schema so those follow-ups can be reviewed
  in isolation.

- **Phase B of two-shape inventory: LAND_BASED create/booking paths
  are now wired.** `POST /projects/:id/units/land-based` creates a
  plot directly on a project (no floor); `landAreaSqft` is always
  derived server-side from the entered (value, unit) pair, never
  accepted from the client. `GET/POST /projects/:id/inventory-groups`
  and `PATCH/DELETE /inventory-groups/:id` manage Sector/Block/Cluster
  grouping (deactivate, not hard-delete — a group's units simply
  ungroup, never silently vanish). The existing tower/floor-scoped
  endpoints now 400 with a clear message on a LAND_BASED project
  instead of creating an unreachable row. A new `BookingCostLineVerifier`
  recomputes a LAND_BASED booking's BASE cost line from the unit's own
  stored rate/area and rejects the request if the client's submitted
  amount is off by more than 1 paise — closes the same "trust the
  client's JS math" gap this project already tightened for GST
  place-of-supply, specifically for the harder LAND_BASED arithmetic
  (Decimal areas, per-acre rates in the tens of millions of paise).
  HIGH_RISE pricing is deliberately untouched — it has never been a
  computed rate-times-area value in this codebase, staff routinely
  negotiate an agreed price different from a unit's listed rate, and a
  strict verifier there would reject legitimate pricing, not catch a
  bug. The customer portal's property page now renders a LAND_BASED
  booking correctly (group name + plot number, or bare "Plot N" when
  ungrouped, plus the entered land area) instead of the raw tower/floor
  layout HIGH_RISE uses. New permission `inventory.inventory-group.manage`
  (granted to `company_admin` automatically via its existing wildcard;
  `sales_manager` gets it too, but — matching this project's own
  privilege-escalation-on-upgrade lesson — only on a fresh install or
  an explicit role edit, never auto-granted to an existing install's
  role on upgrade).

  Also fixed, found auditing every remaining `floor.tower.projectId`
  traversal for this release: a customer whose booking is against a
  LAND_BASED unit previously got a raw 500 on their own property page
  (`PortalPropertyService` read `.floor.tower...` unguarded) — worse,
  even a null-safe read would have found nothing, because four portal
  RLS policies (`projects_portal_scope` and three others) only reached
  a project via the same floor/tower chain, invisible to Postgres for a
  floorless unit. Both layers fixed; a LAND_BASED customer can now
  actually see their own project. Several report/list queries
  (`postsales-reports.service.ts`'s rollups and dues report,
  `unit.service.ts`'s list, `rate-revision.service.ts`, the units XLSX
  export, the construction-update notification fan-out, the project-edit
  confirmation dialog's booking count) had the identical traversal bug —
  silently returning zero rows for a LAND_BASED project instead of
  crashing, which is why they went unnoticed until this audit rather
  than being reported. All now resolve via `Unit.projectId` directly.

- **Phase C of two-shape inventory: staff app UI, and the create-project
  API gap this finally exposed.** `POST /projects` never accepted a
  `shape` field at all before this — every project has been HIGH_RISE
  by the database default, regardless of what a caller sent, since
  Phase A shipped the schema. The project-create wizard now has a
  shape picker (High-rise / Land-based, high-rise the default) and a
  default land-area unit shown only for a land-based project; `shape`
  is immutable after creation (rejected by the update endpoint, same
  treatment as the project code). Project detail's inventory tab is
  now shape-conditional — Towers for high-rise, Inventory Groups
  (Sector/Block/Cluster) for land-based, with its own plot create form
  (land area entered + unit, land record ref, facing, dimensions, rate
  unit, built-up rate) and a flat plot list with group and status
  filters. The booking wizard's unit-selection step gained an optional
  group filter for land-based projects, and — the one that actually
  protects real money — no longer pre-fills the agreed base price from
  a land-based unit's raw `baseRatePaise`, which is paise PER the
  unit's rate unit (e.g. per acre), not a flat price the way it is for
  a high-rise unit; it now computes the real total client-side (the
  same `computeBaseAmountPaise` formula the server's
  `BookingCostLineVerifier` already used to check it), with the server
  verifier remaining the authoritative check at submit either way.
  LAND_BASED bulk import/export gained its own XLSX column layout (no
  tower/floor columns, an optional group code and the entered-area
  pair instead) and a `GET /projects/:id/units/import-template`
  endpoint so the template can never drift from what a real upload
  requires — column choice is derived from the schema, not a real
  client sheet (none was available for this release); flagged as
  needing validation against a real LAND_BASED inventory sheet before
  a pilot import.

  Also fixed, found registering the new import-template route: `GET
  /projects/:id/units/export` and the new `import-template` route
  would have been silently swallowed by `UnitController`'s `GET :id`
  route (matching `id="export"`/`id="import-template"`) — the exact
  route-registration-order bug class this project's own v0.3.1 lesson
  documents for `GET /inquiries/import-template`. Reordered the
  controllers array with a comment explaining why the order is
  load-bearing, so a future cleanup doesn't silently reintroduce it.

- **Phase 0 of the feature-completion plan: a configurable lead-stage
  pipeline.** A new Admin → Lead Stages master lets a company define its
  own sales-pipeline positions (seeded by default with New, Contacted,
  Site Visit Scheduled, Site Visit Done, Negotiation, Documentation) —
  separate from, and orthogonal to, an inquiry's existing Open/Continued/
  Dumped/Successful status. `InquiryDetail` gained a Stage picker; every
  stage change (including the initial one at creation, from the
  interactive form, the inbound lead API, or bulk import) writes an
  append-only history row, so a lead's full stage trail is always
  reconstructible. Deactivating a stage that still has active leads on it
  requires picking another stage to move them to first — mirroring the
  existing booking-count confirmation pattern elsewhere in the admin
  screens; that reassignment is flagged in the history as an
  administrative move rather than a real pipeline advance, so a later
  funnel report can tell the difference between a rep converting a lead
  and an admin retiring a stage that happened to be holding thousands of
  them. Existing installs get the default pipeline delivered on
  upgrade, the same one-time-marker-gated delivery mechanism the
  permission-sync fix already established — an admin who has since
  renamed or deleted a seeded stage is never overwritten. This release
  lands the pipeline and the audit trail only; a Kanban-style board and a
  stage-based funnel report are separate, later phases. The stage
  currently marked default can't be deactivated until another stage is
  set as the default first, and a stage can only ever be retired by
  deactivating it — there is no delete.

- **Pre-sales reporting suite.** A single `Reports` screen under
  Pre-Sales, driven by one filter bar (date range, project, and a
  per-report executive/reason filter where relevant) and one reusable
  table/chart pattern, replacing the previous zero-UI state — every
  report in this release was already backend-only or entirely new; none
  had a screen before. Nine reports are new: Daily Work (per-user
  follow-ups logged / leads touched / stage changes / dispositions set),
  Leads by Stage, Dump report (by reason/executive/time), Site Visit
  report, Enquiry-type breakdown (Fresh/Resale/Rental/Commercial — a
  different axis from the existing Source-wise report, not a rename of
  it), Stage Transitions and Stage Velocity (`InquiryStageHistory`,
  excluding administrative bulk-reassignment moves), Follow-up Overdue
  (a live gauge, ignores the date filter by design) and Follow-up Delay
  (average gap between a follow-up's next-action date and the follow-up
  that actually closed it), Supervisor Review Queue (dumped + transferred
  leads, for the SOP-mandated weekly review), and Communication-type
  breakdown (`FollowUpType`, not `CommunicationType`). Two existing
  reports — Source-wise and Staff Performance — gained a second,
  **booking-linked** conversion percentage (via `Booking.sourceInquiryId`)
  shown side by side with the existing status-based one, never replacing
  it: the gap between "marked Successful" and "has a real booking behind
  it" is itself a signal a manager can act on. Every report is scoped
  through `TeamScopeService` (a sales exec sees their own data, a manager
  their subtree, an admin everything) — no report hand-rolls its own
  owner filter, enforced by a widened CI guard (see Fixed, below).
  Charts are hand-rolled inline SVG bar/donut, no charting library.
  CSV export and print are gated by two new permissions,
  `presales.report.export` and `presales.report.print`, kept separate
  from `presales.report.view` specifically so a role can read a report
  on-screen without being able to take customer PII out of the system —
  every export and print writes an audit-log row (who, which report,
  what filters, row count) before the response is sent, the control 4QT
  had as "Print/Download Track." Row-level reports (per-inquiry export,
  dump report, site visit, supervisor review queue) stream their CSV via
  the existing `streamCsv` utility instead of buffering.
  **Upgrade-path note**: `company_admin` and `sales_manager` inherit both
  new permissions automatically (the `presales.*` prefix filter in
  `roles.ts`), but only for a role created fresh from today onward — on
  an EXISTING install, that prefix filter doesn't retroactively re-grant
  anything, so an admin must grant `presales.report.export`/
  `presales.report.print` to those roles manually via Admin → Roles
  after upgrading if export/print access is wanted (view access needs no
  action — `sales_executive` already had `presales.report.view` before
  this release, and every role's existing grants are otherwise
  untouched). `sales_executive` gets `presales.report.view` only, not
  export or print, in both a fresh install and on upgrade (added
  directly to its `ROLE_PERMISSIONS` entry, not inherited via a prefix
  filter) — reports are already scoped to that rep's own data, but a
  portable CSV/print copy of it stays manager+ only by default.

### Fixed

- **Reloading a few times, or letting your browser restore several tabs,
  could log you out.** Every page load refreshes the session; if that
  response never reached the browser — you navigated again, the browser
  restored several tabs at once, the response was simply lost — the
  server had already consumed the token and issued a replacement the
  browser never received. Re-presenting the old one was then treated as
  token theft and killed the whole session. It landed you on the login
  screen with no explanation, and it could never be reproduced on
  demand. Refresh-token rotation now allows a short grace window
  (`REFRESH_REUSE_GRACE_SECONDS`, default 30) for re-presenting a
  just-consumed token when the session chain is otherwise intact.
  Genuine replay — after the window, or once the session has been
  revoked — still revokes everything exactly as before. Affects staff
  and portal alike; both share one rotation path.

- **An upgrade could hang indefinitely instead of failing.**
  `upgrade-native.sh` runs migrations before cutover, deliberately, while
  the previous release is still serving. A schema change needing an
  exclusive table lock therefore waits on live traffic — and with no
  timeout it waited forever, with later queries queueing behind it so the
  app froze rather than the upgrade merely being slow. Migrations now run
  with a `lock_timeout` (15s, override with `MIGRATION_LOCK_TIMEOUT`), so
  a contended upgrade aborts quickly and leaves the previous release
  running and untouched — the intended failure mode. If you hit the new
  error, retry during a quieter period.

- **A custom "Administrator" role saw only its own subtree.** Whether a
  role sees the whole company was decided by its slug being literally
  `company_admin` or `super_admin`, so a company that built its own
  full-permission admin role was silently scoped to its own reporting
  line — its dashboard and reports showed a fraction of the company with
  no error to explain why. That decision now keys off a permission
  (`admin.team-scope.all`), which the seeded `company_admin` and
  `super_admin` roles receive automatically, including on upgrade. Grant
  it to any custom admin-equivalent role of your own via Admin → Roles.
  Deliberately not granted to `sales_manager`: seeing your own subtree
  is the point of the hierarchy.

- **Manager-wise interaction counts silently ignored the team hierarchy,
  and the CI guard meant to catch exactly this class of bug didn't
  either.** `managerWiseInteractions` picked which users are managers via
  a bare `role: { slug: 'sales_manager' }` filter — a legitimate way to
  select the report's axis — but then counted only each manager's own
  directly-logged follow-ups, never `TeamScopeService`'s real subtree, so
  a manager's team roll-up silently undercounted the moment they had any
  reports. `team-scope-guard.test.ts`'s existing checks (a bare
  `SYSTEM_ROLES.SALES_EXECUTIVE` identifier; a bare
  `where.assignedToId =`/`where.createdById =` scalar assignment) didn't
  fire on this shape at all — a `role: { slug: ... }` query filter is
  neither. Found while building the reporting suite above; the guard was
  widened with a third check for exactly this pattern (verified it
  correctly failed against the pre-fix code before the method itself was
  fixed, the same discipline this project applies to every other
  guard/regression pair), and the method now calls
  `TeamScopeService.getVisibleUserIds` per manager to get their real
  subtree.

### Changed

- **TOTP enrolment's QR code (and otpauth URL) is now labelled with
  your email, phone, or name** (in that preference order) instead of
  the fixed literal "OpenEstate CRM" — makes it possible to tell
  accounts apart in an authenticator app that holds more than one.
  **No re-enrolment needed**: verification only ever checks the stored
  secret, never the label, so every existing 2FA enrolment keeps
  working exactly as before.

- **The dashboard's conversion figure no longer drifts.** It counted
  inquiries whose status was SUCCESSFUL and whose `updatedAt` fell in
  the current month — but `updatedAt` moves on ANY edit, so adding a
  note to a lead closed last year silently counted it as this month's
  conversion and changed a manager's team-performance number. Inquiries
  now carry a real `convertedAt`, stamped when the status becomes
  SUCCESSFUL and cleared if it moves back out.

  **Historical figures are approximate.** Inquiries closed before this
  release have `convertedAt` backfilled from `updatedAt` — the same
  approximation the old figure already used, so no number you have seen
  changes as a result of upgrading; they simply stop drifting from here
  on. Where a closed lead was edited after the fact, its recorded
  conversion date is that later edit, which is not recoverable after the
  fact and has not been guessed at. Figures from this release onward are
  exact.

## [0.4.0]

Lead ownership and manager hierarchy — the second half of the v0.3.1
pilot-user triage's "big one," deferred out of that release for its own
design pass. Adds `User.managerId` and a proper reporting-subtree
visibility model, fixes a real security bug found while auditing the
existing scoping, and changes what non-admin roles can see.

### Security

- **A sales executive could read, create, and update follow-ups on any
  colleague's inquiry, just by knowing its id — bypassing the
  inquiry-level scoping entirely.** `FollowUpController` only ever
  checked `companyId`, never whether the caller could actually see the
  parent inquiry. This is a live bug that has been shipping since
  follow-ups were built, not something introduced by this release — it
  surfaced during the audit for the manager-hierarchy work below. Fixed:
  every follow-up read/create/update now confirms the parent inquiry is
  in the caller's visible set first. If you have sales executives who
  shouldn't see each other's pipelines, upgrade — this was open on every
  prior version.

### Changed — behavioral change for existing installs, read this before upgrading

- **Before this release, every role except `sales_executive` — including
  `sales_manager` — saw the ENTIRE company's inquiries and reports.**
  Only `sales_executive` was restricted to their own queue; every other
  role had no real scoping at all, just a blanket "see everything."
  After this release, every role other than `company_admin`/
  `super_admin` sees only their own reporting subtree, computed from
  `User.managerId`. This is the correct behavior — it's the entire point
  of this release — but it is a real, visible change: **a user with no
  `managerId` set will see only their own leads after upgrading, even if
  they used to see the whole company.** Configure your org chart (set
  each manager's reports' `managerId`) after upgrading, before your
  managers ask where their team's leads went — otherwise this will look
  like the release lost their data, not like a permissions model working
  as intended.

### Added

- **`User.managerId`** — set a user's manager from the Add/Edit User
  form. Drives who can see whose leads, applicants' inquiries, and
  reports: a manager sees their own work plus their FULL reporting
  subtree (not just direct reports), computed live on every request — no
  caching, so a manager change takes effect immediately for whoever it
  affects, no re-login needed. Cycle-safe: the form (and the API) reject
  a manager assignment that would create a loop.
- **Every inquiry list/detail/update/assign endpoint, and both the
  pre-sales and post-sales report modules, are now scoped by this
  hierarchy** via a new `TeamScopeService`, replacing three separate
  hand-rolled scoping checks with one.
- **Manager-level users with zero reports configured now see an inline
  hint on the Inquiries list** ("Your team has no reports configured
  yet...") pointing at Admin → Users, instead of a silent "No data
  found" that's indistinguishable from actually having no leads. Closes
  the exact confusion the behavioral change above would otherwise cause.

## [0.3.1]

First real pilot-user feedback, triaged and fixed. Three critical bugs
(hit hourly by a working sales team), two "check before building" items
that turned out to be backend-complete, and a security leak found along
the way.

### Security

- **Credential leak, fixed: staff-facing inquiry and follow-up
  endpoints returned password hashes, TOTP secrets, and recovery codes
  to any authenticated staff user.** `GET /inquiries`, `GET
  /inquiries/:id`, and `GET /inquiries/:id/follow-ups` embedded the
  full `User` row for `assignedTo`/`createdBy` — including
  `passwordHash`, `totpSecret`, and `recoveryCodes` — because a bare
  Prisma `include: { relation: true }` returns every scalar column on
  the related model, not just the ones the UI displays. Any staff user
  with read access to inquiries (not just admins) could see this data
  in their browser's network tab on every list/detail/follow-up load.
  Fixed by scoping both call sites (`InquiryService.findAll`/
  `findOne`, `FollowUpService.findAllForInquiry`) to explicit `select`s
  (`{id, name, email}` / `{id, name}`), verified absent both in a
  through-the-wire regression test and by inspecting raw response JSON
  on a live deployed instance. **If you are running v0.3.0 or earlier,
  upgrade to v0.3.1 and rotate any staff password or TOTP secret you
  consider exposed** — anyone who had inquiry-read access and inspected
  network traffic (or logs, if any client/proxy captured response
  bodies) during that window could have captured these values.

### Fixed

- **A rep's own inquiry could silently reassign to admin.** `InquiryService.create()`
  ran round-robin unconditionally whenever a project was set, with no
  notion of who created the inquiry — `Inquiry` had no `createdById`
  column at all. New default policy: an interactively-created inquiry is
  assigned straight to its creator; round-robin only runs for
  machine-driven intake (inbound lead API, bulk import), which has no
  human creator to retain ownership for. Configurable via
  `CompanyConfig.presalesCreatorRetainsLead` (default on).
- **Editing a user, for any field, always failed.** `UserForm.tsx`'s
  edit-mode submit sent a create-shaped payload (including `email`) to a
  `.strict()` update endpoint that never declared it — every save 400'd.
  A deeper client-side bug sat in front of it: the form's validation
  resolver was always `createUserSchema`, which requires `password` —
  edit mode never renders that field, so submission failed silently at
  the validation layer before a request was ever sent. Both fixed; a new
  shared `pickForSchema()` helper (projects onto an update schema's own
  declared keys, rather than subtracting fields off a create-shaped
  object) closes the class of bug, applied at all three known sites
  (this one, Masters, Broker commission payment) plus a regression test
  covering every create/update schema pair this package exports.
- **Direct URL access to an admin page rendered the full page shell for
  any authenticated user**, regardless of permission — the backend
  correctly 403'd the underlying data fetch, but nothing distinguished
  "no data yet" from "not allowed here." Every protected route now
  renders an access-denied screen instead when the user lacks the
  permission that gates it.

### Added

- **Bulk Excel inquiry import now has a staff UI.** The backend
  (row-level validation, applicant dedup, `ExcelJS`-based parsing) has
  existed since Phase 3 with no caller in `apps/web` — upload UI, a
  downloadable XLSX template (`GET /inquiries/import-template`, single
  source of truth shared with the parser's own header map), and
  per-row error reporting added to the Inquiries page.
- **Follow-up log now shows who logged it.** `FollowUp.createdById` has
  been captured since Phase 3 and was already being fetched — just never
  rendered.

## [0.3.0]

### Added

- **Staff can now publish construction updates and photos to the customer
  portal.** Backend and portal rendering have been complete since v0.2.2
  — nothing in the staff app ever called the endpoint, so a builder
  could never post an update through the product and the portal's
  "Construction progress" section only ever showed something if a
  developer hand-crafted one via the raw API. `ProjectDetail.tsx` gained
  a Construction Updates panel (mirrors the existing Media panel):
  create an update (title, description, date), attach photos (reusing
  the existing upload module and per-project storage cap), list
  existing updates, delete one. Publishing already fires the existing
  portal-notification trigger — no wiring needed there.

- **You can now edit a project after creation.** There was previously no
  edit screen at all — a typo'd RERA number or address meant rebuilding
  the project and its entire inventory. `ProjectDetail.tsx` now has an
  Edit Project form for name, RERA number, project type, area/location,
  address, description, and start/expected-end dates, reusing the same
  custom-field inputs as project creation. `PATCH /projects/:id` already
  existed and was already permission-gated (`INVENTORY_PROJECT_UPDATE`)
  — this release only adds the missing UI, plus one backend change:
  `code` is now immutable (dropped from the update schema, shown
  read-only) since it's used to match projects during bulk inquiry CSV
  import — changing it would silently break existing CSV mappings.

  Editing a project's area/location changes GST place-of-supply for
  **new** bookings only — every existing booking's GST is a one-time
  snapshot taken at booking creation and is never retroactively altered
  (same immutable-snapshot design as rate-master edits). When the
  project already has bookings, changing the area/location now shows a
  confirmation naming the booking count before saving, so the
  consequence is visible rather than silent; projects with zero bookings
  save immediately with no extra step.

### Fixed

- **Upgrading an existing install left the Super Admin role unable to use
  newly-shipped features.** Since v0.2.0, upgrades correctly added new
  permission *rows* to the database, but never granted them to anyone —
  so on any install created before a given release, the `super_admin`
  role kept exactly the permissions it was first seeded with. In
  practice this meant **PLC and unit-charge pricing (shipped in v0.2.0)
  was unreachable on every upgraded install**, for the most privileged
  role in the product, with no error message explaining why. Found on a
  real v0.1.2 → v0.2.3 upgrade: the `permissions` table held all 142
  rows while `super_admin` held only 140.

  Upgrades now re-grant `super_admin` any permission it is missing.
  This runs automatically as part of `upgrade-native.sh` — no manual
  step. **If you have upgraded before and found a feature missing from
  the UI, this is very likely why**; re-running the upgrade repairs it.

  Only `super_admin` is repaired, deliberately. Its definition *is*
  "every permission that exists", so a missing one is drift rather than
  a choice. `company_admin`, `sales_manager` and any custom role are
  left exactly as configured — an upgrade must never silently widen a
  permission set an admin deliberately narrowed. Grant new permissions
  to those roles through Admin → Roles.

- `packages/db` imported `@openestate/shared` in two shipped scripts
  (`seed.ts`, `sync-permissions.ts`) without declaring it as a
  dependency; it resolved only by package-manager hoisting. Now
  declared explicitly.

- **Correctness fix: a booking's cost lines could silently price at 0%
  GST.** A booking's `BASE` cost line had no GST rate picker anywhere in
  the wizard, and every PLC/charge line without its own rate falls back
  to the base line's — so with no rate ever set on the base line, an
  entire booking (base price, PLC, and any charge type without its own
  configured GST rate) taxed at 0%, with no error and no on-screen
  signal. Unlike the other gaps found on the same pre-pilot walkthrough,
  this one produces a printed document — a demand letter, a statement —
  with the wrong tax amount and nothing to flag it, the same failure
  shape as the bounced-cheque-still-counted-as-collected bug fixed
  earlier this project's history. Fixed at the point of resolution, not
  just in the UI: `BookingService.createBooking` now rejects the whole
  booking (full rollback, no partial row written) if any cost line's GST
  rate can't be resolved through the existing own → charge-type →
  base-line chain, naming the specific line and pointing at the base
  line first since setting it fixes every line that falls back to it.
  `BookingWizard.tsx` gained a GST-rate picker on the base line
  (auto-selected only when exactly one active rate exists — never
  guessed otherwise) so a real admin hits this before submitting, not
  after.

  **Bookings created before this fix are not retroactively corrected.**
  `BookingCostLine` is an immutable snapshot by design (the same
  invariant behind rate-master edits never touching an existing
  booking), and there is no way to know after the fact what the correct
  historical GST rate should have been without a human reviewing each
  affected booking — the same reasoning already applied to the
  `CompanyConfig.gstStateCode` correctness fix. A boot-time log
  (non-fatal, mirrors the existing GST-config-completeness check) and a
  persistent admin banner now surface a count of affected bookings
  instead, linking to a new "Zero-GST bookings" report
  (`Post-sales → Reports`, CSV export included) listing the exact
  booking numbers — **check any already-issued document for these
  bookings before relying on it.**

- **A company's first-ever, open-ended GST rate blocked creating a
  second one.** The overlap check correctly refused two ambiguous,
  simultaneously-active date ranges — but the only way out was for the
  admin to notice the confusing error and manually set an end date on
  the first rate before trying again. Creating a rate that would
  overlap an existing open-ended range now auto-closes the prior range
  the day before the new one starts, instead of rejecting — safe
  because GST is snapshotted per cost line at booking time, never
  looked up by date range at runtime. A genuinely ambiguous overlap (a
  fixed-range rate, or a new range starting on/before an existing one)
  is still rejected, now naming the conflicting rate.

  **The seed itself shipped exactly this invalid state** — GST 5% and
  GST 12% both open-ended from the same date — so every fresh install
  started with master data the product's own validation would reject
  if resubmitted. Fixed with real, verifiable dates: GST 12% now models
  the pre-April-2019 scheme (closed), GST 5% the current one
  (open-ended).

- **A GST/TDS rate's end date could be set once and never cleared
  again.** `PATCH` with an explicit `effectiveTo: null` silently
  coerced to `1970-01-01` instead of clearing the column (the
  underlying date-coercion library treats `null` as a valid date, epoch,
  not as "no value" — an easy trap without an explicit guard).
  `Masters.tsx` also never sent `null` for an emptied date field, so
  even the fixed backend was unreachable from the UI. Both fixed; same
  class of bug audited across every other optional date field in the
  schema (Project's start/expected-end dates included).

- Native installs: a fresh `sudo git clone` (as documented) leaves the
  checkout root-owned, and Git's dubious-ownership protection then
  refused every `git` command a non-root admin ran against it
  afterward — including the routine `git pull` before every upgrade.
  `install-native.sh`/`upgrade-native.sh` now add the necessary
  exception automatically.

## [0.2.3]

### Security

- **Custom field values are no longer sent to portal users.** Until this
  release, `GET /portal/profile` returned the customer's whole applicant
  record — including any admin-defined custom field values — to the
  customer themselves **and to their co-applicants**. Custom fields are
  routinely used by staff for internal notes ("negotiation margin",
  "credit risk", "do not call before 11am"), and nothing in the field
  definition marks a field as safe to show a customer, so all of them
  are now withheld from every portal response. Per-field opt-in
  visibility is a deliberate future feature; withholding is the only
  defensible default in the meantime.

  **If your staff have written anything sensitive into a custom field on
  an Applicant, assume portal users could have seen it before
  upgrading.** Values themselves are untouched — only what the portal
  returns has changed.

### Fixed

- **Integrity fix: custom field values have accepted arbitrary,
  unvalidated data since Phase 3 — your database may already contain
  junk.** `customFields` on Applicant and Inquiry was declared as
  "any object" at the API boundary (`z.record(z.unknown())`), so any
  caller could write any key with any value straight into storage: no
  type checking, no required-field checking, no check that a SELECT
  value was one of its options, and no rejection of keys that were never
  defined as custom fields at all. The validation code to prevent this
  had been written but was never called by anything.

  Validation is now enforced server-side against your active field
  definitions on every write, for Applicant, Inquiry, Unit and Project.
  Unknown keys are **rejected** rather than silently discarded.

  To see whether an existing install has junk values, run this against
  your database — it lists every stored key that has no matching custom
  field definition:

  ```sql
  SELECT 'applicant' AS entity, a.id, k AS unknown_key, a.custom_fields -> k AS value
    FROM applicants a, jsonb_object_keys(a.custom_fields) k
   WHERE a.custom_fields IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM custom_field_definitions d
                      WHERE d.company_id = a.company_id
                        AND d.entity_type = 'APPLICANT' AND d.key = k)
  UNION ALL
  SELECT 'inquiry', i.id, k, i.custom_fields -> k
    FROM inquiries i, jsonb_object_keys(i.custom_fields) k
   WHERE i.custom_fields IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM custom_field_definitions d
                      WHERE d.company_id = i.company_id
                        AND d.entity_type = 'INQUIRY' AND d.key = k);
  ```

  Anything it returns is either junk written before the fix, or one of
  two expected system-written keys (`leadNote` from inbound leads,
  `importNotes` from CSV import). Values belonging to a field you merely
  *deactivated* will **not** appear — that definition still exists, so
  those values are accounted for.

  **Nothing is deleted by upgrading.** Existing values are preserved and
  still shown on detail screens, marked "(inactive)" where no active
  definition covers them, and records carrying such keys stay editable —
  validation rejects unknown keys arriving from a client, but never
  retroactively invalidates what is already stored.

- Deleting a custom field used to be a hard delete, which left its
  values orphaned in the database with nothing left to explain what they
  meant. Delete is now a **deactivate** (values preserved, field stops
  appearing on forms). Permanently destroying values is a separate
  action that requires typing the field's key to confirm, and records
  the affected row count to the audit log.

### Added

- **Custom field values now actually work.** Admins could define custom
  fields since Phase 1, but nothing anywhere captured or displayed a
  *value* — defining a field had no effect elsewhere in the product.
  Values are now captured on real forms, validated, displayed on detail
  screens, and exported. Supported on **Applicant, Inquiry, Unit and
  Project**; a field's definition drives the form with no code change.
- New per-inquiry CSV export (`/reports/presales/inquiries-export`) with
  one column per active custom field.
- `BOOKING` is explicitly marked unsupported in the admin UI (with an
  explanation) and rejected by the API, rather than letting an admin
  define a field there that would silently do nothing. See
  `docs/todo.md`.

## [0.2.2]

### Added

- **Layout plan / brochure / photo uploads.** `UploadService` has
  supported these categories since Phase 2 but no route ever called it
  — this release wires it up. Staff get a **Media** panel on a
  project's detail page (upload, list, download, delete); customers
  see the same files under a new "Layout plans & brochures" section on
  the portal Property page, with real download links.
- **Construction-progress photos actually render now.** The upload
  path for `ConstructionUpdateMedia` has existed since v0.2.1's own
  predecessor, but there was never a serving route on either side —
  the portal only ever showed a photo *count*. Staff and portal both
  gained a download route, and the portal Property page now renders
  the real images inline instead of a bare "N photo(s)" line.
- **Per-project storage cap.** Layout plans, brochures, photos, and
  construction-progress photos all roll up disk usage under one
  project — unbounded uploads on a self-hosted box eventually fill the
  disk, which surfaces as Postgres refusing writes and looks like
  total system failure rather than a storage problem. A configurable
  file-count cap (default 50) and total-size cap (default 500MB) per
  project are enforced before any file touches disk, with a clear
  error naming the limit. Configurable via Company Config
  (`projectMediaMaxFiles`/`projectMediaMaxBytes`).
- IDOR coverage for both new download routes: a customer with a
  booking in one project cannot fetch another project's media by
  guessing an id — proven via the same raw-connection RLS discipline
  as every other portal IDOR test in this codebase, since both
  `project_media`/`construction_update_media`'s portal RLS predicates
  are multi-hop and therefore not mirrored at the JS layer.
- Two new e2e Playwright scenarios: staff uploads a layout plan
  through the real UI and the customer downloads it in the portal;
  and a staff-published construction-progress photo renders as a real
  decoded image in the portal (not just a 200 response).

### Still missing

- **Custom field values.** Admins can define custom fields (Applicant,
  Unit, etc.) via Admin → Custom Fields, but no form anywhere in either
  app captures or displays a *value* for one — defining a field has no
  effect elsewhere in the product yet.

## [0.2.1]

### Added

- **Staff can now reply to and resolve customer support tickets.**
  Closes the loop that's been open since the portal shipped: customers
  could raise a ticket and read replies, but no staff screen existed to
  see or answer one — the backend (`AdminTicketController`) had been
  fully built and idle the whole time. New **Support** section
  (top-level nav, not nested under Post-sales — inquiries and brokers
  raise tickets too, not just post-sales) with a queue and a thread
  view: reply, change status, filter by status.
- **Ticket queue enrichment.** The queue now shows who raised each
  ticket (resolved from the linked Applicant/Broker, not a bare ID),
  its category, how many messages it has, and when it was last active
  — the minimum a triaging staff member needs to work a queue, none of
  which the API returned before.
- **Overdue flagging from the existing `slaByAt` field.** The column
  has existed in the schema since Phase 6 with nothing reading it; the
  queue now shows an "Overdue" flag when a ticket's `slaByAt` has
  passed and it isn't resolved/closed. No SLA policy or configuration
  was added — this only renders a field that was already there.
- The e2e harness gained its first scenario that drives **both**
  `apps/web` and `apps/portal` against the same API in one test:
  customer raises a ticket → staff sees it, replies, resolves it →
  customer sees the reply. Every prior scenario exercised one app at a
  time.

### Still missing

Two gaps remain, tracked for future releases, not fixed here:

- **Layout plan / brochure / photo uploads.** The validation and
  storage service (`UploadService`) has existed since Phase 2 and
  already supports these categories, but no route in the Inventory
  module has ever called it — there is no way, staff or customer
  portal, to attach or view a project's layout plan today.
- **Custom field values.** Admins can define custom fields (Applicant,
  Unit, etc.) via Admin → Custom Fields, but no form anywhere in either
  app captures or displays a *value* for one — defining a field has no
  effect elsewhere in the product yet.

## [0.2.0]

**Upgrade note:** `upgrade-native.sh` now syncs new `PERMISSIONS` rows to
existing installs automatically (see the permission-delivery fix below),
but it does not — and should not — grant them to any role for you. After
upgrading, an admin must open **Admin → Roles**, edit each role that
should get the new PLC/charge-management capability, check
`inventory.unit.plc-manage` / `inventory.unit.charge-manage`, and save.
This is a deliberate, permissions-only sync — see the entry below for why
auto-granting them would be its own bug, not a fix.

### Fixed

- **Correctness fix affecting GST charged on bookings and extra charges —
  check your invoices if your company's GST State Code was ever unset.**
  `isIntraStateSupply()` used to silently default to intra-state
  (CGST+SGST) whenever the company's GST state code or a booking's
  place-of-supply state code was missing, instead of raising an error.
  Any company whose Company Config GST fields were never filled in —
  every install created before those columns existed, or any install
  where nobody had visited Company Config yet — has been charging
  CGST+SGST on every booking and extra charge regardless of where the
  property actually is, which is the WRONG tax treatment (IGST) whenever
  the real place of supply is in a different state from the company's
  own. This produced no error and no warning; the only way to notice was
  to already know the correct treatment and check by hand. **If this
  applies to you, review bookings/extra charges made while your GST
  config was incomplete and correct any wrongly-taxed invoices — this
  release does not retroactively fix already-issued invoices.** Going
  forward, `isIntraStateSupply()` now throws instead of guessing — a
  booking or extra charge with incomplete GST config is rejected with a
  clear error naming what to set in Company Config, rather than silently
  taxed wrong. The app also now logs a warning at boot listing any
  company with incomplete GST config, and the staff admin UI shows a
  persistent banner linking to Company Config until it's completed.

- **Correctness fix affecting reported collection figures — upgrade and
  let the migration run before trusting any collection report.** A prior
  bug (see the REPORTS-phase entry in `CLAUDE.md`) left bounced-cheque
  receipts still marked as collected (`is_reversed = false`) in every
  collection report, rollup, and the customer portal's own payment
  history — the code fix stops this going forward, but does nothing for
  receipts that already bounced before you upgrade. Migration
  `20260804120000_backfill_bounced_receipt_is_reversed` corrects those
  existing rows on your next `prisma migrate deploy` (part of the normal
  upgrade path — no manual step needed). It only touches the
  `is_reversed`/`reversal_reason` flag on affected receipts; it does not
  alter any ledger entry, allocation, or installment. If your reported
  collection totals looked too high before upgrading, they'll drop by
  the sum of any previously-bounced cheques once this runs.

- **A release that adds a `PERMISSIONS` constant never reached an
  existing install — only a fresh one.** `seed.ts`'s permission-upsert
  loop ran unconditionally, but the early-return gate right after it
  (`if (existingCompany) return`) meant no other seeded content, and
  critically no *later* permission addition, was ever re-applied to a
  company created in an earlier release. `upgrade-native.sh` now runs a
  dedicated `sync-permissions.ts` step (idempotent, permissions-table
  only) on every upgrade, so new permission rows reach existing installs
  the same way they reach fresh ones. Deliberately does NOT extend to
  masters or roles — see the upgrade note above and `CLAUDE.md` for why
  that's a different (and mostly correct-as-is) problem.
- **A system role (`super_admin`, `company_admin`, etc.) could never be
  granted a newly-added permission through the UI, at all.**
  `RolesService.update()` rejected any change to a system role, not just
  a rename — so even with the fix above delivering the permission *row*,
  there was no way to actually grant it to a role. Scoped the guard to
  an actual name change only; a system role's permission set is now
  freely editable (its name and existence stay protected, as before).

### Added

- **PLC and unit-charge management.** Unit-level PLCs (park-facing,
  corner, etc.) and extra charges (IFMS, legal, etc.) can now be
  assigned per unit from the Inventory → Project → Pricing panel, and
  flow into a booking's cost breakup and the confirm step's total
  automatically. PLC amounts are snapshotted in paise at assignment time
  (from a percentage of the unit's rate, or a flat amount) and never
  retroactively change if the base rate is revised later.
- **Per-charge-type GST rates.** Charge Types now carry their own
  optional GST rate and HSN/SAC code (Masters → Charge Types). A cost
  line's GST resolves in order: its own rate, then its charge type's
  rate, then the booking's base-line rate — never silently zero-rated.
  A PLC line has no charge type, so it always inherits the base line's
  rate; this is stated explicitly rather than left implicit.

### Changed

- Replaced the `argon2` password-hashing dependency with
  `@node-rs/argon2` (pure Rust via napi-rs). `argon2` had caused two
  separate deployment failures on two different platforms (an
  Alpine/musl prebuild issue, and a still-unexplained SIGSEGV
  crash-loop on GitHub's `ubuntu-latest` CI runners — see `CLAUDE.md`
  for the full, ultimately-inconclusive investigation); the replacement
  ships prebuilt binaries for every platform this project targets and
  never falls back to compiling from source. Existing stored password
  hashes remain verifiable — both libraries use the same standard PHC
  string format, confirmed by directly cross-verifying a real hash
  between the two before switching. No action needed on upgrade, no
  password resets.

## [0.1.2]

**Upgrade from v0.1.1 as soon as practical.** Two bugs in that release
are severe enough on their own to justify this one:

- **Any account with 2FA enabled was permanently locked out of login**,
  with no way back in — not even via a recovery code. The login
  response's 2FA-pending branch never set the CSRF cookie `totp/verify`
  requires, so every `totp/verify` call (including recovery-code
  attempts) 403'd with "CSRF token mismatch," unconditionally, for
  every account. **If you're running v0.1.1 and have 2FA enabled on
  any staff account, upgrade before enrolling further users** — those
  accounts have been unable to log in since enabling it, and existing
  locked-out accounts will need a staff admin to disable 2FA for them
  (`POST /auth/totp/disable`, or directly via the database) after
  upgrading, since the fix doesn't retroactively unlock an in-progress
  login attempt.
- **A genuinely fresh install failed immediately** on the exact command
  the docs tell you to run. Every `deploy/native/*.sh` script an admin
  runs directly was git-tracked without the executable bit; `sudo
  ./install-native.sh` right after `git clone` died at "Permission
  denied" trying to exec `setup-database.sh`. Anyone who successfully
  installed v0.1.1 did so from a checkout that had picked up a local,
  uncommitted `chmod +x` somewhere along the way (e.g. copying files
  instead of cloning) — a literal fresh clone was never viable.

### Fixed

- The 2FA lockout above also had a second, independent bug: the
  code-verification schema only accepted 6 digits, rejecting every
  recovery code's `XXXXX-XXXXX` format before it reached the
  already-correct recovery-code check. Both fixed together; verified
  live end-to-end (enroll, login-requires-code, wrong code rejected,
  recovery code works once and is rejected on reuse).
- Company config had no way to set `companyGstin`/`gstStateCode` after
  the initial seed, despite the frozen booking service already reading
  `gstStateCode` to decide CGST+SGST vs IGST. Added, with GSTIN format
  validation (checksum digit deferred — see `docs/todo.md`) and a
  Company Config UI section.
- Health endpoint's `version` field was hardcoded `0.1.0` in every real
  deployment (`npm_package_version` is only set by `pnpm run`, never by
  systemd's/Docker's direct `node dist/main.js`). Now reads
  `package.json` directly.
- 18 of 19 generic master types (unit types, inquiry sources, charge
  types, etc.) 500'd on any create/update call that included a
  description — `createMasterSchema`'s optional `description` field is
  only backed by a real column on `PaymentPlanTemplate`; the shared
  factory blindly spread the whole dto into Prisma's `data`. Fixed once,
  at the root, in the factory.
- `DocumentType`, `InterestRule`, and `TransferFeeRule` couldn't be
  created via the API at all — each has its own required, non-nullable
  columns (`entityType`; `rateType`/`ratePercent`/`frequency`;
  `feeType`) that the generic master schema never had, so every attempt
  500'd on a Prisma "Argument missing" error instead of failing
  validation cleanly. The shared factory now supports a per-model
  `extraFields` schema extension.
- `LetterTemplate` had no working create path at all — zero templates
  could ever exist, blocking demand/allotment/reminder letter generation
  entirely. It was routed through the generic master factory (whose
  schema has no `subject`/`entityType`/`body`) instead of a dedicated
  module; given one, mirroring the existing `SmsTemplateModule`
  precedent, with merge-field validation at save time.
- Duplicate master names (any of the 18+ shared-factory types) returned
  a raw 500 instead of a clean "already exists" 400 — nothing in this
  codebase had ever caught Prisma's P2002 unique-constraint error for
  these dynamically-keyed services (unlike `RolesService`/`UsersService`,
  which pre-check via `findFirst`). Mapped once, in the factory.
- `install-native.sh`/`upgrade-native.sh`'s database migration step
  failed on any host where the git checkout lives under a directory
  tree the `postgres` OS user can't traverse (e.g. GitHub Actions
  runners: `/home/runner` is mode `0750`) — Prisma 6.19+ auto-discovers
  a `prisma.config.*` file in the current working directory before
  running any command, and that lookup's `lstat()` fails `EACCES` (not
  `ENOENT`) in that case, which Prisma treats as a hard failure rather
  than "no config file, proceed." `run_as_superuser()` now runs from
  the already-world-traversable release directory instead of the
  checkout.
- `install-native.sh`'s final `systemctl reload nginx` failed outright
  ("nginx.service is not active, cannot reload") on any host where apt
  installed nginx without starting it — the script only ever checked
  that the `nginx` binary was present, never that the service was
  running. Now `enable`s and `reload-or-restart`s it, correct whether
  nginx was already running or not.
- `CustomFieldDefinition.defaultValue` — accepted by the create/update
  schema since it was written, but no backing column ever existed, so
  any real caller sending it 500'd. Added the missing column.
- `POST /users` never returned the `phone` it had just saved — a
  `select` allowlist copy/paste gap (present in `update()`, missing
  from `create()`) left an admin with no way to confirm the phone
  number was stored.

Everything above except the two headline bugs was found by a full
production-readiness pass and a new through-the-wire creation test for
every master type and admin-creatable entity (users, roles, custom
fields) — the existing suite seeded rows directly, which is exactly why
these bugs survived to a tagged release. Also added: real-HTTP creation
coverage for all 22 master types plus users/roles/custom fields, and a
`native-install` CI job that runs the full native install on a real
`ubuntu-latest` runner on every push. That CI job is not yet green — a
separate, CI-runner-specific issue (the deployed app crash-looping with
SIGSEGV, isolated to argon2's native module, confirmed not to reproduce
on a real server) is still open and tracked in `CLAUDE.md`; it does not
affect real installs, only that one job's own coverage.

## [0.1.1]

### Added

- **Native install path** (`deploy/native/`): `install-native.sh` sets up
  OpenEstate as a systemd service behind nginx, talking to a PostgreSQL
  and Redis you already run — no Docker involved in production. Also
  ships `setup-database.sh` (standalone DB/role setup for a DBA-managed
  Postgres), `upgrade-native.sh` (backup → build → migrate → cutover,
  with automatic rollback on a failed healthcheck), `backup-native.sh` /
  `restore-native.sh`, and `uninstall.sh`. Docker Compose is unaffected
  and still fully supported — it's now positioned as a contributor tool
  for the test suite rather than the primary production path; see
  `docs/docs/installation.md` and `CONTRIBUTING.md`.
- A CI job (`native-install` in `.github/workflows/ci.yml`) runs the full
  native install on a real `ubuntu-latest` runner — installs PostgreSQL,
  Redis, Node 20, nginx, and a build toolchain, runs `install-native.sh`,
  and asserts the health endpoint responds and a login succeeds over real
  HTTP — so the native path is verified on every push, not just once by
  hand.
- Consistent, user-visible toasts on failed mutations across both
  `apps/web` and `apps/portal` (`lib/toast.tsx` + a `MutationCache`-based
  global handler in each app's `main.tsx`), replacing a mix of silent
  failures, inline-only banners, and unhandled promise rejections found
  during an audit of ~15+ call sites.

### Fixed

- **Login failed on every fresh Docker Compose install with "Cannot POST
  /api/api/v1/auth/login".** `VITE_API_URL` defaulted to `/api`
  (`deploy/.env.example`, `deploy/docker-compose.yml`,
  `deploy/docker/{web,portal}.Dockerfile`), but `apps/web`/`apps/portal`'s
  own API client already hardcodes `/api/v1/...` on top of it, and
  nginx's `/api/` location already forwards that prefix through unchanged
  — doubling it. Since Vite bakes this value into the built JS bundle at
  image-build time, existing installs need `git pull` +
  `docker compose up -d --build` (not just a restart) to pick up the fix.
- **Every validation error (400) showed the generic toast "Validation
  failed" instead of saying what was actually wrong**, across both apps
  — nestjs-zod's default exception hardcodes that message regardless of
  which field failed. The API now returns the real per-field reason
  (e.g. `"url: Invalid url; secret: String must contain at least 16
  character(s)"`).
- A handful of mutations (webhook endpoint creation in `apps/web`, three
  non-mutation-hook webhook actions, PDF downloads in both apps) failed
  silently or inline-only, with no toast — fixed as part of the same
  audit.
- Eight real bugs in the native-install scripts, found only by running
  `install-native.sh` end-to-end on a genuinely clean VM — none caught by
  shellcheck, `nginx -t`, or a careful read of the scripts: a missing
  build-toolchain prerequisite check (`argon2` needs `make`/`g++`/
  `python3`); a build failure silently swallowed by a `set -e`
  propagation gap; `NODE_ENV=production` leaking into the build and
  dropping devDependencies; the build's own stdout corrupting a command
  substitution; `node <script>` failing on pnpm's shell-script `.bin`
  shims; a fragile cross-store Prisma client copy replaced with
  regenerating the client in place; `backup-native.sh` failing under RLS
  by dumping via the wrong role; and `restore-native.sh` failing to drop
  a database still held open by the running service. Full detail in
  `CLAUDE.md`'s decisions log.

### Verified

- Ubuntu 24.04 LTS with PostgreSQL 16, and Ubuntu 25.10 with PostgreSQL
  17 — both confirmed end-to-end: fresh install, safe re-install, real
  HTTP login and role creation, upgrade with rollback, backup/restore,
  and both uninstall modes. The scripts check for `psql` presence, not
  an exact major version, so this isn't expected to be an exhaustive
  platform list — just what's actually been run.

## [0.1.0] — first tagged release

The first tagged release of OpenEstate: a self-hostable, open-source
(AGPL-3.0) CRM for real estate, built for the Indian market first with a
plugin system designed for other verticals to adapt it without forking
core code.

### Core domain

- **Pre-sales**: inquiry capture and dedup, round-robin/manual lead
  assignment (fair under concurrency, advisory-lock serialized), follow-up
  and site-visit tracking, escalation on overdue follow-ups, applicant
  merge with a consent audit ledger, funnel/ageing/source reports.
- **Post-sales / financial core**: append-only ledger (balances are always
  computed, never stored), booking → payment plan → receipt → cheque
  lifecycle, GST (CGST/SGST/IGST) and TDS (194-IA) handling, interest
  accrual, unit transfer, cancellation with configurable deduction rules,
  two-phase refunds, gap-free receipt/booking numbering, PDF generation
  (receipts, statements, demand/allotment/reminder letters) with dispatch
  and delivery tracking. Correctness proven by a property-based test suite
  (fast-check) run against every CI build.
- **Brokers and commissions**: slab-based commission rules, accrual with
  point-in-time snapshotting, a request → approve → pay → reject payment
  workflow, TDS (194-H) withholding, and clawback on booking cancellation.
- **Customer and broker portals**: separate, minimal-scope authentication
  and rate-limit buckets from staff; row-level security is the primary
  isolation mechanism for these untrusted clients, not just a
  defense-in-depth backstop.
- **Custom fields, terminology, and module flags**: every entity supports
  admin-defined custom fields; labels ("Unit" → "Product", etc.) and
  enabled modules are configurable per company, not hard-coded — the
  mechanism the `generic-sales` plugin (below) proves out for a
  non-real-estate vertical.

### Plugins, webhooks, and integrations

- A plugin SDK (`@openestate/plugin-sdk`) with capability-gated context
  access, package-boundary isolation (no database access path from
  plugin code at all), SSRF-hardened outbound HTTP, and a first-party
  `generic-sales` reference plugin.
- Outbound webhooks: HMAC-signed, replay-protected, retried with
  exponential backoff, auto-disabled after sustained failure.
- Inbound lead API: per-key authentication and rate limits, a
  generic field-mapping config so common vendor integrations (99acres,
  MagicBricks, a generic webhook) need zero plugin code.

### Security

- RBAC permission guards **and** independent Postgres row-level security
  on every tenant-scoped table — not RLS as an afterthought.
- Argon2id password hashing, TOTP 2FA, rotating refresh tokens with
  reuse-family revocation, account lockout with exponential backoff.
- PAN encryption at rest (AES-256-GCM, per-domain keys, never reused
  across PAN/TOTP/plugin-secret rotation domains) for both brokers and
  applicants; phone/PAN masking in list views and logs.
- Immutable financial ledger enforced at the database level (a trigger
  blocks UPDATE/DELETE, not just application discipline).
- Redis-backed rate limiting shared across replicas and surviving
  restarts.
- Docker images pinned to verified sha256 digests; a randomly generated,
  single-use initial admin credential (never a shared default).
- A formal [OWASP ASVS L2 self-assessment](docs/docs/security/asvs-checklist.md)
  and [STRIDE threat model](docs/docs/security/threat-model.md) per
  module, stating accepted residual risk plainly rather than implying
  guarantees the architecture doesn't make.

### Known limitations (see `docs/todo.md` for the full list)

- Rate-limit storage is now Redis-backed, but no other component of the
  first-party plugin trust model provides worker-thread/process
  isolation against a deliberately malicious plugin — first-party
  plugins ship as reviewed npm workspace packages in this repository,
  the same review bar as any other module, not as untrusted third-party
  code.
- No automated TLS/certificate setup in `install.sh` — self-hosters
  bring their own reverse-proxy TLS termination.
- Some staff-service call sites still self-wrap tenant context
  redundantly with the ambient interceptor (low-risk cleanup, a runtime
  guardrail already backstops the one bug class this pattern caused
  historically).
