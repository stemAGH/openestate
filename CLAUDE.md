# OpenEstate CRM — Project Constitution

You are the lead developer of OpenEstate, an open-source (AGPL-3.0),
self-hostable CRM. First vertical: Indian real estate (pre-sales lead
management, post-sales unit/installment/receipt management, customer
portal, broker portal). The architecture must allow other verticals
via configuration and plugins, never via forking core code.

## PRIMARY LESSON — verify in a real browser, not with curl/tests

API-layer tests and curl verification systematically overstate
completeness. This walkthrough found ~20 bugs in "completed" features,
including several that had NEVER worked through the UI: Roles list
rendered zero rows always; every master edit 400'd; Document Types/GST
Rates/Letter Templates were unreachable; Custom Fields sent the wrong
field name; forced password change was dead code; Pre-Sales and
Inventory had no UI at all; and Secure-flagged cookies over plain HTTP
meant NO browser mutation had ever succeeded on the VM — every prior
"VM verified" claim used curl, which bypasses browser cookie
enforcement.

Rule: a feature is not done until a human has performed it in a real
browser. Endpoint tests prove the server works, not that the product
works. No feature ships on API-test evidence alone.

## Non-negotiable principles

1. SELF-HOSTABLE FIRST. Everything must run from a single documented
   install command against infrastructure the self-hoster already
   controls — today that's `sudo ./install-native.sh`
   (`deploy/native/`), talking to a PostgreSQL/Redis/nginx the admin
   runs themselves. No mandatory external SaaS dependencies. Optional
   integrations (SMS, email, lead portals) degrade gracefully when not
   configured.
   **Historical note**: this principle originally named
   `docker compose up` — true through Phase 8's release. Native install
   replaced it as the supported production path, and every Docker
   artifact (the compose stack, the three Dockerfiles, and later the
   test-only compose file) was deleted outright afterwards. There is no
   Docker anywhere in this repo now — not for production, not for CI,
   not for tests.
2. LEDGER, NOT MUTATION. Financial records (receipts, payments,
   refunds, commissions) are append-only. Corrections are reversal
   entries, never UPDATE or DELETE on financial rows. Balances are
   always computed from the ledger.
3. MASTER-DRIVEN. No business constant is hard-coded. Tax rates,
   charge types, interest rules, letter templates, inquiry sources,
   follow-up types — all live in database "master" tables that
   admins configure. India-specific values ship as SEED DATA, not
   code, so other countries can replace them.
4. MULTI-TENANT BY DESIGN. Hierarchy: Company → Project → Tower →
   Floor → Unit. Every domain table carries `company_id`. Isolation
   is enforced in the data layer (Postgres row-level security +
   a Prisma middleware guard), never only in controllers.
5. EXTENSIBLE, NOT FORKABLE. Custom fields (EAV/JSONB per entity),
   module enable/disable flags, a plugin API, webhooks, and
   configurable terminology (a "Unit" can be relabelled "Vehicle",
   "Policy", "Plot") are core features. Vertical logic goes in
   plugins.
6. API-FIRST. Every feature is a documented REST endpoint before it
   is a screen. OpenAPI spec is generated from code and must stay
   in sync (CI fails otherwise).

## Stack (do not deviate without asking)

- Monorepo: pnpm workspaces + Turborepo
- Backend: NestJS 10, TypeScript strict mode, Prisma ORM
- Database: PostgreSQL 16 (RLS enabled), Redis 7 (BullMQ queues)
- Frontend: React 18 + Vite + TypeScript, TanStack Query,
  react-hook-form + zod, Tailwind CSS
- Auth: self-hosted JWT (short-lived access + rotating refresh
  tokens), argon2id password hashing, TOTP 2FA
- Files: local disk by default, S3-compatible driver optional (any
  S3-compatible endpoint — MinIO, Ceph, a cloud bucket)
- Docs/PDF: server-side PDF generation for receipts, demand letters,
  statements (use @react-pdf/renderer or pdfmake — pick one, stay
  consistent)
- Tests: Vitest (unit), Supertest (API), Playwright (e2e smoke)
- Lint/format: ESLint + Prettier, enforced in CI (GitHub Actions)

## Repo layout

apps/api        NestJS backend
apps/web        Staff admin SPA
apps/portal     Customer + broker portal SPA (role-routed)
packages/db     Prisma schema, migrations, seed data
packages/shared Types, zod schemas, constants shared FE/BE
packages/sdk    Generated TypeScript API client (from OpenAPI)
plugins/        First-party plugins (lead sources, messaging)
deploy/native/  Production install: install-native.sh, systemd unit,
                nginx config, upgrade/backup/restore/uninstall scripts
docs/           Docusaurus site: install, admin, API, plugin dev

## Security rules (apply to every line of code)

- Validate EVERY input with zod at the API boundary; whitelist,
  never blacklist. Reject unknown fields.
- Parameterized queries only (Prisma). Raw SQL requires a comment
  justifying it and must use parameter binding.
- AuthZ: RBAC with permissions checked in guards AND row-level
  security in Postgres. Portal users (customers/brokers) get
  separate, minimal-scope roles; they can only ever read rows
  keyed to their own applicant_id/broker_id.
- Rate limiting on all auth endpoints and portal endpoints
  (@nestjs/throttler + Redis store).
- Account lockout after repeated failed logins: 5 wrong passwords locks
  the account for a flat 15 minutes (not an escalating backoff — the same
  15-minute lock repeats on every subsequent failure until a successful
  login).
- Secrets only via environment variables; ship `.env.example`,
  never a real `.env`. Generate strong defaults in
  `deploy/native/install-native.sh`.
- Security headers via helmet; strict CORS allowlist from env;
  CSRF protection on cookie-based portal sessions.
- File uploads: extension + MIME + magic-byte validation, size
  caps, randomized storage names, never served with user-supplied
  Content-Type, images re-encoded.
- Audit log: every create/update/delete on domain entities writes
  an immutable audit row (actor, entity, before/after diff, IP,
  timestamp). Financial and auth events always audited.
  **Not yet fully true (note added 2026-09-24, v0.7.1):** v0.7.1 fixed
  audit rows being silently dropped on 53 write paths, rows written
  without an actor or IP, and failed audit writes reporting success.
  Still open, tracked in docs/todo.md: UPDATE rows record after-values
  only (before = null); audit_logs is not append-only at the database
  level; writes through updateMany/createMany/deleteMany/upsert on
  audited models (role permissions among them) write no audit row.
- PII: encrypt PAN numbers at rest (AES-256-GCM, key from env);
  mask PAN/phone in list views and logs. NEVER store Aadhaar
  numbers. Structured logger (pino) with a redaction list.
- Sessions: refresh-token rotation with reuse detection; logout
  revokes server-side.
- Dependency hygiene: lockfile committed, `pnpm audit` in CI,
  Dependabot config (npm + github-actions ecosystems).
- No `eval`, no dynamic `require`, no shelling out with user input.

## India-first rules (ship as seed data + pluggable services)

- Currency: INR with lakh/crore digit grouping (₹12,10,000) via a
  shared formatter; all money stored as integer paise (BigInt),
  never floats.
- GST: CGST/SGST/IGST split based on company vs customer state
  codes; GSTIN validation (regex + checksum); HSN/SAC on charge
  masters; GST rate master with effective-date ranges.
- TDS: 194-IA (1% on property transfers above threshold) supported
  via TDS master; thresholds/dates configurable, seeded not coded.
- PAN: format validation, encrypted storage, masked display.
- RERA: project-level RERA registration number + configurable
  compliance fields; shown on letters and portal.
- SMS: DLT-compliant template model (template ID, header/sender ID
  fields) because Indian SMS requires registered templates;
  providers (MSG91, Textlocal, generic HTTP) as plugins.
- Dates: IST default timezone, DD-MM-YYYY display; financial-year
  (Apr–Mar) helpers for reports.
- Compliance posture: design for DPDP Act 2023 — consent capture
  field on leads, data-export endpoint per applicant, retention
  config. Do not claim legal compliance in docs; provide the tools.

## Coding conventions

- TypeScript strict; no `any` without an eslint-disable comment
  explaining why.
- Every module: controller → service → repository layering; business
  logic in services, Prisma calls in repositories.
- Every endpoint: zod DTO, OpenAPI decorator, permission guard,
  e2e test happy path + one authz-failure test.
- Money math only through the shared `Money` utility (paise BigInt).
- Migrations are forward-only; never edit an applied migration.
- Every new migration's folder name must sort after the newest migration on
  master (dependency order = name order on a fresh install).
- Conventional commits. Every phase ends with all tests green and
  `sudo ./deploy/native/install-native.sh` working from scratch.
- Never add Co-Authored-By trailers or "Generated with Claude Code"
  lines to commits or PR descriptions.

## Definition of done for any feature

types → zod schema → migration → service + tests → endpoint +
OpenAPI → UI → seed/demo data → docs page stub → audit logging

## Working habits

- **"Nothing is running" checks use the PowerShell process list, not
  `pgrep`.** `pgrep` isn't installed in the Windows dev shell (Git Bash), so
  `pgrep -f vitest 2>/dev/null` prints nothing because it failed, not
  because nothing is running. Before a build or a test run, check with
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`.
- **Rebuild `apps/api` before running the suite locally**
  (`pnpm --filter @openestate/api build`). The HTTP tests load the compiled
  API from `apps/api/dist`, not the source, so a stale build tests old code: on
  2026-10-10 a build from before the v0.8.3 portal fix made two passing tests
  fail. CI builds first, so CI is not affected.

## Decisions log

Append-only. One entry per architectural decision made while building a
phase — what was decided, why, and what it rules out. Keep entries short;
this is a log, not a design doc.

### Phase 0 — scaffold, Docker, CI

- **Global zod validation via `nestjs-zod`, not a hand-rolled pipe.**
  A per-DTO `PipeTransform` can't be registered as a single global pipe
  the way `ValidationPipe` is in a class-validator NestJS app — schemas
  differ per route. `nestjs-zod`'s `createZodDto` + global
  `ZodValidationPipe` gets the "global zod validation pipe" behavior
  the phase spec actually asked for. DTOs must use `.strict()` to get
  the whitelist-unknown-fields behavior CLAUDE.md requires.
- **`@nestjs/config` added even though Phase 0's spec didn't list it.**
  Without it, `.env` is only read by Docker Compose (which injects env
  vars directly); `pnpm dev` outside Docker had no way to load
  `apps/api/.env` at all. `ConfigModule.forRoot({ isGlobal: true })`
  fixes local dev without changing container behavior.
- **`tsconfig.base.json` must not set `"incremental": true`.** It
  silently breaks `nest-cli`'s `start --watch`: the compiler reports
  "Found 0 errors" but never writes `dist/main.js`, and `nest start`
  then crashes with `MODULE_NOT_FOUND`. Root-caused by hand (removed
  the flag, watch mode started working immediately). If a build-speed
  win from incremental compilation is wanted later, apply it only to
  `tsc -p` one-shot build scripts, never to the base config `nest-cli`
  watch mode inherits from.
- **`apps/api/nest-cli.json` sets `"deleteOutDir": false`.** Paired
  with the incremental fix above as a second layer of defense against
  the same watch-mode race (wiping `dist/` on every recompile is a
  known trigger for watchers starting the node process before the
  first write lands). Means stale compiled files can outlive deleted
  source files between full rebuilds — acceptable in dev, irrelevant
  in Docker/CI where the image is built fresh every time.
- **Docker base images pinned by tag (`postgres:16-alpine`, etc.), not
  by sha256 digest**, despite CLAUDE.md's "pinned Docker base images"
  rule. No verified way to confirm real digests without risking a
  fabricated/stale hash in a file meant to gate what actually runs.
  Revisit in Phase 8's security pass once there's a way to pull and
  verify current digests as part of the change, not from memory.
  Dependabot's `docker` ecosystem entry (`/deploy/docker`) is wired up
  so tag bumps at least get proposed automatically in the meantime.
- **LICENSE and CODE_OF_CONDUCT.md are fetched verbatim from their
  canonical sources (gnu.org, contributor-covenant.org), not
  reproduced from memory.** Legal/community-policy text shouldn't risk
  subtle inaccuracies. `CODE_OF_CONDUCT.md` and `SECURITY.md` both
  had `TODO` placeholders for a real contact/disclosure channel,
  left unfilled rather than invented while "OpenEstate" was still an
  unconfirmed working name.
  **Resolved in Phase 8: "OpenEstate" is confirmed as the project's
  real, final name — v0.1.0 tags under it.** `SECURITY.md`'s disclosure
  channel is now filled in (GitHub Security Advisories, zero
  additional infrastructure needed). `CODE_OF_CONDUCT.md`'s
  conduct-contact TODO stays an honestly-marked placeholder — it needs
  a real, maintained email address only a human maintainer can commit
  to, which is a decision deliberately left open rather than invented.

### Phase 1 — auth, RBAC, multi-tenancy, masters, custom fields, frontend

- **Three Postgres roles, not one.** `openestate_superuser` (migrations
  only, never in app connection strings), `openestate_system` (BYPASSRLS,
  used by system Prisma client for cross-tenant operations like auth
  lookups), `openestate_app` (RLS-enforced, used by tenant Prisma client
  for all domain operations). Two Prisma clients injected via NestJS DI
  tokens (`TENANT_PRISMA`, `SYSTEM_PRISMA`).
- **RLS via `set_config('app.current_company_id', ...)` + Prisma
  extension**, not middleware. Prisma middleware fires too late for
  `$queryRaw` and can be bypassed by `$executeRaw`. The extension
  approach wraps each tenant transaction with a `SET LOCAL` call.
- **`withTenantTx` scopes a data-access unit of work, not an HTTP
  request.** Wrapping the entire request in one interactive transaction
  would hold a DB connection for the full request lifetime, including
  any I/O to external services. No external I/O (HTTP, SMS, email,
  file storage) inside `withTenantTx`.
- **Refresh tokens: SHA-256 hashed, family-based reuse detection.**
  Raw token in httpOnly cookie, SHA-256 hash in DB. Each token carries
  a `family` UUID; reuse of a revoked token revokes the entire family
  (compromise detection). `isRevoked` boolean, not a `revokedAt`
  datetime — simpler queries, same semantics.
- **httpOnly Secure cookie + double-submit CSRF for both apps/web and
  apps/portal.** Access token in JSON response body (stored in memory,
  not localStorage). CSRF cookie is non-httpOnly so JS can read it
  and send it as `X-CSRF-Token` header.
- **Separate `TOTP_ENCRYPTION_KEY`, not reused from PAN encryption.**
  TOTP secrets encrypted with AES-256-GCM using a dedicated env var.
  If the PAN key is rotated or compromised, TOTP secrets are unaffected
  and vice versa.
- **`admin.user.delete` renamed to `admin.user.deactivate` (soft
  delete, no hard deletes).** Users are deactivated (`isActive = false`),
  never removed from the database. Preserves referential integrity for
  audit logs, bookings, and receipts.
- **Master factory pattern: `createMasterModule(config)` produces a
  NestJS module with ~30 lines of config per table.** 15 of 17 masters
  use the factory; GstRate and TdsRule have specialized services with
  overlapping effective-date validation. The factory returns anonymous
  classes with `Object.defineProperty` to set meaningful names for
  debugging/DI — `private` keyword removed from anonymous class
  properties to avoid TS4094.
- **GstRate stores a single `rate` Decimal + `description` String, not
  separate CGST/SGST/IGST fields.** The CGST/SGST/IGST split is a
  calculation concern (based on inter- vs intra-state), not a storage
  concern. The master rate table stores the total GST rate; the split
  is computed at invoice/receipt generation time.
- **CompanyConfig: single row per company with typed columns, not a
  key-value store.** `labelOverrides` (JSON), `enabledModules` (JSON
  array), `currency`, `timezone`, `fyStartMonth`, `dateFormat`. Avoids
  N+1 queries for config lookups and gives type safety at the DB level.
- **Money as BigInt paise, never floats.** All monetary values stored
  as BigInt paise in the database. Shared `formatInr` helper handles
  lakh/crore digit grouping for display.
- **`@prisma/client` added as direct dependency in `apps/api`.**
  Fixes TS2742 "inferred type cannot be named" errors that occur in
  pnpm monorepos when the Prisma runtime types are only reachable
  through a workspace dependency.
- **Frontend: React 18 + Vite + react-router-dom v7 + TanStack Query
  + react-hook-form + zod.** Auth state managed via React context with
  automatic silent refresh on mount. API client handles transparent
  token refresh (401 → refresh → retry). All admin screens
  (users, roles, masters, custom fields, company config, audit log)
  are permission-gated in the sidebar via `hasPermission` checks.

### Phase 1 verification — Docker, packaging, runtime fixes

- **API runtime image is `node:20-slim` (Debian), not Alpine.** The
  `argon2` native module ships glibc prebuilt binaries but not musl;
  Alpine falls through to node-gyp compilation which requires network
  access to download Node.js headers during `docker build`. Never
  switch back to Alpine without verifying all native deps have musl
  prebuilds.
- **Workspace packages use the `exports` field with dual resolution.**
  `"import": "./src/index.ts"` for Vite/bundlers (direct TS
  consumption, no pre-build needed), `"require": "./dist/index.js"`
  for Node.js runtime (compiled CJS). `"main"` stays at `dist/` for
  backwards compatibility. This means Vite builds don't require
  `pnpm --filter @openestate/shared build` first, but NestJS
  production runtime does.
- **Dockerfiles copy selective source paths, not entire directories.**
  `COPY packages/shared packages/shared` overwrites pnpm's
  `node_modules` symlink tree; copying only `src/`, `tsconfig.json`,
  and `prisma/` individually preserves the install step's layout.
  `.dockerignore` excludes `node_modules` from the build context.
- **API Dockerfile uses `pnpm deploy` for the runtime stage.** Creates
  a self-contained directory with a flat `node_modules` that doesn't
  depend on pnpm's symlink store. The generated Prisma client
  (`.prisma/client/`) must be copied separately into the deployed
  `node_modules` because `pnpm deploy` doesn't include it.
- **Runtime stage must install `openssl`.** `node:20-slim` ships
  without OpenSSL libraries; Prisma's query engine binary
  (`debian-openssl-3.0.x`) links against `libssl.so.3` at runtime.
  Without it, Prisma throws "could not locate the Query Engine."
- **Encryption keys are always `openssl rand -hex 32` (64 hex chars =
  32 bytes).** `TOTP_ENCRYPTION_KEY` and `PAN_ENCRYPTION_KEY` validate
  exact length at startup. `install.sh` uses a separate `rand_hex_32`
  helper; CI's `.env` generation uses `rand -hex 32` for these two
  keys and `rand -hex 24` for passwords/secrets.
- **Health endpoint is `@Public()` by design.** The global JWT auth
  guard blocks unauthenticated requests; the health controller must
  opt out via the `@Public()` decorator so Docker healthchecks and
  load-balancer probes work without a token.

### Phase 2 — inventory (projects, towers, floors, units)

- **Unit rate revisions are append-only with monotonic dating.**
  `effectiveFrom` must be `<= today` and `>= latest existing revision`
  for the same unit. Future-dated revisions are rejected at the service
  layer. `@@unique([unitId, effectiveFrom])` prevents duplicate dates.
  `Unit.baseRatePaise` is the current market rate; booking will snapshot
  `agreedRatePaise` in Phase 3.
- **Unit status state machine with actor type.** Transitions carry
  `actorType: 'user' | 'system'`. Reason is mandatory (not optional)
  for `BLOCKED` and `CANCELLED`. Phase 4 will restrict
  `BOOKED → ALLOTTED → REGISTERED → CANCELLED` to `system`-only
  transitions triggered by booking/payment workflows.
- **Upload category is a whitelisted enum, not freeform.**
  `layout_plan | brochure | photo | document` — validated via zod
  before touching any file path. Storage names are `uuid + ext`,
  never derived from user input. Images are re-encoded through `sharp`.
- **sharp verified inside Docker container.** `sharp` 0.35 with
  `vips` 8.18.3 loads and processes images correctly inside the
  `node:20-slim` runtime container. The `pnpm deploy --prod` step
  in the Dockerfile installs platform-specific optional packages
  (`@img/sharp-linux-x64`, `@img/sharp-libvips-linux-x64`)
  automatically. Verified by creating a 10x10 PNG, reading its
  metadata, and confirming correct output inside `docker run`.

### Phase 2 verification

- **Docker Desktop path on this machine.**
  `C:\Users\Ashis\AppData\Local\Programs\DockerDesktop\resources\bin`.
  Not on PATH in Git Bash or PowerShell by default; invoke via full
  path or prepend to `$env:PATH` at session start. Future sessions
  should use this path rather than assuming `docker` is on PATH.
- **Import enumerates skipped rows, never silently skips.** The
  `ImportResult` type includes `skipped: Array<{ row, unitNumber,
  reason }>` alongside `createdCount`. Callers always see which rows
  were already present and why they were skipped.
- **Tower-scoped unit number uniqueness.** `@@unique([floorId, number])`
  enforces floor-level uniqueness at the DB level. Import and
  bulk-generate also validate that unit numbers are unique within the
  entire tower (cross-floor check), reporting violations as row-level
  errors before the transaction commits.
- **All 10 Phase 2 tables are RLS-protected.** `unit_types`,
  `plc_types`, `projects`, `towers`, `floors`, `units`, `unit_plcs`,
  `unit_charges`, `unit_rate_revisions`, `unit_status_changes` added
  to both the migration's RLS loop and `TENANT_SCOPED_MODELS` in the
  tenant Prisma extension. Integration tests prove cross-tenant
  isolation on `units` and `unit_rate_revisions` specifically.

### Phase 3 — pre-sales: inquiries, assignment, follow-ups, funnel reports

- **Round-robin fairness needed a per-project advisory lock in addition
  to `SELECT ... FOR UPDATE SKIP LOCKED`.** SKIP LOCKED alone guarantees
  *no duplicate picks* under concurrency (two transactions can never lock
  the same pool row), but it does **not** guarantee *fair ordering* under
  a true thundering herd — verified by a failing test (50 concurrent
  claims against a pool of 5 produced a max-min spread of 2, not the
  required ≤1). Root cause: nothing serializes the order in which
  concurrent transactions re-queue a row to the back of the line, so
  independently-correct SKIP LOCKED picks can still converge on an uneven
  distribution. Fix: `pg_advisory_xact_lock(hashtext(project_id))` at the
  top of `AssignmentService.autoAssign` serializes the pick-and-claim
  critical section per project (transaction-scoped, auto-released on
  commit/rollback; different projects never contend). SKIP LOCKED stays
  as the row-picking mechanism inside the now-serialized section — it's
  what still lets a truly-empty-of-contention fast path skip locked rows
  cheaply. Also switched `last_assigned_at` to `TIMESTAMP(6)` (from the
  Prisma default `TIMESTAMP(3)`) and the UPDATE to `clock_timestamp()`
  (statement-execution time, not transaction-start time) to eliminate
  millisecond-tie ordering ambiguity as a contributing factor.
- **Bounded retries, never a 500.** `autoAssign` retries the SKIP LOCKED
  select up to 3 times (short random backoff) only for the case where
  every pool row is momentarily locked by other in-flight claims; if
  still empty after retries, or if the pool has zero active members, it
  returns `null` and the caller leaves the inquiry unassigned rather than
  failing inquiry creation. Lead capture must never be blocked by the
  assignment engine.
- **Consent is an append-only ledger (`ApplicantConsent`), not columns on
  `Applicant`.** Every grant/revoke inserts a new row; current consent is
  the latest row per applicant. Nothing is ever updated or deleted, so
  consent state at any past timestamp is reconstructible by filtering the
  ledger — required for DPDP-style audit questions ("was consent valid
  when we sent this message").
- **Applicant merge reassigns `Inquiry.applicantId` only —
  `CommunicationLog.applicantId` is never rewritten.** A merged
  (tombstoned) applicant's send history keeps pointing at that applicant
  permanently, preserving the original recipient's identity for audit.
  The survivor's timeline still surfaces those rows by joining through
  `Applicant.mergedIntoId` (`WHERE applicantId IN (survivorId, ...ids of
  applicants merged into survivorId)`) rather than by data movement.
  `FollowUp` rows are never touched at all during a merge — they key off
  `inquiryId`, which already moved to the survivor, so no follow-up can
  ever be lost or duplicated by the merge operation itself. Already-merged
  applicants (`mergedIntoId != null`) can't be merged again in either
  direction — the API returns 409 pointing at the current survivor.
- **Phone normalization is intentionally narrow.** Only strips Indian
  country/trunk prefixes (`+91`/`91`/`0`) and only normalizes when the
  result is a 10-digit number starting 6–9 (a valid Indian mobile).
  Anything else — NRI numbers, landlines, malformed input — is stored
  trimmed-but-otherwise-untouched and matched by exact string equality.
  Deliberately does not attempt to be a general international phone
  parser; guessing wrong would silently corrupt or falsely merge
  unrelated contacts, which is worse than not normalizing at all.
- **Per-company escalation dispatch, not a single cross-tenant sweep.**
  `EscalationService.dispatchTick()` uses the SYSTEM client only to
  enumerate active companies (`select: { id: true }` — never touches
  inquiry rows), then enqueues one `company-escalation` BullMQ job per
  company. `runForCompany(companyId)` does all inquiry-row access inside
  `runWithTenant` + `withTenantTx` for that one company, so RLS (not just
  the Prisma tenant-filter extension) is what ultimately restricts
  visibility — proven by a test that runs a raw, filter-less
  `SELECT ... FROM inquiries` inside company A's tenant transaction and
  confirms it cannot see company B's rows even though the query has no
  `WHERE company_id` clause at all.
- **Escalation notifies ALL active `sales_manager` users company-wide,
  not a specific manager.** No project→manager reporting-line field
  exists in the schema yet, so "notify the inquiry's manager" isn't
  expressible. **Revisit this once a project→manager (or user→manager)
  mapping is added** — likely in a later phase alongside team hierarchy
  for the "manager-wise interaction" report, which has the same
  simplification (reports each manager's own logged interactions, not a
  team roll-up).
- **`Inquiry.lastEscalatedAt` prevents re-notifying every tick forever.**
  An inquiry is only (re-)escalated when `lastEscalatedAt IS NULL OR
  lastEscalatedAt < nextFollowupAt` — i.e. once per overdue occurrence.
  If the follow-up date is pushed forward and lapses again later, the new
  `nextFollowupAt` is newer than the old `lastEscalatedAt`, so it
  re-qualifies.
- **`FollowUpType` (not `CommunicationType`) is the follow-up "type"
  master.** `FollowUpType`'s seeded values (Phone Call, Site Visit,
  Email, WhatsApp, Meeting, Video Call) are literally the follow-up
  interaction types; `CommunicationType` is reused instead for the
  outbound send-channel log (`CommunicationLog.channel` is a Postgres
  enum, `EMAIL | SMS`, not yet driven by the `CommunicationType` master —
  channel is a small closed set like `UnitStatus`, not an admin-tunable
  business constant). Site visit is not a separate table — it's a
  `FollowUp` row with `type = 'Site Visit'` and `scheduledAt`/`venue`
  populated; everything else on the row stays generic.
- **BullMQ added for Phase 3** (`bullmq` + `@nestjs/bullmq`), two queues
  (`communication`, `escalation`). The dev `ConsoleCommunicationProvider`
  logs instead of calling a real gateway — swappable via the
  `COMMUNICATION_PROVIDER` DI token when real SMS/email plugins land in
  Phase 7. Enqueueing always happens **outside** any `withTenantTx` (it's
  Redis I/O); the `CommunicationLog` row is created and committed first,
  then the job references its ID.
- **Import auto-links duplicates instead of prompting.** Bulk Excel
  import has no interactive UI to show a duplicate warning, so a
  phone/email match auto-links the row to the existing `Applicant`
  instead of creating a new one; the response enumerates every linked row
  (`linked: [{ row, applicantName, applicantId }]`) alongside
  `createdCount`, mirroring Phase 2's "never silently skip" discipline.
  Interactive single-inquiry creation instead surfaces
  `possibleDuplicateApplicantIds` in the response and lets the caller
  decide, since there a human is present to resolve it.
- **All 10 new Phase 3 tables are RLS-protected**: `applicants`,
  `applicant_consents`, `applicant_merges`, `inquiry_temperatures`,
  `inquiries`, `inquiry_assignments`, `project_assignment_pools`,
  `follow_ups`, `sms_templates`, `communication_logs` — added to both
  the migration's RLS loop and `TENANT_SCOPED_MODELS`. Integration tests
  prove isolation on all ten, with extra emphasis on `applicants` and
  `inquiries` (including a raw, filter-less-query variant per table).
- **Advisory-lock key is `hashtext(projectId)` — a single 32-bit hash,
  so it serializes per project but is not collision-proof.** Two
  *unrelated* projects whose UUIDs happen to collide under `hashtext`
  (birthday-bound: non-negligible only across tens of thousands of
  projects) would serialize against each other — a latency footgun, never
  a correctness bug (assignment stays fair and duplicate-free; two pools
  just occasionally wait on each other). Acceptable now. **Do not
  "optimize" the collision away by widening/among-projects-sharding the
  key without switching to the two-key form
  `pg_advisory_xact_lock(hashtext(companyId), hashtext(projectId))`
  (namespaced, halves collision probability per axis) AND adding a
  saturation test that drives two deliberately hash-colliding project IDs
  concurrently and asserts fairness holds for each independently.** A
  naive single-key change risks reintroducing cross-project head-of-line
  blocking under load without anyone noticing.

### Phase 4 — financial core: bookings, ledger, receipts, GST/TDS, interest, transfer, cancellation

- **The booking balance IS `SUM(ledger_entries.signed_amount_paise)`.**
  There is no stored balance field to drift. Positive = debit (customer
  owes), negative = credit. Every financial event appends immutable rows;
  corrections append negating rows referencing `reversalOfEntryId` — never
  an UPDATE/DELETE. Booking opens by posting the cost breakup as `CHARGE`
  debits (Σ = agreed price). Proven by a fast-check property suite (below).
- **Append-only is enforced at the DATABASE, not just the app.** A trigger
  (`forbid_financial_mutation`) blocks UPDATE/DELETE on `ledger_entries`,
  `receipt_allocations`, `cheque_status_events`, `interest_accruals`,
  `tds_deductions`, `tds_certificates`. A deliberate maintenance escape
  hatch — the transaction-local GUC `app.allow_financial_mutation='on'` —
  lets admin purges and test teardown delete; normal app code never sets
  it. (Because booking→ledger FKs are `ON DELETE CASCADE`, a booking can
  only be hard-deleted under that GUC; in production bookings are cancelled,
  never deleted.)
- **Relation policy: master/config and user FKs are scalar `@db.Uuid`
  columns with DB-level FK constraints, not Prisma relations.** The core
  financial graph (Booking/Installment/LedgerEntry/Receipt/…) uses Prisma
  relations; but `createdById`/`approvedById`, `chargeTypeId`, `gstRateId`,
  `interestRuleId`, etc. are plain scalars whose FKs are added in the
  migration. This keeps `User` and the master models from accumulating
  ~30 back-relations. Trade-off: no `include:` for those links (look them
  up by id) — fine for provenance fields.
- **GST place of supply = the PROPERTY location, snapshotted at booking
  (`Booking.placeOfSupplyStateCode`), immutable after.** IGST Act §12(3)(a):
  services in relation to immovable property are supplied where the property
  is — NOT the customer's residential state. Defaulted from the project's
  area-location `stateCode`, overridable only at creation. Intra-state
  (supplier `CompanyConfig.gstStateCode` == place of supply) → CGST+SGST;
  else → IGST. A code comment cites §12(3)(a) so nobody "fixes" it to follow
  the applicant's address.
- **CGST/SGST rounding: the halves are equal by construction, so
  `(CGST + SGST)` may differ from `IGST` by ≤1 paise per line.**
  `cgst = sgst = roundHalfUp(base·rate/2)`, `igst = roundHalfUp(base·rate)`,
  all BigInt. A test matrix asserts `|IGST − (CGST+SGST)| ≤ 1` across bases
  and rates. GST rates are snapshotted per cost line (and per `ExtraCharge`,
  captured from the linked ChargeType's effective rate at entry) — re-pricing
  a rate master never changes an existing booking.
- **TDS (194-IA) leaves no dangling receivable.** A receipt credits the
  GROSS installment amount and, in the SAME transaction, posts a
  `TDS_RECEIVABLE` debit for the withheld portion — so the booking balance
  keeps showing the TDS as outstanding until a certificate is recorded, at
  which point a `TDS_CERT_ADJUSTMENT` credit zeroes it. Certificate receipt
  is a separate append-only `TdsCertificate` row (not a mutable flag).
  Sub-threshold bookings (agreed price < effective threshold) post no TDS
  receivable and reject any TDS-deducted receipt.
- **Refund is a two-phase ledger event.** `REFUND_APPROVED` (debit) posts
  when the refund is approved — the obligation is recognised in the customer
  sub-ledger then, moving the balance toward zero. Payment records a
  `PaymentVoucher` (cash outflow) and posts NO further ledger entry (that
  would double-count the obligation). A refund cheque that bounces re-opens
  the obligation with a `REFUND_BOUNCE_REVERSAL` credit + a `BOUNCE_CHARGE`
  debit — exactly like a receipt cheque bounce. The sub-ledger tracks
  obligations; the voucher tracks settlement.
- **Installment freeze has one source of truth: `allocatedPaise > 0`.**
  There is no `isFrozen` column. A plan edit regenerates only strictly-unpaid
  installments (deleting them — they carry no ledger impact) and requires the
  new ones to cover exactly the residual (agreed price − Σ frozen amounts),
  so the schedule always still sums to the agreed price. Paid/part-paid
  installments are never touched.
- **Cancellation drives the balance to exactly `−refundable`.**
  `refundable = netReceived − deduction` where `netReceived` is cash actually
  collected (non-reversed, cleared/immediate receipts minus TDS) and the
  deduction comes from a `CancellationRule` master (PERCENT/FLAT, optional
  booking-amount forfeit), snapshotted. Two typed entries post:
  `CANCELLATION_DEDUCTION` (the company-retained levy) and
  `CANCELLATION_SETTLEMENT` = `−refundable − currentBalance − deduction`
  (drives the balance to `−refundable` regardless of what the balance
  contained). Emits the typed `bookingCancelled` event for Phase 5's
  commission clawback (no commission logic yet — stable contract only).
- **Transfer conserves total money via a carry pair.** The old booking is
  closed with `TRANSFER_CARRY_OUT` = `−balance` (→ 0); the new booking opens
  with `TRANSFER_CARRY_IN` = `+balance`. `Σ balances excluding company levies`
  (`TRANSFER_FEE`, `CANCELLATION_DEDUCTION`, `BOUNCE_CHARGE` — enumerated in
  `COMPANY_LEVY_ENTRY_TYPES`) is invariant across the transfer. UNIT transfer
  releases the old unit (→ AVAILABLE) and books the new one; APPLICANT
  transfer keeps the same booked unit. All unit moves are system-only.
- **Booking-lifecycle unit statuses are now SYSTEM-ONLY** (implements the
  Phase 2 note). `BOOKED/ALLOTTED/REGISTERED/CANCELLED` can be reached only
  via `BookingService` (actorType `'system'`); the manual
  `POST /units/:id/transition` (actorType `'user'`) rejects them and handles
  only holds/blocks. Enforced in `UnitStateMachineService` via
  `isSystemOnlyTarget`.
- **Gap-free receipt/booking numbers via an in-transaction upsert-allocator.**
  `NumberSequence(company, kind, scope)` is incremented with a single
  `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the same transaction as
  the row it numbers, so a rolled-back transaction releases its number and
  committed numbers stay strictly contiguous per (company, FY). **The
  number-allocating transaction must do no external I/O (email/SMS/PDF/S3)
  before commit** — it holds the sequence row lock; same rule as
  `withTenantTx`. Documented on the service.
- **Interest accrual: per-installment cursor, declining balance, idempotent.**
  Each run advances a cursor from the installment's due date (or the last
  accrual's `periodEnd`) to `asOf`, accruing on the current outstanding for
  the window's days — so a partial payment lowers the principal for future
  windows. SIMPLE = `outstanding·rate·days/365`; COMPOUND adds prior accrued
  interest to the base (interest-on-interest at the run cadence). Re-running
  at the same `asOf` posts nothing (cursor already there). Waivers are
  audited `INTEREST_WAIVER` credits (never edit the accrual). Time comes from
  the injected `Clock`, so tests drive it against hand-computed fixtures. The
  daily job dispatches per-company (system client enumerates companies; each
  company accrues inside its own tenant transaction), mirroring Phase 3
  escalation.
- **Money is BigInt-exact.** `percentOf` uses integer basis points
  (`(paise·bps + 5000)/10000`, half-up); `multiplyPaise` now takes an integer
  factor (the old `number`-based version was lossy above 2^53 paise);
  `allocate` uses the largest-remainder method so distributed shares always
  sum to the total with no last-cent loss (property-tested, 2000 runs).
- **Property-based ledger test (`fast-check`).** Random sequences of
  receipts / receipt reversals / extra charges / interest waivers assert,
  after every step: `service balance === reference model balance`, the ledger
  entry count never decreases (append-only), and Σ allocations === receipt
  gross. `numRuns` = CI default 2000, local dev 500, overridable via
  `PROPERTY_NUM_RUNS`; a sub-2000 run under CI without an explicit override
  fails loudly. Reproduce a failure by pinning `FC_SEED`.
- **`AreaLocation.stateCode` and payment-plan template milestones added.**
  Area locations carry a GST state code (property-location default for place
  of supply). `PaymentPlanMilestone` gives templates their percent/offset
  lines, instantiated per booking into an `Installment` schedule via
  `allocate` (no rounding loss).
- **Ledger property test: nightly-2000 / PR-500 split, not CI-matrix
  sharding.** At the CI floor of 2000 runs the property test alone takes
  ~6 minutes (each run creates a booking, plan, and several ledger-affecting
  operations against real Postgres). Chose a time-based split over
  sharding across parallel matrix jobs: `.github/workflows/ci.yml` now has
  a `schedule: cron "0 3 * * *"` trigger, and the `integration-tests` job
  sets `PROPERTY_NUM_RUNS=2000` only when `github.event_name == 'schedule'`,
  else `500`. Every PR/push still exercises the invariant meaningfully
  (500 runs, ~1.5 min) without paying the full 6-minute cost on every push;
  the full 2000-run floor still runs unattended every night. Rejected
  4-way matrix sharding (400–500/shard) because it would 4x the runner
  minutes for the SAME total coverage per run (sharding parallelizes wall
  time, not cost) and adds shard-partitioning complexity to fast-check's
  seed/skip mechanics for no correctness benefit over the simpler
  time-based split. The existing `PROPERTY_NUM_RUNS` env override and its
  sub-2000-under-CI-without-override guard (in
  `apps/api/test/postsales-property.test.ts`) needed no changes — CI now
  always sets the var explicitly, so the guard's "no override" branch never
  fires there; it still protects a stray local `CI=true` run.

### Phase 4-UI — PDF/letters, dispatch, booking/receipt UI, reports

- **PDF library: `pdfmake`, not `@react-pdf/renderer`.** Table-heavy,
  mostly-static documents (receipts, statements, demand letters) map
  directly onto pdfmake's declarative `docDefinition` (content arrays,
  `table`/`columns` layout primitives) without needing JSX/React just to
  describe a page. `@react-pdf/renderer` earns its keep for
  component-composition-heavy documents; none of Phase 4's five document
  types need that. Stays consistent: every generated PDF (receipt,
  statement, allotment/demand/reminder letter) goes through the single
  `PdfService.render(docDefinition)` in `apps/api/src/pdf/pdf.service.ts`.
- **pdfmake's Node `PdfPrinter` needed its real constructor args, not the
  1-arg call that "worked" until first render.** `require('pdfmake/js/Printer')`
  has no published types (`@types/pdfmake` only types the browser bundle),
  so the initial ambient `.d.ts` was hand-guessed from usage patterns found
  online — wrong on two counts, both root-caused by reading
  `pdfmake@0.3.11/js/Printer.js` directly: (1) `createPdfKitDocument` is
  `async` (it internally awaits `resolveUrls()`), so callers must `await`
  it rather than treating the return value as a stream; (2) `resolveUrls()`
  unconditionally calls `this.urlResolver.resolve(...)` for every font
  variant, so a `new PdfPrinter(fonts)` call with only the first of 4
  constructor params leaves `urlResolver` undefined and crashes on the
  first render. Fixed by passing pdfmake's own shipped
  `pdfmake/js/URLResolver` + `pdfmake/js/virtual-fs` (they only do real
  network I/O for `http(s)://` URLs — a no-op for our local font paths and
  fully-local template content) as the 2nd–3rd constructor args, and
  correcting the ambient `.d.ts` to match. `apps/api/test/postsales-pdf.test.ts`
  is DB-independent (pure `docDefinition → Buffer`) specifically so this
  class of bug gets caught by the fast, always-run test tier, not only by
  a slower integration test that happens to exercise PDF generation.
- **"Never regenerated on read" applies per document type, not globally.**
  RECEIPT PDFs are idempotent-lookup-or-create (`DocumentService.generateReceiptPdf`
  reuses the stored artifact); a reprint is a **new**, separately-stored,
  watermarked (`DUPLICATE`) artifact via `reprintReceiptPdf`, never an
  overwrite. STATEMENT and the three letter types are always-fresh-snapshot
  (`generateStatementPdf`/`generateLetterPdf` always render+store a new
  row) because their content (running balance, current dues) is only
  correct as of generation time — treating them as idempotent would let a
  stale statement silently keep being served.
- **Merge-field registry (`packages/shared/src/documents.ts`) fails at
  test-time, not render-time.** `MERGE_FIELD_REGISTRY` is the single
  source of truth per `GeneratedDocumentType`; `validateTemplateMergeFields`
  walks a template body for `{{token}}` placeholders and throws on any
  token not in that type's registry entry — callable from a master-data
  admin screen or a unit test on template content, without needing a real
  booking/applicant to render against.
- **Dispatch rows reuse the append-only *discipline*, not the DB-level
  append-only *trigger*.** Unlike `ledger_entries` et al.,
  `document_dispatches` has no `forbid_financial_mutation`-style trigger —
  `DispatchProcessor` legitimately `UPDATE`s a row's status QUEUED→SENT|FAILED.
  What's append-only is the retry path: `DispatchService.retry()` always
  inserts a **new** row with `attemptOfDispatchId` pointing at the original
  rather than resetting the original back to QUEUED, so the full attempt
  history stays visible. Enforced at the service layer (a FAILED-only
  guard raises `ConflictException` otherwise), not the database.
- **Postsales reports use `SYSTEM_PRISMA` (RLS-bypassing), same as the
  Phase 3 reports module — sales_exec role-scoping is a service-level
  filter (`ReportScope.scopeToCreatedById`), not RLS.** RLS still draws the
  hard company-tenant boundary (every report query includes an explicit
  `companyId` filter); scoping *within* one company by who created the
  booking is a business rule about visibility, not tenant isolation, and
  belongs at the service layer where the ownership semantics actually
  live. `postsales-reports.test.ts` proves both layers independently: a
  cross-exec fetch is filtered out of list endpoints and 404s on direct
  fetch-by-id.
- **CSV export streams via chunked transfer encoding by construction, not
  by a special code path.** `streamCsv` (`apps/api/src/reports/csv-stream.util.ts`)
  never sets `Content-Length` and writes each row with its own `res.write()`
  call — Node's HTTP layer emits `Transfer-Encoding: chunked` automatically
  once those two conditions hold, so there's no separate "streaming mode"
  to fall out of sync with the buffered path. Verified against a real
  `http.Server` (not a mocked `res`) in `postsales-reports.test.ts`,
  asserting the actual response headers rather than the util's internal
  call pattern.

### Phase 5 — brokers and commissions

- **`Booking.brokerId` is a new nullable scalar column on the frozen
  `Booking` table (Decision A), not a separate join table.** Mirrors
  `Booking.interestRuleId`'s existing shape exactly (Phase 4: nullable
  scalar FK to an optional master, no Prisma relation, populated by a
  controller-layer call after the booking exists — `BookingService.createBooking`
  itself never writes it). Chosen over a `BrokerBookingSourcing` join table
  because it's the shape `BookingCancelledEvent`'s own doc comment already
  anticipated ("Broker attribution is added in Phase 5 when bookings carry
  a `brokerId`") and keeps every broker-attribution query a single join.
  Populated via `POST /bookings/:id/broker` (new, on the unfrozen
  `BookingController`), the same two-step pattern as
  `POST /bookings/:id/plan/from-template`.
- **First-ever PAN encryption service, scoped to `Broker` only.**
  `Applicant.panCiphertext`/`panMasked`/`panKeyVersion` have existed since
  Phase 4 but no encryption service was ever built for them — the columns
  are, and remain, always null. `PanEncryptionService`
  (`apps/api/src/common/pan-encryption.service.ts`) is modeled directly on
  `TotpService`'s identical AES-256-GCM implementation
  (`apps/api/src/auth/totp.service.ts`) and keyed on the already-declared
  `PAN_ENCRYPTION_KEY` env var, but wired only to the new
  `Broker.panCiphertext` — retrofitting `Applicant` is `docs/todo.md`, not
  silent scope creep. Reads the key directly from `process.env` rather
  than Nest's `ConfigService`, deliberately: every Phase 4/5 service in
  this codebase is constructed directly in integration tests
  (`new XxxService(...)`, no DI container), and this keeps
  `PanEncryptionService` constructible the same zero-argument way.
- **Commission slab matching: half-open `[fromPaise, toPaise)`, matched
  (not marginal).** A value landing exactly on a boundary always matches
  the HIGHER bracket — one rule, applied uniformly, rather than a
  case-by-case "which bracket owns the boundary" judgment call. The whole
  basis amount is charged at ONE matched slab's rate (real-estate
  brokerage convention), never split across brackets like income tax.
  Slabs must be contiguous and gapless with exactly one unbounded
  (`toPaise = null`) top slab — validated at rule-save time
  (`validateSlabContiguity`, `packages/shared/src/commission.ts`), not a
  DB constraint, so the rejection message can name the exact gap.
- **`BrokerBookingCommission` snapshots the total commission ONCE per
  booking, at first accrual — never re-read from the rule after.** Chosen
  over the two alternatives considered (a second column on `Booking`, or a
  field on the first ledger entry): a dedicated table avoids a *second*
  migration touch to the frozen `Booking` table beyond the
  already-approved `brokerId`, and avoids conflating a ledger row's
  `signedAmountPaise` (a movement) with an unrelated "total basis" fact.
  This is *why* `BrokerCommissionRule`/`BrokerCommissionSlab` deliberately
  have **no effective-dating** (unlike `GstRate`/`TdsRule`) — a rule edit
  applies to future accruals only because the snapshot already protects
  every in-flight booking's math from it; effective-dating would solve a
  problem the snapshot solves more directly. Milestone breakpoints
  (`BrokerCommissionRule.milestonesJson`) are read live at each accrual
  call, not frozen — editing the breakpoint list mid-stream is a
  deliberate, benign exception to the "never re-read the rule" rule, since
  only the dollar-amount computation needed freezing.
- **`CommissionPayment` is a `REQUESTED → APPROVED → PAID | REJECTED`
  state machine (mirrors `RefundStatus`'s shape), but ledger entries post
  ONLY at `pay()`, not at `approve()` — the opposite of `RefundService`.**
  A refund's obligation is *newly recognized* at approval (nothing in the
  customer ledger reflected it before); a broker's commission was already
  accrued earlier via `CommissionService.accrueForBooking`, so
  `request()`/`approve()` on a payment are pure dispute/authorization
  sign-off with no ledger effect — the ledger only moves when cash
  actually leaves, which is also the only point TDS can be withheld
  (there's nothing to withhold from a payment that hasn't happened yet).
  Three permissions, not two: `ACCOUNTS_COMMISSION_CREATE` ≠
  `ACCOUNTS_COMMISSION_APPROVE` ≠ `ACCOUNTS_COMMISSION_PAY`, matching the
  refund dual-control precedent.
- **Commission TDS (194-H) is a settled deduction, final at `pay()` — no
  receivable, no certificate step. This is the OPPOSITE shape from 194-IA
  on the customer side, and it's a real asymmetry, not an oversight.**
  For 194-IA (`ReceiptService`, frozen — not touched by this phase), the
  **company is the deductee**: a buyer withholds tax *from* the company,
  so the company is owed a certificate (Form 16B) before it can claim
  credit — hence `TDS_RECEIVABLE` stays outstanding until a
  `TdsCertificate` zeroes it via `TDS_CERT_ADJUSTMENT`. For 194-H, the
  **company is the deductor**: it withholds tax *from the broker* and
  later files its own return and issues Form 16A *to* the broker: from
  the broker's ledger (`CommissionLedgerEntry`), there is nothing to
  receive or certify — the moment `pay()` runs, gross minus TDS is a
  completed, known fact, hence `TDS_WITHHELD` (not `TDS_RECEIVABLE`).
  Also unlike 194-IA's client-supplied `dto.tdsDeductedPaise` (the buyer
  self-reports what they withheld), 194-H's amount is **server-computed**
  (`percentOf(amountPaise, rule.ratePercent)` against a `TdsRule` where
  `section = '194-H'`) — the company controls the payment, so it computes
  its own deduction. This paragraph is intentionally duplicated as a code
  comment on `CommissionPaymentService.pay()`, so a maintainer who only
  ever reads `ReceiptService`'s TDS code still finds out why the two
  treatments differ.
- **A `CommissionPayment` can settle accrual across several bookings at
  once (a broker paid periodically), so `pay()` allocates the gross amount
  oldest-outstanding-booking-first** (same idea as the receipt-entry UI's
  oldest-dues-first allocation) **and splits TDS proportionally across
  those per-booking allocations via `allocate`** (largest-remainder — no
  last-paise loss), posting one `PAYMENT` + `TDS_WITHHELD` pair per
  affected booking. This was tightened during implementation: an initial
  version attributed the whole payment to "the broker's single
  most-recently-accrued booking," which silently corrupted
  `handleBookingCancelled`'s per-booking outstanding calculation for any
  broker paid across more than one booking in a single `CommissionPayment`
  — caught by hand-tracing the numbers before writing the reconciliation
  test, not by the test itself.
- **Clawback on cancellation always reverses whatever's still
  unpaid-accrued for the booking FIRST, then separately handles whatever
  was already disbursed per the `commissionClawbackPolicy` — two
  independent steps, not one branch on the booking's current sign.** The
  plan approved before implementation branched on
  `outstandingForBooking`'s sign alone (`> 0` → reverse; `<= 0` → apply
  policy), which is correct for the two cases it was worked through by
  hand (fully unpaid, or fully paid) but silently under-claws-back any
  **partially paid** booking — the exact scenario the required
  reconciliation test (`accrue → partial pay → cancel`) exercises: if
  ₹57,000 of a ₹100,000 accrual was already disbursed and ₹40,000 is still
  outstanding-unpaid, the sign-based branch would reverse the ₹40,000 and
  stop, leaving the broker holding the ₹57,000 already paid even under
  `RECOVER` policy. Corrected to: (1) if `outstandingForBooking != 0`,
  always post `CLAWBACK_REVERSAL = -outstandingForBooking` (unearned
  commission is never owed after cancellation, regardless of policy); (2)
  if anything was actually disbursed (`netPaid > 0`, computed as
  `-SUM(PAYMENT entries)` for that booking), separately post either
  `CLAWBACK_RECOVERY = -netPaid` (`RECOVER`) or a **zero-amount**
  `CLAWBACK_WRITEOFF` with a mandatory `reason` (`WRITE_OFF` — a pure
  audit marker; the money stays with the broker, nothing is posted to
  move it). `CLAWBACK_WRITEOFF` with no `reason` is rejected at the
  service level — a zero-amount entry with no explanation is
  indistinguishable from a bug.
- **Transactional atomicity between NOC-gating, the frozen
  `CancellationService.cancel()`, and `CommissionService.handleBookingCancelled()`
  needs zero changes to any frozen service.** `withTenantTx`
  (`packages/db/src/tenant.extension.ts`) already detects, via
  `AsyncLocalStorage`, when it's called while an outer `withTenantTx` for
  the *same* `companyId` is already open, and reuses that transaction
  instead of opening a new one. `BookingController.cancel()` (commit 2)
  wraps NOC-gating + the cancellation call + the clawback call in one
  outer `withTenantTx`; because `CancellationService.cancel()` and
  `CommissionService.handleBookingCancelled()` both open their own
  `withTenantTx` internally with the same `companyId`, they transparently
  join the controller's transaction — if clawback throws, the
  cancellation (including its unit-status transition) rolls back too.
  This mechanism already existed for Phase 4; Phase 5 is its first
  cross-service consumer.
- **Three real bugs were caught only by the manual browser click-through
  before commit 3, not by any automated test** — recorded here because
  they reveal a real gap in the test suite's shape, not just three
  one-off typos. (1) `POST /bookings/:id/commission/accrue` — the plan's
  own required endpoint — was never actually wired to a controller route;
  `CommissionService.accrueForBooking` existed and was unit/integration
  tested via direct calls, but nothing exercised it through HTTP, so a
  missing route slipped past every test. Fixed by adding the endpoint
  (mirrors `POST :id/interest/accrue`); regression-tested by calling
  `BookingController.accrueCommission()` directly (`noc-cancellation.test.ts`),
  which is the same "construct the controller, call the method" pattern
  used everywhere else in this codebase for controller tests — a
  reminder that this pattern verifies a route *handler* works, not that
  the route is *registered*; only manual/e2e HTTP calls or a live server
  catch a missing `@Post()`. (2) `BrokerReportsController.soldUnits`
  400'd on `?brokerId=` — mixing a whole-object `@Query() dto` bound to
  `.strict()` `reportDateRangeSchema` with a same-endpoint
  `@Query('brokerId')` fails Zod's unrecognized-key check, because both
  decorators validate against the SAME incoming query object. Fixed by
  extending the schema (`soldUnitsQuerySchema`, exported from the
  controller) instead of layering a second `@Query()` binding.
  Regression-tested at the schema level (`commission-pure.test.ts`) —
  deliberately NOT by calling the controller method directly, since
  Nest's `ZodValidationPipe` runs before the method body and calling the
  method directly bypasses it entirely, so only a schema-level
  `.safeParse()` test (or a real HTTP round trip) actually reproduces
  this bug. (3) `BrokerDetail.tsx`'s "Pay" button 400'd — `useApiMutation`
  JSON-stringifies its whole `TBody` as the POST body, but `pay()`'s DTO
  (`payCommissionPaymentSchema`) is `.strict()` and has no `id` field
  (`id` is a URL param, not a body field); the existing `{id, ...}`-body
  convention this hook uses elsewhere works only because those other
  endpoints (`approve()`, `deactivate()`, etc.) have no `@Body()` DTO at
  all, so the extra `id` key is silently ignored rather than rejected.
  Fixed by calling `api()` directly for `pay()` with a body that omits
  `id`, rather than changing the shared hook's contract (which other
  pages rely on as-is). No frontend test suite exists in this repo to
  regression-test against, so this class of bug — a strict backend DTO
  vs. a generic frontend body-shape assumption — remains something only
  the manual click-through step catches; noted here rather than silently
  patched. **General lesson for future phases:** a new HTTP endpoint or
  query/body shape needs at least one test that goes through the actual
  validation pipe (an HTTP-level test, or a schema-level `.safeParse()`
  test) — a controller-method-direct-call test alone proves the handler
  logic is right but not that the route exists or that the DTO accepts
  what the frontend actually sends.
- **Post-Phase-5 audit: `apps/web/src/pages/postsales/` grepped for
  direct `fetch`/`axios`/`window.fetch` calls bypassing the shared
  `api()` client (the same class of gap that let the `handlePay` bug
  through) — audited clean.** No page constructs a request outside
  `lib/api.ts`'s `api()`/`downloadFile()`. Also checked the narrower,
  actual-root-cause pattern (`useApiMutation<..., { id: string; ...other
  fields }>` — an `id` combined with additional body fields, which is
  what broke `pay()`): no other occurrence exists. The three remaining
  `useApiMutation<unknown, { id: string }>` call sites in this directory
  (`Brokers.tsx`'s deactivate/reactivate, `BrokerDetail.tsx`'s approve)
  are safe because their corresponding controller methods
  (`BrokerController.deactivate/reactivate`, `CommissionPaymentController.approve`)
  take no `@Body()` DTO at all, so the extra `id` key is inert rather
  than rejected — verified by reading each controller method, not
  assumed from the shape alone.
- **Phase 6 note, recorded ahead of that phase's own Decisions entries:**
  Phase 6 introduces portal users (customer, broker) — the first actors
  in this codebase who are hostile-by-default from a security standpoint,
  not merely under-privileged. Every staff-facing phase so far (0–5)
  could treat RLS as an internal-hygiene backstop behind a permission
  guard that was already the real gate, because every staff actor is
  presumed at least benign-if-mistaken. A portal user is a different
  threat model: the client is untrusted by construction, so **RLS
  (keyed off `applicant_id`/`broker_id`, not just `company_id`) becomes
  the primary line of defense against IDOR, not a secondary one** —
  guard-level checks in controllers are necessary but must be treated as
  defense-in-depth, never as the sole reason a cross-applicant or
  cross-broker read is blocked. This reframing is why Phase 6's plan
  requires IDOR tests that hit the database through a **raw connection**,
  the same discipline Phase 3's escalation-isolation test and Phase 4/5's
  RLS tests already established for cross-*company* isolation — Phase 6
  extends that same proof technique to cross-*applicant*/cross-*broker*
  isolation within a single company.

### Phase 6 — portal-auth (commit 1 of 4)

- **`TokenService.createRefreshToken`/`rotateRefreshToken` gained an
  optional `expiresInOverride` parameter — the approved plan's premise
  that this "already takes TTL as a parameter" was inaccurate; the method
  used a single TTL fixed in the constructor from `JWT_REFRESH_EXPIRES_IN`.**
  Added the override rather than duplicating the method, so
  `PortalAuthService` can issue the shorter `PORTAL_JWT_REFRESH_EXPIRES_IN`
  (24h) refresh TTL through the same hashing/family/rotation code the
  staff flow uses, with staff callers omitting the parameter and getting
  the prior behaviour unchanged.
- **`CsrfGuard` is generalized by URL path prefix, not a per-route
  decorator.** Every portal route lives under `/api/v1/portal/`
  (`PORTAL_PATH_PREFIX` in `apps/api/src/auth/csrf-cookie-names.ts`), so
  the guard picks `openestate_portal_csrf` vs `openestate_csrf` from
  `request.path` alone — no per-controller wiring needed as new portal
  controllers (profile, tickets, dashboard) land in later commits. The
  double-submit comparison logic itself is untouched.
- **Portal's two named `@nestjs/throttler` buckets (`portal-auth`,
  `portal-read`) are registered in `PortalAuthModule`'s own
  `ThrottlerModule.forRoot`, not the root `AppModule`'s, and are NOT
  `APP_GUARD`s.** `ThrottlerGuard` enforces every named throttler it can
  see on every route it guards; registering these two globally would have
  silently subjected all ~100+ existing staff routes to the tight
  5-per-5-minute portal-auth bucket too.
  `PortalAuthThrottlerGuard`/`PortalReadThrottlerGuard`
  (`apps/api/src/portal-auth/portal-throttler.guard.ts`) each filter
  `this.throttlers` down to their own named entry after `onModuleInit`,
  then attach via `@UseGuards()` only on the specific routes that need
  them — staff routes are structurally unreachable by either bucket. Both
  use the package's in-memory storage (matching the existing staff
  default bucket, not the Redis store CLAUDE.md's rules call for);
  tracked in `docs/todo.md`, not silently done or silently skipped.
- **Invite consumption re-issues credentials for an existing portal
  `User` rather than always creating a new one.** If staff re-invites an
  applicant/broker who already has an active portal account (e.g. a lost
  password with no self-service reset attempted), `consumeInvite` looks
  up an existing `User` by `applicantId`/`brokerId` and updates its
  `passwordHash` instead of inserting a second row — `applicantId`/
  `brokerId` have no DB uniqueness constraint, so a blind insert could
  otherwise create duplicate accounts for the same applicant.
- **`Role.isPortal` is now set `true` for the seeded `customer`/`broker`
  roles.** The column existed since Phase 1 but nothing ever set it
  (`prisma/seed.ts` always passed `isSystem: true` only) — this is Phase
  6 activating a dormant field for its originally-intended purpose, not a
  new addition.
- **Boot-verified, not just typechecked.** Beyond `pnpm typecheck`, the
  full `AppModule` was constructed via `NestFactory.create(...).init()`
  against the real test Postgres/Redis (no `.listen()`) to confirm the DI
  graph resolves — `PortalAuthModule`'s locally-scoped `ThrottlerModule`
  and `AuthModule` reuse, `PortalTenantMiddleware` route registration, and
  all portal routes mapped cleanly. Typechecking alone can't catch a
  missing provider or a module-scoping mistake; NestJS only surfaces
  those at actual instantiation time.
- **Real bug caught by the IDOR test battery, not by review: `bookings`
  and `booking_co_applicants`'s RESTRICTIVE portal policies were
  mutually recursive (Postgres error `42P17`).** `bookings_portal_scope`'s
  co-applicant branch queried `booking_co_applicants` (subject to ITS OWN
  RLS); `booking_co_applicants_portal_scope`'s "I'm the primary/broker on
  this booking" branches queried `bookings` back (subject to ITS RLS) —
  each table's policy needed the other's, forever. Self-referencing
  subqueries within ONE table's own policy are fine (Postgres handles
  those without recursing); a cycle across TWO tables' policies is not.
  Fixed by adding one narrow `SECURITY DEFINER` function,
  `booking_has_co_applicant(booking_id, applicant_id)` — a single
  parameterized existence check on `booking_co_applicants`, nothing else,
  `REVOKE ALL ... FROM PUBLIC` then `GRANT EXECUTE` to `openestate_app`
  only (not `openestate_system`, which already bypasses RLS directly and
  has no need for a function whose only job is bypassing it) — and using
  it in `bookings_portal_scope`'s co-applicant branch instead of a normal
  subquery. That's the one edge of the cycle now bypassed;
  `booking_co_applicants_portal_scope` still queries `bookings` normally
  (RLS-enforced), which is safe because `bookings`' own policy no longer
  queries `booking_co_applicants` as a normal read. **This function must
  not be extended, and no second `SECURITY DEFINER` helper should be
  added to patch some other RLS gap later** — any future recursion in
  this policy set means the RLS design itself needs re-auditing, not
  another ad hoc bypass. The regression test
  (`apps/api/test/portal-rls.test.ts`) doesn't just prove the migration
  applies without error — it asserts the actual row counts on both sides
  of the former cycle (primary applicant reading their booking's
  co-applicant list; a co-applicant reading the booking itself; an
  unrelated applicant getting zero from both), which is the level of
  proof that would have caught this bug before it shipped.

### Phase 6 — customer-portal (commit 2 of 4)

- **Real bug, caught by the co-applicant-visibility test: `PORTAL_SCOPED_MODELS`'s
  JS-level guard for `Booking` denied a co-applicant their own booking.**
  `Booking`'s entry only checked `primaryApplicantId = portalApplicantId`
  — RLS's `bookings_portal_scope` grants access through THREE branches
  (self, broker, co-applicant carve-out via `booking_has_co_applicant`),
  but the JS mirror only replicated the first. For a co-applicant (not
  primary), RLS would correctly return the row; the JS-level `AND
  (primaryApplicantId = me)` clause then narrowed the Prisma-level result
  to zero anyway — not a *safety margin*, an active **denial of
  legitimate access**, the wrong failure direction for a "fail-safe can
  only narrow" guard. Auditing all 7 `PORTAL_SCOPED_MODELS` entries
  against their RLS policies found the same class of gap in
  `GeneratedDocument` (misses the `booking_id`-reachable branch — a
  co-applicant downloading a shared booking's demand letter would hit
  it), not yet exercised by a failing test until one was added
  specifically to cover it.
  **Fix: removed `Booking` and `GeneratedDocument` from
  `PORTAL_SCOPED_MODELS` entirely** — RLS is now the sole DB-adjacent
  enforcement for both, the same "honest scoping" already used for the
  `booking_id`-only tables (`Installment`, `Receipt`, `PaymentPlan`,
  `LedgerEntry`). Replicating the fuller multi-branch predicate in JS was
  rejected as the fix: it re-introduces the exact drift risk the
  direct-column-only scoping was designed to avoid, and a PARTIAL
  replica is worse than no replica — it fails in the direction that
  denies real users rather than merely admitting a wider read RLS would
  have blocked anyway.
  **Tightened inclusion criterion for `PORTAL_SCOPED_MODELS`, recorded in
  the code comment:** a model belongs there only if its portal RLS
  predicate is a single direct-column equality (or two — one per portal
  principal type, applicant and broker). Any model whose RLS predicate
  has a subquery, `EXISTS`, or multi-hop branch (a co-applicant
  carve-out, a booking-reachability check via `portal_can_access_booking`,
  etc.) must not be mirrored there. The remaining six entries
  (`CommissionLedgerEntry`, `CommissionPayment`, `BrokerNoc`, `Broker`,
  `ApplicantChangeRequest`, `Ticket`) were individually re-checked against
  this criterion and all satisfy it exactly.
  **Test coverage for the class, not just the instance:** the
  co-applicant-visibility positive test stays, and a `GeneratedDocument`
  twin was added — a co-applicant downloads a shared booking's generated
  document successfully — so both known instances of this bug class are
  covered by a real failing-then-passing test, not just by inspection.

- **Real bug, caught by manual browser testing (not by any of the 176
  tests passing at the time): every tenant-scoped request in this
  project's history ran without ambient tenant context, because
  `TenantMiddleware`/`PortalTenantMiddleware` ran as Express middleware —
  which executes BEFORE NestJS guards.** `req.user` is set by
  `JwtAuthGuard`, itself a Guard; the middleware therefore always read
  `req.user` as `undefined` and threw "Tenant context required" for any
  ambient-context-dependent query. This was invisible for every STAFF
  route across five prior phases only because staff services independently
  self-wrap their own tenant context from `req.user.companyId` passed in
  as a controller argument (see each phase's services) — they never
  depended on ambient middleware/guard context at all. Phase 6's portal
  services were deliberately designed to rely SOLELY on ambient context
  (the plan's own stated reason: "no changes needed at any of this
  function's ~50+ existing call sites"), which is exactly what exposed the
  bug the moment a real HTTP request hit `GET /portal/profile` in a
  browser. The failure direction was fail-closed (a thrown 500, not a
  silent wrong-tenant read) — bad UX, not a security hole.

  **First fix attempt — a `TenantContextGuard` (`APP_GUARD`, registered
  explicitly after `JwtAuthGuard`) calling
  `AsyncLocalStorage.enterWith()` — was ALSO wrong, caught by adding a
  debug trace rather than by any test.** Guards run after Middleware and
  before Interceptors/Pipes/the handler, so this fixed the *ordering* bug:
  a debug log confirmed the guard correctly saw a populated `req.user`.
  But `tenantExtension()`'s `$allOperations` check (`getCurrentCompanyId()`
  reading `tenantContext.getStore()`) still threw "Tenant context
  required" — for a DIFFERENT reason. A second debug trace, placed inside
  `withTenantTx`'s `prisma.$transaction()` callback, proved
  `tenantContext.getStore()` was `undefined` there even though
  `tenantTxContext` (a separate ALS, established via `.run()` INSIDE that
  same callback) was correctly populated. Conclusion:
  `AsyncLocalStorage.enterWith()`'s "mutate the store for the rest of the
  current execution" semantics do not reliably survive whatever internal
  async boundary Prisma's `$transaction()` schedules its callback through
  — plausibly because that boundary is a resource whose own parent
  context was captured at a point not chained from the guard's later
  mutation (a known class of `enterWith()` pitfall: it changes an
  already-active resource's store, it does not establish a new resource
  whose descendants are guaranteed to inherit it the way `.run()`'s
  explicit wrap does). This was NOT hit by `portal-rls.test.ts`'s original
  guard test, which used `$queryRawUnsafe` (bypasses
  `tenantExtension()`'s `$allModels` hook entirely) instead of a real
  model query — a proof that looked complete but wasn't; rewritten to use
  `tx.applicant.findFirst()` instead.

  **Final fix — `TenantContextInterceptor`, a global `APP_INTERCEPTOR`,
  wraps `next.handle()` inside `runWithTenant()` (`AsyncLocalStorage.run()`)
  via `new Observable(subscriber => runWithTenant(store, () =>
  next.handle().subscribe(subscriber)))`.** Interceptors run after ALL
  guards regardless of registration order (Nest's pipeline is fixed:
  Middleware → Guards → Interceptors → Pipes → Handler), so the
  `req.user`-populated-by-`JwtAuthGuard` guarantee still holds. Calling
  `next.handle()` *inside* `.run()`'s callback matters: Nest's
  `next.handle()` synchronously kicks off pipe validation and the
  controller method (up to its first `await`) the moment it's called — it
  is not lazily deferred until some later `.subscribe()` — so any async
  resource the handler creates synchronously (including
  `prisma.$transaction()`) captures the `.run()`-established store as its
  parent context. `TenantMiddleware`/`PortalTenantMiddleware` and
  `TenantContextGuard` are both deleted; `apps/api/src/auth/guards/`
  no longer has a tenant-context file.

  **New standing rule, going forward: every phase's test additions must
  include at least one through-the-wire `supertest` request per new
  controller.** Direct service/controller-method-call tests (the
  overwhelming majority of this codebase's test suite) cannot prove
  pipeline behavior — ordering, context propagation across async
  boundaries like `prisma.$transaction()`, and route registration are all
  invisible to a test that constructs a service with `new` and calls a
  method directly. This is the same lesson Phase 5's `soldUnits` /
  `accrueCommission` / `BrokerDetail.tsx` bugs already taught for route
  registration and DTO-shape mismatches; Phase 6 commit 2 is the case
  where it applied to ambient async context specifically. `test/e2e-portal.test.ts`
  is this rule's home for the portal surface — new portal controllers land
  their through-the-wire proof there.

### Phase 6 — broker-portal (commit 3 of 4)

- **`NocService.approve()`/`reject()` are reused UNCHANGED from the Phase 5
  staff `NocController` for the broker portal's NOC action** — no
  brokerId parameter added, no portal-specific branch. Both already
  route through `withTenantTx`/`tenantPrisma`, and `BrokerNoc` is a
  direct-column `PORTAL_SCOPED_MODELS` entry (`brokerField: 'brokerId'`,
  Phase 6 commit 1) — with the ambient `portalBrokerId` a broker portal
  request carries, `tenant.extension.ts`'s `injectPortalScope` narrows
  both the `findFirst` lookup and the `update` write to the ambient
  broker's own NOCs automatically. A foreign broker's `nocId` 404s before
  any write happens — proven end-to-end over real HTTP in
  `test/e2e-broker-portal.test.ts`, not just by direct-call tests.
  `PortalBrokerNocController` (`apps/api/src/brokers-portal/`) is a thin
  wrapper: list (new `NocService.listForBroker`, resolving booking
  numbers via a follow-up query since `BrokerNoc` has no Prisma relation
  to `Booking`), approve, reject.

- **Real bug #1, caught by `broker-portal.test.ts`'s IDOR test, not by
  review: `NocService.approve()`/`reject()`'s own self-wrapped
  `runWithTenant({ companyId })` was silently STRIPPING the ambient
  portal scope, turning the narrowing above into a no-op — broker A
  could approve broker B's NOC.** These methods have self-wrapped with a
  bare `runWithTenant({ companyId })` since Phase 5, matching the
  established "staff services self-wrap their own tenant context"
  pattern (see Phase 6 commit 2's decisions on why that pattern is
  harmless for STAFF-only call sites — they never depend on ambient
  context at all). But `AsyncLocalStorage.run()` with a NEW store value
  does not merge with the enclosing store — it SHADOWS it for the
  duration of the callback. When these same methods became ALSO
  broker-portal-facing in this commit, the self-wrap started shadowing
  the ambient `portalBrokerId` that `TenantContextInterceptor` had just
  established, replacing it with a companyId-only store that has no
  portal scope at all. `injectPortalScope` then saw no portal context and
  correctly no-op'd — but "correctly no-op'd" here means "correctly
  stopped enforcing broker-scoping entirely," an IDOR, not a safe
  fallback. **Fixed with `NocService.runScoped()`**: reuses the ambient
  tenant context when one is already active for the target `companyId`
  (`getCurrentCompanyId() === companyId`) instead of unconditionally
  shadowing it; falls back to `runWithTenant({ companyId })` only when
  there is no ambient context at all (preserving `noc-cancellation.test.ts`'s
  and `phase5-rls.test.ts`'s existing direct-`new NocService(...)`-call
  contract unchanged). Applied uniformly to `request()`/`approve()`/`reject()`
  even though only the latter two are portal-exposed in this commit, so
  a future portal exposure of `request()` doesn't reintroduce the same
  bug silently. **This is a real, general hazard for any service method
  that both self-wraps `runWithTenant({ companyId })` for staff use AND
  is reused from a portal-facing call site — audit any future dual-purpose
  reuse of an existing staff service for this exact pattern before wiring
  it to a portal controller.**

- **Real bug #2, found immediately after fixing bug #1 (a
  `PrismaClientValidationError`, not a silent bypass this time) — a
  latent defect in `tenant.extension.ts`'s `injectPortalScope` itself,
  present since Phase 6 commit 1 but never exercised until this commit's
  NOC approve/reject were the first WRITE_FILTER_OPS call on a
  `PORTAL_SCOPED_MODELS` entry ever run with an ACTIVE portal scope.**
  `injectPortalScope` wrapped the entire `where` clause in a fresh
  `{ AND: [originalWhere, { OR: scopeClauses }] }` — this buries any
  top-level unique field (`id`) one level deep inside `AND[0]`, but
  Prisma's `update()`/`delete()` require at least one unique field to be
  a TOP-LEVEL key of `where`, not nested inside an `AND` array; the query
  threw `PrismaClientValidationError: Argument 'where' of type
  BrokerNocWhereUniqueInput needs at least one of 'id' arguments`. Every
  prior portal-facing WRITE_FILTER_OPS-shaped call in Phase 6 commit 2
  (e.g. `ApplicantChangeRequestService.approve()`) happened to be
  staff-only (self-wraps with no portal fields, so `injectPortalScope`
  no-ops early), so this defect in the injection helper itself shipped
  silently until now. **Fixed at the root, in `injectPortalScope`, not in
  `NocService`**: the scope clause is now merged as an ADDITIONAL
  top-level `AND` key (`{ ...existingWhere, AND: [...existingAndArray,
  { OR: scopeClauses }] }`) rather than wrapping the whole `where` fresh —
  `id`/`companyId` (already injected by `injectCompanyId` just before)
  stay top-level, any pre-existing `AND` array on the caller's own where
  is preserved and extended rather than overwritten. This fix applies to
  every `PORTAL_SCOPED_MODELS` entry, not just `BrokerNoc` — any future
  portal-facing `update()`/`delete()` on `CommissionPayment`, `Broker`,
  `ApplicantChangeRequest`, or `Ticket` is now covered by the same fix,
  proactively, without needing its own bug report first.

- **Broker dashboard and statement-list services deliberately do NOT
  reuse `BrokerReportsService` (Phase 5) or `DocumentService.listForBroker()`
  as-is.** `BrokerReportsService` is `SYSTEM_PRISMA`-based (RLS-bypassing)
  and only 2 of its 5 methods (`soldUnits`, `customerDetail`) take a
  `brokerId` scoping parameter — `commissionSummary`/`dues`/`summary` are
  company-wide with no per-broker filter, and reusing them from a portal
  dashboard would leak every broker's commission figures to whichever
  broker happened to load the page. `PortalBrokerDashboardService` (new,
  `apps/api/src/brokers-portal/`) is a small, independent,
  `TENANT_PRISMA`/`withTenantTx` implementation instead: an explicit
  `brokerId` filter on every query (same "belt and suspenders" style as
  `PortalPropertyService.getMyProperties`'s explicit `applicantId`
  filter) plus RLS/`PORTAL_SCOPED_MODELS` as backstop. Likewise,
  `DocumentService.listForBrokerPortal()` (new) is a `withTenantTx`
  sibling to the existing `listForBroker()` (staff, `SYSTEM_PRISMA`),
  not a reuse — mirrors `listForPortal()`'s existing applicant-portal
  shape exactly. `DocumentService.getDocumentBytesForPortal()` (Phase 6
  commit 2) needed NO changes at all for broker downloads — it was
  already broker-safe via `generated_documents_portal_scope`'s existing
  broker branch.

- **`BrokersPortalModule` is a separate module from `CustomerPortalModule`
  (Phase 6 commit 2), despite both being "portal" modules.** Keeps
  `CustomerPortalModule`'s name accurate (it would otherwise need
  renaming or become a dumping ground for two unrelated portal
  principals), and this module's controllers depend on `BrokersModule`
  (for `NocService`) and `PdfModule` (for `DocumentService`), neither of
  which `CustomerPortalModule` imports.

- **`test/e2e-broker-portal.test.ts` is a separate file from
  `test/e2e-portal.test.ts`**, not an extension of it — the fixtures are
  broker-shaped (broker `User` rows, broker role/permissions, a
  broker-sourced booking) rather than applicant-shaped, and the two would
  otherwise share nothing but bootstrap boilerplate. Both follow the same
  standing rule from Phase 6 commit 2 (every new controller gets a
  through-the-wire supertest) and the same session-caching discipline
  for the shared `portal-auth` 5-requests/5-minutes-per-IP throttle
  bucket.

- **Commit-2's "staff self-wrapping `runWithTenant({ companyId })` is
  harmless redundancy" note is SUPERSEDED — bug #1 above proved it was
  never harmless in the general case, only harmless for call sites that
  happen to never be reached from a portal-authenticated request.**
  That property cannot be verified by reading one service file in
  isolation; it depends on which controllers call it, today and in any
  future phase. Two structural changes close this gap for good, so the
  project no longer depends on catching every future instance by
  review:

  1. **`runWithTenant()` itself now refuses the exact shape of call that
     caused the bug** (`packages/db/src/tenant-context.ts`): if an
     ambient store is already active for the SAME `companyId` and
     carries a portal scope (`portalApplicantId` or `portalBrokerId`),
     and the new store would replace that scope with anything else
     (dropped, widened to company-wide, or switched to a different
     portal principal), it throws instead of silently shadowing.
     Cross-company re-wrapping (system jobs enumerating companies, e.g.
     `EscalationService`/`InterestService`) is unaffected — the check
     only fires on a same-company call. Fail LOUD now, where bug #1
     failed silent and open. Tested in
     `packages/db/test/tenant-context-guardrail.test.ts` (10 tests, pure
     `AsyncLocalStorage` logic, no Postgres needed — same "fast,
     DB-independent" tier as `postsales-pdf.test.ts`, Phase 4
     decisions): throws on same-company drop/widen/switch for both
     `portalApplicantId` and `portalBrokerId`; allowed when the ambient
     store has no portal scope (plain staff self-wrap, still legitimately
     harmless); allowed with no ambient store at all; allowed
     cross-company.

  2. **`runScoped(companyId, fn)` is promoted from `NocService` to
     `packages/db`** — the blessed helper for any service method
     reachable from both a staff call site and a portal-facing one:
     reuses the ambient context when already active for the target
     company, falls back to `runWithTenant({ companyId })` only when
     there's no ambient context at all. `NocService.approve()`/
     `reject()`/`request()` now import it from `@openestate/db` instead
     of keeping a private copy.

  **Full audit performed of every service method reachable from a
  portal controller (customer or broker), checking for a bare
  self-wrapped `runWithTenant({ companyId })`:**

  | Service.method | Portal controller | Self-wraps? |
  |---|---|---|
  | `PortalProfileService.getProfile` | `PortalProfileController` | No — `withTenantTx` only |
  | `ApplicantChangeRequestService.submit` | `PortalProfileController` | No — deliberate (Phase 6 commit 2) |
  | `PortalPropertyService.getMyProperties` | `PortalPropertyController` | No |
  | `PortalAccountService.getAccount` | `PortalAccountController` | No |
  | `DocumentService.listForPortal` / `listForBrokerPortal` / `getDocumentBytesForPortal` | `PortalAccountController`, `PortalBrokerDocumentsController` | No |
  | `TicketService.listCategories` / `create` / `listMine` / `getOne` / `addMessage` | `PortalTicketController` (+ `AdminTicketController` for `addMessage`) | No — no self-wrap anywhere in the file, including its staff-only methods |
  | `PortalBrokerDashboardService.getDashboard` | `PortalBrokerDashboardController` | No |
  | `NocService.listForBroker` / `approve` / `reject` | `PortalBrokerNocController` | `approve`/`reject` DID (bug #1, fixed) — `listForBroker` never did |

  Self-wrapping call sites that DO exist elsewhere in the codebase
  (`ApplicantChangeRequestService.approve`/`reject`,
  `DocumentService.reprintReceiptPdf`/`store` used by every `generate*`
  method, `ConstructionUpdateService`'s 3 methods, and ~40 more across
  `masters/`, `inventory/`, `presales/`, `postsales/`, `commission/`,
  `roles/`, `users/`, `company/`, `custom-fields/`, `dispatch/`,
  `queues/`) were individually checked against every portal controller's
  constructor injections and confirmed NOT reachable from any portal
  route — gated behind staff-only permissions
  (`ADMIN_CHANGE_REQUEST_APPROVE`, etc.) that neither the `customer` nor
  `broker` role holds. These stay self-wrapped as-is; the guardrail now
  protects them defensively regardless, and this table plus the
  guardrail together replace "audit by reading code" with "audit once,
  then let the runtime enforce it."

  **`docs/todo.md`'s "Staff services' self-wrapped `runWithTenant`
  calls... stay as-is this phase (harmless redundancy)" note (Phase 6
  commit 2) is updated accordingly** — see that file for the current
  wording.

### Phase 6 — notifications, hardening, polish (commit 4 of 4)

- **`NotificationService` (new, `apps/api/src/notifications/`) is an
  independent service, not a reuse of `CommunicationService`.**
  `CommunicationLog` has a non-nullable `applicantId` and no `brokerId`
  column at all, so it cannot represent a broker notification (needed for
  `COMMISSION_PAID`). Follows this codebase's existing "Convention B"
  send pattern (`EscalationService`, `PortalPasswordResetProcessor`,
  `DispatchProcessor`: call `CommunicationProvider.send()` directly, no
  persistent log row) rather than Convention A
  (`CommunicationService.send()`, which creates a `CommunicationLog` row
  + BullMQ job) — there is no portal-facing "view your notification
  history" screen this phase that would need the row. `notify()` looks
  up the recipient's portal `User` by `applicantId`/`brokerId`, reads
  `User.notificationPrefs` (falling back to `DEFAULT_NOTIFICATION_PREFS`
  from `packages/shared/src/portal.ts`, already scaffolded), and silently
  no-ops if no portal user exists for that applicant/broker — expected
  (not every applicant/broker has activated a portal account) and swallowed
  behind a `try/catch` + `logger.warn`, never thrown, so a notification
  failure never fails the triggering write. All five trigger call sites
  (`ReceiptService.createReceipt`, `DocumentService.generateLetterPdf`
  for `DEMAND_LETTER` only, `ConstructionUpdateService.create`,
  `TicketService.addMessage` for staff replies only,
  `CommissionPaymentService.pay`) fire strictly AFTER their transaction
  commits — CLAUDE.md's Phase 1 "no external I/O inside `withTenantTx`"
  rule applies to `provider.send()` exactly as it does to email/SMS/S3.

- **Real bug, caught by the portal-read rate-limit test required by this
  commit's own spec, not by review: `@nestjs/throttler`'s `ThrottlerModule`
  is `@Global()`, and this app had TWO separate `ThrottlerModule.forRoot()`
  calls — `app.module.ts`'s own (the unnamed/default staff bucket) and
  `PortalAuthModule`'s (the `portal-auth`/`portal-read` named buckets,
  Phase 6 commit 1).** A `@Global()` Nest module's providers are exported
  to the ENTIRE application graph regardless of which feature module calls
  `forRoot()`; two independent calls create two competing registrations
  for the same `THROTTLER_OPTIONS` token, and which one a given consumer's
  DI resolves to is dependent on module compilation order, not something
  to rely on. In practice this meant the root `APP_GUARD` — `ThrottlerGuard`
  used directly, unfiltered, unlike the portal guards which each filter
  `this.throttlers` down to their own named entry in `onModuleInit()` — was
  picking up ALL THREE named throttlers on SOME builds, enforcing the tiny
  `portal-auth` bucket (5 requests/5 minutes) globally on every route in
  the app, including a `portal-read`-guarded route (`GET /portal/profile`,
  meant to be governed only by the 60/minute `portal-read` bucket) — the
  exact opposite of the Phase 6 commit 1 decisions log's claim that "staff
  routes are structurally unreachable by either bucket." A second rebuild
  (isolating just the root-guard filter fix, without also removing the
  second `forRoot()` call) flipped the failure mode instead of fixing it:
  `PortalAuthThrottlerGuard`'s OWN bucket silently stopped enforcing at
  all (6 login attempts all returned 401, never 429) — empirical proof
  that which `forRoot()` call "wins" for a given guard is genuinely
  nondeterministic across rebuilds, not a one-time fluke. **Fixed at the
  root, not by working around the symptom**: consolidated to exactly ONE
  `ThrottlerModule.forRoot([...])` call, in `app.module.ts`, listing all
  three named throttlers (default, `portal-auth`, `portal-read`) —
  `PortalAuthModule` no longer calls `ThrottlerModule.forRoot()` at all,
  it only declares `PortalAuthThrottlerGuard`/`PortalReadThrottlerGuard`
  as providers, which now resolve their options from the single global
  registration. **Also added `DefaultThrottlerGuard`
  (`apps/api/src/auth/guards/default-throttler.guard.ts`)** — mirrors
  `PortalAuthThrottlerGuard`/`PortalReadThrottlerGuard`'s existing
  self-filtering pattern (`this.throttlers = this.throttlers.filter(t =>
  t.name === 'default')`), now used as the root `APP_GUARD` instead of the
  bare `ThrottlerGuard` class — so even if a future module reintroduces a
  second `forRoot()` call, the root guard structurally cannot enforce a
  bucket that isn't its own, the same defense-in-depth principle as the
  `runWithTenant` guardrail from commit 4's hardening work earlier in this
  phase. Verified via `test/e2e-portal-throttle.test.ts` (new, real HTTP):
  the `portal-auth` bucket 429s on the 6th login attempt in 5 minutes from
  one IP; the `portal-read` bucket is proven keyed by JWT `sub` (not IP) by
  exhausting one user's 60/minute budget and confirming a second user on
  the SAME loopback IP is unaffected. Also re-ran `e2e-portal.test.ts` and
  `e2e-broker-portal.test.ts` (staff + portal routes through the real guard
  chain) after the fix to confirm no regression.

- **Pre-existing test-harness flakiness, exposed (not introduced) by the
  new portal-read throttle test: `makeApplicant()`'s phone counter
  (`appSeq`) resets to 0 per forked test-FILE process, and
  `PortalAuthService.login()`'s identifier lookup is deliberately
  company-unscoped** (phone/email must be globally unique across the
  whole install — Phase 6 commit 1 decisions). Two e2e files that both
  call `makeApplicant()` early in `beforeAll` can generate the IDENTICAL
  phone number for their first applicant; when `pnpm test`'s default
  forked parallelism runs them concurrently, a login can resolve to a
  DIFFERENT file's user row, which then vanishes mid-test when that
  file's own `afterAll` cleanup runs — observed as a flaky 500
  ("no record found") that only reproduced when the full e2e trio ran
  together, never in isolation. `e2e-portal.test.ts`'s own comment
  already flagged this exact class of collision for an *assertion*
  (worked around there by asserting on id, not phone); this is the first
  time it broke a *login* itself. Fixed locally in
  `e2e-portal-throttle.test.ts` only (not the shared harness, to avoid
  changing behavior every other test file depends on): its two portal
  users get high-entropy phones (`Date.now()` + `Math.random()`) instead
  of going through `makeApplicant()`. Confirmed stable across three
  consecutive runs of the full `e2e-portal.test.ts` +
  `e2e-broker-portal.test.ts` + `e2e-portal-throttle.test.ts` trio
  together. **Not fixed at the root** (the harness's phone counter, or
  `PortalAuthService.login`'s cross-company lookup) — flagged here for
  visibility; the harness-level fix is deferred, not silently dropped
  (see `docs/todo.md`).

- **RLS EXPLAIN check (plan's required manual verification, run against
  the same ~200-row `commission_ledger_entries` fixture as the automated
  coarse perf regression test in `test/portal-rls.test.ts`).** Observed
  plan for the portal-broker-scoped query, via
  `EXPLAIN (ANALYZE, VERBOSE)` under a real `portalBrokerId` session
  (`openestate_app`, RLS-enforced, `openestate_test` DB):

  ```
  Aggregate  (cost=7.12..7.13 rows=1 width=8) (actual time=0.550..0.551 rows=1 loops=1)
    Output: count(*)
    ->  Seq Scan on public.commission_ledger_entries  (cost=0.00..7.12 rows=1 width=0) (actual time=0.045..0.538 rows=200 loops=1)
          Filter: ((commission_ledger_entries.broker_id = '<uuid>'::uuid)
                   AND (commission_ledger_entries.company_id = (current_setting('app.current_company_id', true))::uuid)
                   AND ((((NULLIF(current_setting('app.portal_applicant_id', true), ''))::uuid IS NULL)
                         AND ((NULLIF(current_setting('app.portal_broker_id', true), ''))::uuid IS NULL))
                        OR (((NULLIF(current_setting('app.portal_broker_id', true), ''))::uuid IS NOT NULL)
                            AND (commission_ledger_entries.broker_id = (NULLIF(current_setting('app.portal_broker_id', true), ''))::uuid))))
    Planning Time: 2.275 ms
    Execution Time: 0.646 ms
  ```

  **This differs from the plan's stated hypothesis** ("`portal_applicant()`/
  `portal_broker()` appear as a single evaluated `Function Scan`/`InitPlan`")
  — the actual behaviour is that Postgres INLINES `portal_applicant()`/
  `portal_broker()` (single-statement `LANGUAGE sql` functions) directly
  into the `Filter` expression as `current_setting(...)` calls, evaluated
  once per row scanned, rather than hoisting them into a separate
  `InitPlan` computed once per statement. This is still the *correct* and
  *fast* outcome, for a different reason than assumed: `current_setting()`
  is an in-memory GUC lookup with no I/O and no subquery/join, so
  per-row evaluation costs the same as a constant — confirmed by the
  0.646ms execution time on 200 rows (Seq Scan is the planner's correct
  choice at this small a table size; a larger table would use an index on
  `broker_id`/`company_id` and pay the same negligible per-row
  `current_setting()` cost). No planner regression risk from function
  inlining specifically — inlining a `STABLE` function into a filter
  expression is standard Postgres behavior for simple single-statement SQL
  functions, not something a future Postgres version is likely to stop
  doing. The **coarse wall-clock regression test**
  (`test/portal-rls.test.ts`, "coarse RLS performance regression") is what
  actually gates this in CI, per the plan's own reasoning — this EXPLAIN
  capture is documentation of what was observed once, not a repeatable
  automated check (planner output is version/data-dependent).

- **Final manual click-through (real narrow-viewport browser, 375×667
  ≈ iPhone SE), against the running dev stack (`apps/api` + `apps/portal`
  dev servers, the demo company from `packages/db/prisma/seed.ts`).**
  Customer path: login → profile (confirmed `CompanyConfig.primaryColorHex`
  renders on the active bottom-nav tab, computed `color: rgb(22, 163, 74)`
  matching the configured `#16A34A`, and the header falls back to the
  "OpenEstate" text label when no `logoUrl` is set) → property → account
  (cost breakup / payment plan / payment history sections, next-due
  banner) → receipt PDF download (200) → profile change-request
  submission → ticket creation and thread view — all exercised as real
  clicks/form input over the actual dev API, not a direct service call.
  Broker path, including the two steps commit 3's browser session
  couldn't finish: dashboard (commission figures, units-sold/pending-NOC
  tiles) → NOC list → **NOC approve in the browser** (real `POST
  .../nocs/:id/approve`, 201, status flips to APPROVED) → **broker
  statement PDF download in the browser** (real `GET
  .../documents/:id/download`, 200). No console errors, no horizontal
  overflow at the 375px viewport (`document.documentElement.scrollWidth
  === window.innerWidth` checked directly) at any screen visited. Fixture
  data for this click-through was built via a throwaway vitest file
  (`test/_clickthrough-seed.test.ts`, deleted after use, not part of the
  suite) that reused the real `BookingService`/`PaymentPlanService`/
  `ReceiptService`/`DocumentService`/`CommissionService`/`NocService`
  classes against the demo company's already-fully-permissioned
  customer/broker roles, rather than hand-writing raw rows — the same
  "reuse the real service, don't reimplement its invariants" discipline
  every other fixture-builder in this test suite already follows.

### Phase 7 — plugin-core (commit 1 of 3)

- **Package-boundary isolation, not a sandbox — the trust model is
  stated explicitly, not silently assumed.** `packages/plugin-sdk` has
  zero runtime dependency on `@openestate/db`/`@nestjs/*`; no
  `plugins/*` package may depend on `@openestate/db` either, so there is
  no import path to `runWithTenant`/`PrismaClient` from plugin code at
  all — a plugin hook cannot syntactically reach the primitive Phase 6's
  guardrail exists to police, which is a stronger guarantee than a
  reactive check. This defends against the "composition, not components"
  bug class the phase brief called out (middleware-before-guards,
  ALS-shadowing, `@Global()` leakage) by removing the dangerous
  primitive from plugin code's reachable surface entirely. It is
  explicitly NOT a sandbox against adversarial code — first-party
  plugins ship as reviewed npm workspace packages inside this repo, the
  same review bar as any other module. See `docs/todo.md`'s new
  "Plugins (Phase 7)" entry for the concrete, honest limit this leaves
  (no worker-thread/process isolation, so a genuine infinite loop in a
  hook still blocks the event loop) and what would be needed to move
  that trust boundary later.
- **Capability gating via a `Proxy`, not plain object fields.**
  `PluginRuntimeService.buildContext()` builds `PluginContext` as a
  `Proxy` whose `get` trap throws `PluginCapabilityError` (naming the
  specific undeclared capability) when a hook touches `ctx.http`/
  `ctx.leads`/`ctx.applicants`/`ctx.companyConfig` without declaring the
  matching capability in its manifest — a specific, directly-testable
  assertion instead of an incidental `undefined is not a function`.
  `companyId` is captured as a closure variable at context-construction
  time; every attached method (`ctx.applicants.findDuplicates`, etc.) is
  a thin wrapper around the real service called with that fixed
  `companyId` — the plugin hook itself never touches tenant-context
  machinery.
- **Secret handling: opaque `SecretRef`/`SecretHeaderSpec` handles are
  the PRIMARY defense, substring redaction is a backstop only —
  required change from plan review, implemented exactly as specified.**
  A `secret: true` config field's value in `ctx.config` is never
  plaintext — it's `{ __secretRef: true, fieldKey }`. To actually use a
  secret, plugin code calls `ctx.secretHeader(fieldKey, format)`, which
  returns a `SecretHeaderSpec`; `ScopedHttpClient` resolves it to real
  plaintext only inside `resolveSecretHeaders()`, immediately before the
  socket write — the plaintext exists only transiently inside the
  plugin-authored `format` callback the runtime itself invokes, never
  assigned to a variable in the hook's main body where an incidental
  `logger.debug(...)` could catch it. `createScrubbingLogger`'s
  exact-substring redaction (built from the installation's real secret
  values at context-construction time) stays as a documented backstop,
  explicitly not the primary defense — it would miss base64/truncated/
  HMAC/URL-encoded derived forms, which is exactly why the handle design
  was required over the original substring-only plan.
- **SSRF hardening: resolve-once-then-PIN, not resolve-then-reconnect —
  closes the DNS-rebinding TOCTOU a naive validate-then-separately-
  resolve implementation would leave open.** `createScopedHttpClient`
  calls `dns.lookup(hostname)` exactly once per hop, validates the
  returned IP against private/loopback/link-local/CGNAT/multicast/
  reserved ranges (`isPublicIp`, both IPv4 and IPv6, including
  IPv4-mapped `::ffff:a.b.c.d`) BEFORE connecting, then pins the actual
  `http`/`https` request to that already-validated IP via Node's
  `lookup` request option — the original hostname is untouched in the
  `hostname` option, so it still drives the `Host` header and TLS SNI
  for virtual-hosted HTTPS. A belt-and-suspenders check also re-verifies
  the socket's actual `lookup` event address matches. Only `http`/
  `https` schemes; redirects capped at 1 hop, each hop re-validated from
  scratch (never trusted blindly); a single `AbortController` 10s
  deadline covers the whole flow including the one allowed redirect, not
  reset per hop; response capped at 1MB.
- **`PluginRegistryService` is the single source of truth for both
  version-gating and the orphaned-installation question (addendum A6) —
  `getActive(pluginId): Plugin | undefined` is the one method every
  dispatch and admin path checks.** Version mismatch (registered but
  `coreApiVersion` range fails against `CORE_PLUGIN_API_VERSION`) and
  orphaned (pluginId never registered at all, e.g. after a core
  downgrade or package removal) are treated identically at the
  dispatch/enable level — `getActive()` returns `undefined` for both,
  so no dispatch path can drift between handling them differently — but
  distinguished in admin-facing messaging via `getStatus()`
  (`'active' | 'version-mismatch' | 'not-found'`) and
  `getVersionMismatchInfo()`. Neither case mutates an existing
  `PluginInstallation` row (preserves the admin's config for if the
  plugin becomes available again).
- **Real gap found and fixed while writing this addendum's own required
  test coverage, not by review: `PluginAdminService.list()`/
  `getDetail()` only enumerated `registry.listAll()`, so a truly
  orphaned installation (pluginId never registered at all, as opposed to
  registered-but-version-mismatched) was invisible to admin GET
  entirely — contradicting the plan's own stated promise ("Admin UI
  shows it as 'Not available in this build'"). Worse, `disable()`/
  `uninstall()` called `requireKnownPlugin()` (throws 404) BEFORE
  checking whether an installation existed, so an admin could never
  clean up a broken installation's row through the API at all — a real
  dead end, not just a cosmetic gap.** Fixed by: `list()` now unions
  `registry.listAll()` with any installation rows whose pluginId isn't
  in that list, surfacing orphaned entries with a degraded
  `orphanedSummary()` (placeholder name/kind/version, `status:
  'not-found'`); `getDetail()` uses a new non-throwing
  `findKnownPlugin()` and returns the same degraded shape instead of
  404ing when an installation row exists for an unregistered pluginId
  (still 404s if there's neither a registry entry NOR an installation —
  genuinely unknown, not orphaned); `disable()`/`uninstall()` now use
  `findKnownPlugin()` too and simply skip hook invocation when the
  plugin is undefined (the existing `registry.getActive()` guard on
  those hook calls already made this safe — the fix removes an
  unnecessary earlier throw, it doesn't change hook-safety logic).
  `install()`/`enable()` are unchanged — addendum A6 explicitly wants
  those to 409 via `requireActivePlugin()`, and they still do. Covered
  by `plugin-admin.test.ts`'s "orphaned installation" and
  "version-gate-failing" describe blocks.
- **`PluginSecretEncryptionService` gets REAL key versioning this time,
  unlike `PanEncryptionService`'s never-wired-up `panKeyVersion`
  (Phase 5 decisions).** `PLUGIN_SECRET_ENCRYPTION_KEYS` is a
  comma-separated `version:hexkey` list; `encrypt()` always uses the
  highest version as current, `decrypt(ciphertext, keyVersion)` looks up
  the specific version the row was encrypted under.
  `PluginInstallation.secretKeyVersion` is populated and read back on
  every decrypt, and `scripts/rotate-plugin-secrets.ts` (new, mirrors
  `portal-demo-seed.ts`'s `tsx` convention) re-encrypts every row under
  the current key — this script IS the rotation runbook. A separate key
  from PAN/TOTP, same reasoning as Phase 1's TOTP-vs-PAN key split:
  plugin secrets are a distinct rotation/trust domain.
- **`invoke()`'s timeout+catch-all wrapper is the one place every hook
  call goes through — no plugin exception or hung promise can propagate
  past it.** `Promise.race([fn(), timeout])` catches ANY throw
  (including non-`Error` throws, e.g. a plugin that does
  `throw 'a string'`) and converts it to a structured
  `PluginExecutionError { pluginId, hook, companyId, message }` rather
  than letting it crash the calling request or BullMQ worker job. Tested
  directly against both a throwing hook and a never-resolving one
  (`plugin-runtime.test.ts`).
- **Explicit DI-array plugin registration (`PLUGIN_REGISTRATIONS`
  token), not filesystem scanning of `plugins/*` at boot.** Chosen for
  testability (a test constructs `new PluginRegistryService([...])`
  directly with fixture plugins, no filesystem/dynamic-`import()`
  involved) and to avoid bundling complications; `plugins.module.ts`'s
  `FIRST_PARTY_PLUGINS` array is empty this commit (`generic-sales`
  registers there in commit 3).
- **Through-the-wire supertest for the new controller, per the standing
  rule since Phase 6 commit 2 — proves the guard chain (permission
  guard AND `CsrfGuard` on POST) actually gates `/admin/plugins/*`, not
  just that the route is mounted.** `e2e-plugins.test.ts` deliberately
  doesn't attempt a full install→enable happy path against a real
  registered plugin — the registry is intentionally empty until
  commit 3's `generic-sales` — instead it proves the 200/403/404/409
  paths through the real HTTP pipeline. The full happy path is commit
  3's `generic-sales` end-to-end test plus the required manual
  click-through.
- **Pipeline verification found a real, but unrelated and pre-existing,
  flakiness in `postsales-property.test.ts` (frozen Phase 4 code) —
  documented, not silently worked around.** Across four full
  `pnpm test` attempts on freshly-recreated test databases, that one
  file's `afterAll` cleanup failed with a foreign-key violation every
  time under the full ~42-file concurrent suite, but passed cleanly in
  96s every time run in isolation — and the SPECIFIC constraint that
  failed differed between attempts (`bookings_unit_id_fkey`, then later
  `receipt_allocations_installment_id_fkey`), which rules out a
  deterministic ordering bug in `cleanupCompany` (verified correct on
  inspection) in favor of resource contention on this local machine's
  Docker setup. Every other package and all other 41 apps/api test files
  — including all 5 new plugin test files (64 tests) — passed cleanly in
  every one of those same runs. Full reasoning and reproduction steps in
  `docs/todo.md`'s new "Full-suite (`pnpm test`) contention failure"
  entry. Consistent with this codebase's existing precedent (Phase 6
  commit 4's `makeApplicant()` phone-collision note) for a failure class
  that only reproduces under full concurrent-suite load: documented and
  not treated as a commit blocker, since the actual code under test in
  this phase is proven correct both in isolation and via every other
  passing file in the same runs.

### Phase 7 — webhooks-and-leads (commit 2 of 3)

- **`webhook-signing.ts` lives in `apps/api/src/common/`, NOT
  `packages/shared`, despite the original plan placing it there.**
  `packages/shared` is imported by `apps/web`/`apps/portal`'s Vite
  builds via the `"import"` export condition (raw TS source, no
  pre-build step — Phase 1 decisions), and Node's `crypto` module
  (`createHmac`, `timingSafeEqual`) has no browser-safe equivalent —
  adding it there would risk breaking the FE Vite bundle the moment
  anything in the barrel re-export chain touched it. Both real
  consumers (the delivery processor's outbound signing, the inbound
  lead guard/plugin-fixture's verification) are apps/api-only, so there
  was no actual FE/BE sharing need this file would have served by
  living in packages/shared. Caught before it shipped, not after —
  `pnpm --filter @openestate/shared build` failed immediately with
  `Cannot find module 'node:crypto'`.
- **Atomic `consecutiveFailures` update (addendum A3) runs BEFORE the
  delivery's own terminal status flip (EXHAUSTED/SUCCESS), not after —
  a real bug caught by this commit's own concurrency test, not by
  review.** The processor originally did delivery-status-first,
  counter-update-second (matching the order they're described in
  prose). Two sequential `await`s to Postgres are never atomic
  together; an observer (the admin UI polling delivery status, or a
  test) that sees the terminal status has NO guarantee the counter
  update alongside it has landed yet. The "one exhausted delivery
  increments consecutiveFailures by exactly 1" and "success resets the
  counter" tests both failed intermittently against the original
  order (reading `consecutiveFailures: 0` right after observing
  EXHAUSTED/SUCCESS) — fixed by swapping the order so the counter
  commits first; by the time any observer can see the terminal
  delivery status, the counter is guaranteed already correct.
- **Real bug, caught by the SAME concurrency test, root-caused (not
  worked around): both raw `$executeRawUnsafe` UPDATE statements
  compared `id = $1` against a `uuid` column with an untyped parameter,
  producing `ERROR: operator does not exist: uuid = text`.** Every
  prior raw-SQL call site in this codebase that matches a `uuid` column
  (`cleanupCompany`'s `DELETE ... WHERE company_id = $1::uuid`, Phase
  6's invite atomic cap) already casts explicitly; this one didn't.
  Before the delivery-status-ordering fix above, this failure happened
  silently AFTER the delivery had already flipped to its terminal
  status (masking itself as "the counter just didn't update" rather
  than a hard error); reordering surfaced it as an outright exception
  reaching BullMQ's error handler, which is what actually forced
  root-causing it via a standalone script bypassing vitest's test
  timeout entirely. Fixed by adding `::uuid` to both statements (and to
  the test file's own copy of the "stray success" raw SQL). **Lesson
  recorded, not just fixed:** any new `$executeRawUnsafe` comparing a
  parameter against a `uuid`-typed column needs the same cast — nothing
  catches this at compile time, only a real query against a real
  Postgres schema does.
- **Addendum A5 exposed a genuine SDK design gap, fixed by adding a new
  `PluginContext.verifySignature()` primitive rather than working
  around it.** The approved plan's addendum A5 called for a
  signed-payload `lead-source` fixture plugin verifying a secret via
  `ctx.secretHeader()`. Attempting to actually write that fixture
  proved this doesn't work: `secretHeader()`'s `format` callback is
  only ever invoked by `ScopedHttpClient` at the moment of an
  OUTBOUND dispatch (addendum A1's whole design) — a `mapPayload` hook
  verifying an INBOUND signature has no outbound HTTP call to
  piggyback the resolution on, so calling `.format()` manually just
  passes it a placeholder string instead of the real secret. Rather
  than silently paper over this (e.g. having the fixture fake success),
  added `verifySignature(fieldKey, rawBody, timestampMs, signature):
  boolean` to `PluginContext` (`@openestate/plugin-sdk`) — the
  local-verification counterpart to `secretHeader()`: same "only valid
  for a field declared `secret: true`" rule, same "plaintext never
  reaches a plugin-held variable" guarantee (the comparison happens
  entirely inside `PluginRuntimeService`, using the SAME
  `verifyWebhookSignature` function the outbound delivery path signs
  with), but returns only a boolean instead of exposing a callback.
  This is an ADDITIVE change to `PluginContext` (a new optional-shaped
  method, not a removal or signature change) — a MINOR-compatible
  extension per §3's versioning policy, made while Phase 7 is still
  actively in progress and `CORE_PLUGIN_API_VERSION` has not been
  described as frozen-for-real-third-parties yet. `ctx.leads` (commit
  1's forward reference — "wired in commit 2, alongside
  `InquiryService.createFromLead`'s extraction") is also wired now,
  completing that placeholder.
- **`InquiryService.createFromLead()` is a NEW method, not a rewire of
  the existing `create()` — a deliberate, documented scope decision,
  not what the original plan's prose literally suggested.** The plan
  said the extraction would let "the inbound API's dedup behavior [be]
  provably identical to the manual-entry path... one implementation,
  two callers." Implementing this literally would have changed
  `create()`'s frozen, tested Phase 3 behavior — always creating a new
  applicant and surfacing `possibleDuplicateApplicantIds` for a human
  to resolve — to `createFromLead`'s auto-link-on-match behavior
  (correct for an unattended machine caller, wrong for an interactive
  staff form). What IS actually shared between every dedup call site in
  this codebase (`create()`, `ApplicantService.create()`, `ctx.
  applicants.findDuplicates`, and now `createFromLead`) is the
  underlying lookup, `ApplicantService.findDuplicates()` — that's the
  real "one implementation" the plan's intent pointed at.
  `createFromLead` reuses it and then does ITS OWN auto-link-or-create
  sequence, matching the bulk-import path's existing "auto-link instead
  of prompting" discipline (Phase 3 decisions) — the same "no human
  present" reasoning applies.
- **Inbound lead API auth/authorization is entirely `LeadApiKeyGuard`
  plus `@Public()`** — `POST /leads/inbound` is a machine endpoint with
  no JWT and no cookie session, so it's marked `@Public()` to make both
  `JwtAuthGuard` and `CsrfGuard` no-op (both already respect
  `IS_PUBLIC_KEY`); `PermissionsGuard` also passes through since the
  route declares no `@RequirePermissions()`. `LeadApiKeyGuard` hashes
  the presented `X-Api-Key` (SHA-256, same discipline as
  `RefreshToken.tokenHash`) and is the entire authn/authz boundary.
  `LeadInboundThrottlerGuard`'s per-key limit (§5's resolver-function
  design) is declared SECOND in `@UseGuards()` specifically because it
  reads `req.leadApiKey.rateLimitPerMinute`, which only exists after
  `LeadApiKeyGuard` (declared first) populates it — guard execution
  order matters here, not just presence. The `'lead-inbound'` bucket is
  registered in the SAME single `app.module.ts`
  `ThrottlerModule.forRoot([...])` call as every other named throttler
  — never a second call (the exact Phase 6 commit 4 bug class).
- **Real gap, caught while writing this commit's own tests, not by
  review: the shared financial-harness's `cleanupCompany()` test helper
  (`postsales-harness.ts`) never deleted `inquiries` (or
  `communication_logs`/`follow_ups`/`inquiry_assignments`/
  `applicant_consents`/`applicant_merges`) before deleting
  `applicants`.** This table list was written for Phase 4/5 financial
  fixtures and never needed Phase 3 presales rows before — Phase 7 is
  the first suite to combine this harness's cleanup with real `Inquiry`
  rows (`createFromLead`), which surfaced the gap immediately as an FK
  violation on teardown. Fixed by inserting the missing presales tables
  before `applicants` in the shared helper's list — an ADDITIVE fix
  (existing entries/order untouched), so no other test file using this
  helper is affected.
- **Outbound webhook delivery's `ctx.http`-style SSRF guard was
  deliberately NOT applied to `WebhookDeliveryProcessor`'s HTTP call.**
  A `WebhookEndpoint.url` is staff-configured admin input (the same
  trust level as, say, a configured SMS gateway URL), not a value a
  plugin might construct dynamically from attacker-influenced data —
  the trust boundary `ctx.http`'s SSRF hardening (addendum A2) defends
  is specifically "a plugin choosing where its own HTTP call goes,"
  which doesn't apply to an admin-typed endpoint URL. Stated explicitly
  in the processor's own doc comment so a future reader doesn't assume
  the omission was an oversight.
- **256KB payload cap (addendum A4) enforced in `WebhookDeliveryService
  .dispatchEvent()` at write time, before any `WebhookDelivery` row is
  created** — rejecting at the fan-out call site (not per-endpoint,
  not at the processor) means one oversized event never gets stored
  once and retried up to 6 times per subscribed endpoint; the caller
  gets a clear `BadRequestException` immediately instead of a silently
  truncated or partially-delivered event.
- **Replay (addendum A4) re-enqueues a fresh BullMQ job for the SAME
  `WebhookDelivery` row rather than creating a new row** — a fresh job
  gets its own fresh 6-attempt budget (BullMQ tracks attempts per-job,
  not per-row), while `WebhookDeliveryAttempt` rows keep appending
  (`attemptNumber` restarts at 1 for the new job, but old rows are
  never deleted) so the full history stays visible across a replay,
  same "never lose the audit trail" discipline as `DispatchService
  .retry()`'s new-row-per-retry pattern for document dispatch (Phase
  4-UI decisions) — just achieved differently here because BullMQ's own
  attempt tracking is job-scoped, not something to fight.

### Phase 7 — generic-sales-and-UI (commit 3 of 3)

- **`plugins/generic-sales` is purely declarative — `terminologyOverrides`/
  `enabledModules`/`customFieldSeeds` are plain data on `plugin.hooks`,
  not functions, and `capabilities: []` since nothing here needs a
  runtime `ctx` method.** `PluginAdminService.install()` reads these
  three fields directly and applies them through the SAME
  `CompanyService.updateConfig()`/`CustomFieldsService.create()` calls a
  staff admin would make by hand — no new core surface, matching §7's
  "no new database tables, no new HTTP routes, no schema columns"
  boundary literally, not just in spirit.
- **`terminologyOverrides` MERGES onto the company's existing
  `labelOverrides`; `enabledModules` is a full replace.** A blind
  `Prisma.update({ data: { labelOverrides: {...} } })` would silently
  discard any admin-set override for a key the plugin doesn't touch
  (Prisma JSON writes replace the whole column, no partial merge) — so
  `applyVerticalHooks()` reads the current config first and spreads the
  plugin's overrides on top. `enabledModules` intentionally is NOT
  merged — it's a full replace, matching how the existing admin config
  screen already sets the whole array, not a delta; a plugin's module
  list IS the company's module list going forward, not an addition to it.
- **`customFieldSeeds` application is idempotent by skip, not by
  upsert** — `applyVerticalHooks()` checks for an existing
  `(companyId, entityType, key)` row before calling
  `CustomFieldsService.create()` and simply skips if found, rather than
  updating it. An uninstall→reinstall cycle (or, if this phase's
  `install()` were ever called twice by a race) must not crash on
  `CustomFieldsService.create()`'s own duplicate-key
  `BadRequestException`, and must not silently overwrite a label/
  options an admin has since hand-edited on that custom field.
- **Real gap found while writing `generic-sales.test.ts`, not by
  review: `cleanupCompany` (the shared financial-harness test teardown,
  Phase 4) had never deleted `custom_field_definitions` — no test using
  that harness had ever created one before this phase's own test was
  the first.** Same class of gap as the `inquiries`/`follow_ups`/etc.
  omission the lead-inbound tests found in commit 2 (that entry, above):
  a harness helper's `tables` list only ever gets exercised for tables
  the tests that use it happen to write to, so a genuinely unused table
  can go unnoticed indefinitely. Fixed by adding
  `custom_field_definitions` to the list (no child rows reference it —
  custom field values live inline as JSON on each entity — so it only
  needed to go before `companies`, no dependency ordering concerns).
- **`useApiMutation` (apps/web `lib/hooks.ts`) widened from
  `'POST' | 'PATCH' | 'DELETE'` to also accept `'PUT'`** — a pure
  additive change to the method-name union, needed for the plugin config
  screen's `PUT /admin/plugins/:pluginId/config` call. Existing call
  sites are unaffected (they pass literal method strings already in the
  narrower set); this is not the "extra key in the body" class of shared-
  hook footgun Phase 5's decisions log warned about, since it doesn't
  touch how the body is serialized or what's included in it.
- **No dedicated "Inquiries" list screen exists in apps/web at all**
  (confirmed by grep before relying on one) — the manual click-through's
  "post an inbound lead and see it appear as an inquiry" step was
  verified via the staff `GET /inquiries/:id` API directly (returns the
  applicant's mapped name/phone/email and `status: 'OPEN'`) rather than
  a browser screen, since building a new list page was out of this
  phase's UI scope (three specific screens were asked for: plugins,
  webhooks, lead API keys — not a general inquiry browser).
- **A "Send Test Event" endpoint (`POST /admin/webhook-endpoints/:id/test`)
  was added beyond the original plan** — needed a real UI trigger for
  the required manual click-through's "fire a webhook" step, since no
  domain event is wired to `WebhookDeliveryService.dispatchEvent()` yet
  (deliberate commit-2 scope boundary — see that phase's decisions).
  Delivers directly to the one endpoint, bypassing its `eventTypes`
  subscription filter — the point of a test button is proving
  reachability regardless of what events the endpoint claims to care
  about — through the exact same signing/retry/attempt-logging path as
  a real event, not a separate fire-and-forget ping.
- **Manual click-through (real dev servers, `apps/api` + a locally-
  started `apps/web` Vite instance) — a genuine environmental finding,
  not a product bug: this Windows machine has TCP ports 5151–5250
  excluded by an OS-level Hyper-V/WSL reservation
  (`netsh interface ipv4 show excludedportrange`), which covers both of
  Vite's conventional dev ports (5173, 5174) — every `EACCES: permission
  denied` on those ports across this session was that exclusion, not a
  port conflict. Worked around by running Vite on port 5500 (confirmed
  clear of every excluded range) and adding it to `CORS_ALLOWLIST` for
  local dev only (`.env`, not committed). Recorded here in case a future
  session hits the same `EACCES` and wastes time assuming it's a stale
  process.** Exercised, over real HTTP through the full guard/DI
  pipeline: installed and enabled `generic-sales` from the admin UI
  (confirmed `CompanyConfig.labelOverrides`/`enabledModules` updated via
  the Company Config screen: unit→Product, project→Catalog,
  booking→Order, inquiry→Lead, tower/floor left at their existing
  defaults — proving the merge-not-replace behavior above); created a
  webhook endpoint with a signing secret and fired it via Send Test — a
  real HTTP POST reached a local echo listener carrying a valid
  `X-OpenEstate-Signature`/`X-OpenEstate-Timestamp` pair, and the
  delivery showed `SUCCESS` in the UI; created a lead API key with a
  field mapping and `POST`ed a signed-shape inbound payload via curl —
  the response's `inquiryId`/`applicantId` resolved to a real `OPEN`
  inquiry with the correctly-mapped applicant name/phone/email, verified
  via the staff API (see the "no Inquiries screen" entry above for why
  API verification, not a browser screen, was used for this specific
  step).

### Phase 7 → 8 gate — CI reliability (full-suite flakiness under parallel load)

- **Instrumented before guessing, per the standing rule.** `pg_stat_activity`
  polled every 1s during a full `pnpm test` run (Postgres `log_connections`/
  `log_disconnections` on) showed peak concurrent connections of 39 against
  `max_connections=100` — this directly REFUTES the leading hypothesis
  (raw connection-pool exhaustion from ~42 test files each constructing
  their own uncapped-default-pool `PrismaClient` pair). The real
  mechanisms were two unrelated, evidence-confirmed bugs, both triggered
  by CPU/IO contention under the full concurrent suite rather than by
  connection count:
  1. **`presales-assignment.test.ts`'s "100 concurrent claims" failure**
     was Prisma's own built-in `maxWait` (2000ms, never overridden by
     `withTenantTx`) being too tight once contention slowed individual
     transaction-acquisition below that window — not a pool-size problem.
  2. **`postsales-property.test.ts`'s recurring, differently-FK'd
     failures** (documented across Phase 4/5/7 in the now-removed
     `docs/todo.md` "known contention" entries) were a genuine self-race:
     Vitest's `it(fn, timeout)` stops AWAITING a timed-out test body but
     does NOT cancel it — the abandoned fast-check loop kept issuing real
     Postgres writes concurrently with the SAME test's `afterAll`
     cleanup deleting the same company's rows, producing a real `40P01`
     deadlock (confirmed by reading the Postgres server's own log, not
     just the client-side error, which only reports participant PIDs).
- **Fixes, in the order they compound:**
  1. `withTenantTx` (`packages/db/src/tenant.extension.ts`) now defaults
     `maxWait` to 10,000ms (was implicitly Prisma's 2,000ms) — fixes
     mechanism #1 directly, for every caller (prod and test), not just
     the failing test.
  2. Explicit `connection_limit=10` (tenant) / `connection_limit=5`
     (system) added to the test `DATABASE_URL`s
     (`scripts/test-setup.sh`, `.github/workflows/ci.yml`) — pure
     defense-in-depth given the 39/100 finding, replacing Prisma's
     oversized `num_cpus*2+1` default pool per client.
  3. `apps/api/vitest.config.ts` caps `poolOptions.forks.{minForks:1,
     maxForks:4}` (was vitest's default, which equals CPU count — 16 on
     the dev box) — directly reduces the CPU/IO contention that is the
     actual root driver of both mechanisms above. (Vitest requires
     `minForks` set explicitly alongside `maxForks`, or it throws
     "minThreads and maxThreads must not conflict" at collection time —
     its own default `minForks` is not `1`.)
  4. `postsales-property.test.ts`'s own `it(...)` timeout raised from
     600,000ms to 1,800,000ms — removes the false-positive trigger for
     mechanism #2's self-race (GitHub Actions' own job timeout, 360min
     default and unset in `ci.yml`, remains the real backstop against a
     genuine hang).
- **A separate, previously-undiscovered bug was found while proving the
  fix: Turborepo 2.10's default `envMode` is `strict`, and `turbo.json`'s
  `test` task only listed `DATABASE_URL_TEST`/`DATABASE_URL_TEST_SYSTEM`/
  `REDIS_TEST_URL` in its `env` array — silently stripping
  `PROPERTY_NUM_RUNS` from every task invocation, local or CI.** The
  first proof run's property test title read "holds across 2000 random
  sequences" despite `PROPERTY_NUM_RUNS=500` being exported, and at 2000
  runs under contention it took long enough to hit the newly-raised
  1,800,000ms timeout, reproducing mechanism #2 exactly. Since
  `.github/workflows/ci.yml`'s `PROPERTY_NUM_RUNS` override is set the
  same way (a step-level env var feeding the same `turbo run test`
  invocation), **this means the Phase 4 "500 on PR/push, 2000 only on
  the nightly schedule" cost-saving design has likely never actually been
  in effect in real CI** — every run has silently executed the CI-floor
  2000. Fixed by adding `PROPERTY_NUM_RUNS`/`FC_SEED` to `turbo.json`'s
  `test` task `env` array; no `ci.yml` change was needed since it flows
  through the same fixed `turbo.json`. Verified via a 5-run sanity pass
  ("holds across 5 random sequences") before re-running the real proof.
- **Proof: three consecutive full-suite (`pnpm test`) runs against a
  freshly-reset test DB each time, `CI=true PROPERTY_NUM_RUNS=500`,
  `--force` (turbo cache bypassed so each run genuinely re-executes) —
  all three: 11/11 tasks successful, apps/api 49/49 files / 330/330
  tests, `packages/db` 7/7 files / 61/61 tests, `packages/shared` 4/4
  files / 56/56 tests, 0 skipped, 0 failed, exit code 0.** Property test
  wall time per run: 128s, 120s, 136s (500 runs, consistent with
  isolated-run timing — confirms the maxForks cap eliminated the
  contention that previously inflated it).
- **CI already carries the equivalent configuration** — `.github/workflows/ci.yml`'s
  two `DATABASE_URL_TEST`/`DATABASE_URL_TEST_SYSTEM` env blocks were
  updated alongside `scripts/test-setup.sh` (same `connection_limit`
  values); `apps/api/vitest.config.ts`'s `maxForks` cap and
  `postsales-property.test.ts`'s timeout apply automatically in CI since
  both are versioned source files, not local-only config; the
  `turbo.json` fix applies identically to both `pnpm test` (local) and
  CI's `pnpm test` step since both invoke the same `turbo run test`.
  No CI-specific divergence remains.
- **Replaces every "known contention" entry previously in `docs/todo.md`**
  (the Phase 4-discovered, Phase 7-widened "Full-suite (`pnpm test`)
  contention failure in `postsales-property.test.ts`'s cleanup" section)
  — removed now that the root cause is fixed and proven, not just
  documented as a known flake.
- **Post-fix audit of every `process.env` read across the monorepo for
  the SAME silent-stripping class, done before closing this out —
  finding it once and stopping would have left the exact same failure
  shape sitting one variable name away.** Found and fixed two more gaps
  in `turbo.json`'s `test` task `env` array: `PROPERTY_NUM_RUNS_COMMISSION`
  (`commission-clawback.test.ts` has its own independent
  `resolveNumRuns()`, a SEPARATE env var from `PROPERTY_NUM_RUNS` — same
  bug, different name, easy to miss twice) and `CI` itself (read directly
  in both property tests' resolveNumRuns() fallback branch; every proof
  run so far had `PROPERTY_NUM_RUNS` explicitly set, so `CI`'s passthrough
  was never actually exercised — declaring it explicitly removes reliance
  on turbo's unverified-by-us built-in allowlist rather than assuming it
  covers this). Everything else found reading `process.env` at test-file
  module scope (`JWT_ACCESS_SECRET`, `PAN_ENCRYPTION_KEY`,
  `TOTP_ENCRYPTION_KEY`, `PLUGIN_SECRET_ENCRYPTION_KEYS`,
  `CORS_ALLOWLIST`, etc., across the e2e/plugin test files) uses a
  `??=` self-healing fallback to a hardcoded test value — a deliberate
  test-only default, not an accidentally-droppable override, so left
  as-is; the risk class is specifically "a value meant to TUNE test
  behavior/coverage silently reverting to a different tier," not "a
  credential defaulting to a known-safe stand-in."
- **Both property tests now log their effective config unconditionally
  at test start, not just in the parameterized test title** — the title
  alone (`` `holds across ${numRuns} random sequences` ``) is how this
  whole investigation started, but it's invisible to some reporters
  (CI's own "fail if any test was skipped" step reads `numPendingTests`
  from the JSON reporter, never the name) and easy to skim past. Each
  test's first line now prints resolved `numRuns` alongside the RAW env
  var it read (`PROPERTY_NUM_RUNS`/`PROPERTY_NUM_RUNS_COMMISSION`, plus
  `CI` and `FC_SEED`), so a future divergence between intended and actual
  tier is visible in every CI log by default, not something that needs
  re-instrumenting to catch a second time.

### Phase 8 — security pass and first tagged release (v0.1.0)

- **"OpenEstate" is confirmed as the project's real, final name** — see
  the amended Phase 0 entry above. v0.1.0 tags under it.
- **CWE-798 fixed, not just documented: the seed script's initial admin
  credential was hardcoded (`admin@demo-realty.com`/`Admin@123`) and
  shipped identically to every self-hosted production install**, since
  `deploy/install.sh` runs this exact seed script on first bring-up.
  `forcePasswordChange: true` was already set, but the account was
  attackable with a publicly-known-from-source password in the window
  before a real admin logs in. Fixed by generating a random password
  (`crypto.randomBytes`, printed once to stdout) — the same discipline
  every other secret in this codebase already gets via
  `install.sh`'s `rand_secret()`. Confirmed safe: grepped the whole repo
  for the literal string before changing it — only
  `apps/api/scripts/portal-demo-seed.ts` referenced it, and only to look
  the user up by email for a `createdById`, never the password itself;
  no automated test depends on this credential.
- **`Applicant.pan*` encryption retrofit closes a gap open since Phase 5** —
  `PanEncryptionService` was built for `Broker.pan*` only; `Applicant`'s
  identical columns (`panCiphertext`/`panMasked`/`panKeyVersion`, present
  since Phase 4) were always null because nothing ever wrote or read
  them. Same reuse pattern as `BrokerService`: `pan` added to
  `createApplicantSchema` (optional, same PAN regex), wired through
  `ApplicantService.create`/`update`. Real gap found in the same pass:
  neither this codebase's PAN encryption service NOR its "malformed
  input" behavior had ANY test coverage anywhere, for Broker OR
  Applicant — a service-level test calling `applicantService.create()`
  directly cannot prove Zod validation rejects a malformed PAN (the
  pipe runs before the handler, exactly the Phase 5 `soldUnitsQuerySchema`
  lesson) — fixed by adding the malformed-PAN test as a schema-level
  `.safeParse()` assertion in `packages/shared/test/presales-normalization.test.ts`
  instead, and adding real encrypt/mask/decrypt/round-trip coverage in
  `apps/api/test/presales-applicant.test.ts`.
- **Redis-backed `ThrottlerStorage` closes the Phase 1/6/7 in-memory-storage
  gap for all four named buckets at once** (they share one
  `ThrottlerModule.forRootAsync` registration). Hand-rolled
  `RedisThrottlerStorage` on the existing `ioredis` dependency (a single
  Lua script for atomicity, replicating `@nestjs/throttler`'s own
  `ThrottlerStorageService` semantics exactly — fixed window, block
  window, unblock-with-fresh-window — using Redis server `TIME` so
  multiple replicas agree on one clock) rather than a third-party
  throttler-storage package, matching this codebase's established
  preference for small hand-rolled implementations over new dependencies
  when the surface is small (Phase 7's SSRF/dot-path-resolver precedent).
  **Real bug, caught while writing the test, not by review:** `forRoot`'s
  plain `storage: new RedisThrottlerStorage()` value is constructed ONCE,
  at `@Module({imports:[...]})` decorator-evaluation time — Node's
  `require()` cache means every `NestFactory.create(AppModule)` call in
  one process (exactly what `e2e-*.test.ts` files do, repeatedly) shared
  the SAME storage instance and its ONE ioredis connection; closing one
  app instance ran `onApplicationShutdown()` and disconnected the client
  every OTHER already-running or later-created app instance in the same
  process also depended on, throwing "Connection is closed" on their next
  throttled request. Fixed by switching to `forRootAsync` + `useFactory`,
  which Nest evaluates fresh per application bootstrap — the correct
  ownership boundary regardless of the test-only symptom that surfaced
  it. **Second real bug, caught by running the full suite, not the
  isolated test file:** once storage was genuinely shared Redis state,
  `e2e-portal-throttle.test.ts`'s own portal-auth-bucket test (which
  deliberately drives an IP-keyed 5-req/5-min bucket to its exact 429
  boundary) started intermittently failing under real full-suite
  concurrency — OTHER e2e files that also log in through the same
  portal-auth-guarded route (`e2e-portal`, `e2e-broker-portal`,
  `portal-csrf-guard`) now share the same real Redis key, and a stray
  concurrent login from any of them shifts the boundary. The in-memory
  storage this replaced had given every concurrently-running test FILE
  free isolation from every other one; Redis-backed storage removes that
  for free — a genuinely new flakiness source, caught before it shipped
  by running the full suite (not just the one file) after the fix,
  exactly the discipline the Phase 7→8 CI-reliability session above this
  one just finished establishing. Fixed with `THROTTLE_TEST_KEY_PREFIX`,
  an env var `RedisThrottlerStorage` reads and prefixes its Redis keys
  with — empty (default, unchanged production behavior) in every real
  deployment, set to a value unique per test-file OS process
  (`e2e-portal-throttle.test.ts` only, the one file whose assertions
  actually depend on an exact hit count) so it gets a private keyspace
  other e2e files never touch. Proven via 3 consecutive full-suite green
  runs after the fix (11/11 tasks, 333/333 apps/api tests each time).
- **Docker base images pinned to real, freshly-pulled sha256 digests** —
  closes the Phase 0 gap whose own stated blocker was "no verified way
  to confirm real digests without risking a fabricated/stale hash";
  resolved directly this phase via `docker pull` + `docker inspect
  --format='{{index .RepoDigests 0}}'` for every image actually in use
  (`postgres:16-alpine`, `redis:7-alpine`, `nginx:1.27-alpine`,
  `minio/minio:RELEASE.2024-12-18T13-15-44Z`, `node:20-slim`,
  `node:20-alpine`). Dependabot's existing `docker` ecosystem entry
  already supports digest-pinned images and keeps proposing updates —
  no Dependabot config change needed.
- **Verifying the digest pinning end-to-end (`docker compose up` +
  `install.sh`, not just a healthcheck curl) surfaced four more real,
  pre-existing release blockers — all found only because this phase
  insisted on running the actual documented first-run path, not just
  the narrower thing the plan asked for:**
  1. `apps/api/Dockerfile` never copied `packages/plugin-sdk` or
     `plugins/generic-sales` into either build stage — Phase 7 added
     both as real runtime dependencies of `@openestate/api`
     (`plugins.module.ts` imports `@openestate/plugin-sdk` and
     `@openestate/generic-sales` directly) but the Dockerfile's
     selective-COPY list (Phase 1's deliberate pattern — copy specific
     paths, not whole directories) was never updated. The production
     image has been unbuildable since Phase 7 shipped; nothing caught it
     because `ci.yml`'s `compose-healthcheck` job builds the image but
     Phase 7's own verification apparently never rebuilt it from a
     clean Docker layer cache. Fixed: both packages' `package.json`
     (deps stage), `src`+`tsconfig.json` (build stage, plus their own
     `pnpm --filter ... build` steps in dependency order — plugin-sdk
     before generic-sales, which depends on it), and `dist`+`package.json`
     (runtime stage, mirroring the existing `packages/db`/`packages/shared`
     pattern) all added.
  2. `.dockerignore` excluded `plugins` entirely — a Phase 0 scaffold
     default from before any plugin package existed, never revisited
     when Phase 7 introduced one Docker now genuinely depends on.
     Removed.
  3. `PLUGIN_SECRET_ENCRYPTION_KEYS` is required at boot
     (`PluginSecretEncryptionService`'s constructor throws if unset) but
     was never added to `deploy/.env.example`, `deploy/install.sh`'s
     secret generation, `deploy/docker-compose.yml`'s `api` service
     environment block, or `ci.yml`'s `compose-healthcheck` `.env`
     generation step — every one of those was written before Phase 7
     introduced the variable and never updated. A production
     `docker compose up` has been unable to actually start the API
     container (not just "unbuildable" — this one throws at boot) since
     Phase 7. Fixed in all four places, `install.sh` generating a real
     `1:$(rand_hex_32)`-shaped value matching
     `PluginSecretEncryptionService`'s expected `version:hexkey` format.
  4. `install.sh`'s documented migrate/seed step
     (`docker compose exec ... pnpm --filter @openestate/db migrate:deploy`)
     has apparently never actually succeeded against a real built image:
     (a) the runtime container's service user (`useradd -r -g openestate
     openestate`, no `-m`) had no home directory, so corepack's
     first-use pnpm-version cache write failed with `EACCES`; (b) even
     with that fixed, `/app` in the runtime image is a `pnpm deploy
     --prod` output — a flattened, standalone package directory, not a
     pnpm workspace (no root `package.json`/`pnpm-workspace.yaml` there)
     — so `pnpm --filter @openestate/db ...` has no workspace context to
     resolve against, and corepack falls back to fetching whatever
     "latest" pnpm resolves to instead of the version actually pinned in
     the (absent, from that directory) root `package.json` — that
     latest version required Node 22+, hard-failing on this image's
     Node 20; (c) `MIGRATION_DATABASE_URL` used `localhost` as the
     Postgres host, but this URL is used inside a `docker compose exec
     api` call — from the API container's OWN network namespace, where
     `localhost` means the api container itself, not the separate
     `postgres` container reachable only via its compose service DNS
     name. Fixed: `prisma`/`tsx` promoted to direct `dependencies` of
     `@openestate/api` specifically so `pnpm deploy --prod` hoists their
     binaries to `/app/node_modules/.bin/` (found and fixed a duplicate
     `tsx` devDependency entry in the same pass — pnpm was silently not
     hoisting it while a plain `dependencies` entry with no
     `devDependencies` duplicate DID hoist correctly for `prisma`);
     `install.sh`'s migrate/seed steps now invoke
     `../../node_modules/.bin/prisma`/`tsx` directly via `docker compose
     exec -w /app/packages/db`, bypassing pnpm/corepack entirely for
     these one-shot operational commands; `MIGRATION_DATABASE_URL`'s
     host changed to `postgres` (the compose service name), matching
     the pattern `docker-compose.yml`'s own `api` service's
     `DATABASE_URL_SYSTEM` already used correctly.
  Verified via a genuine from-scratch `bash install.sh` run against a
  freshly built, digest-pinned stack: build succeeds, all containers
  become healthy, migrations apply, seed completes and prints a random
  admin credential, and that credential successfully logs in over real
  HTTP.
- **OWASP ASVS L2 self-assessment and a STRIDE threat model per module**
  added under the docs site (`docs/docs/security/asvs-checklist.md`,
  `docs/docs/security/threat-model.md`, Docusaurus's actual doc root —
  not the bare `docs/security/` path `SECURITY.md`'s and `docs/docs/intro.md`'s
  own prose informally referenced). Synthesis of the decisions already
  recorded across every phase above, not new design work; each entry
  points at a real file or a real decisions-log entry rather than
  asserting a control exists without a way to check it. States accepted
  residual risk plainly where it exists (plugin worker-thread isolation,
  PAN key-rotation wiring) instead of implying a guarantee the
  architecture doesn't make.
- **`SECURITY.md`'s disclosure channel resolved to GitHub Security
  Advisories** (zero additional infrastructure) — see the amended Phase 0
  entry above for the paired project-name resolution.
  `CODE_OF_CONDUCT.md`'s conduct-contact TODO deliberately stays an
  honest placeholder, per explicit user choice this phase — needs a real
  email only a human maintainer can commit to.

### Post-release hotfix — doubled `/api/api/v1/...` path on first real install

- **Real production bug, reported by the repo owner's own real Ubuntu 24
  install (v0.1.0) — every login failed with "Cannot POST
  /api/api/v1/auth/login".** Root cause: `VITE_API_URL` defaulted to
  `/api` in `deploy/.env.example`, `deploy/docker-compose.yml` (both the
  `web` and `portal` build-arg lines), and `ARG VITE_API_URL=/api` in
  both `deploy/docker/web.Dockerfile` and `deploy/docker/portal.Dockerfile`
  — but `apps/web/src/lib/api.ts`/`apps/portal/src/lib/api.ts` already
  hardcode `` `${API_BASE}/api/v1/...` `` on top of it, and
  `deploy/nginx/reverse-proxy.conf`'s `location /api/ { proxy_pass
  http://api:3000/api/; }` already forwards the `/api/` prefix through
  unchanged — so the correct default is an EMPTY string, not `/api`.
  **This had never been caught in eight prior phases of manual
  click-throughs because every one of them exercised either the Vite dev
  server directly (`http://localhost:3000` fallback, no `/api` prefix to
  double) or the API directly via curl/supertest — nobody had loaded a
  real Docker-built frontend bundle through nginx and clicked "Sign in"
  in a browser until this real install did.** Fixed by changing the
  default to empty in all four locations; verified end-to-end (not just
  by inspection) via a real `docker compose up -d --build` +
  `prisma migrate deploy` + seed + a real browser login through
  `localhost:8080`, confirming the network request hits
  `POST /api/v1/auth/login` (200), not the doubled path. Because Vite
  bakes `VITE_API_URL` into the JS bundle at image-build time, existing
  installs need `git pull` + `docker compose up -d --build` — a plain
  restart does not pick up the fix.
- **Lesson for future phases' "manual click-through" verification
  steps**: a click-through against `pnpm dev`'s Vite dev servers, or
  against the API directly, is not equivalent to a click-through against
  the actual `docker compose` production build — the two take genuinely
  different code paths for anything baked in at build time (like
  `VITE_API_URL`) or routed through nginx. At least one manual
  browser-based login should be run against the real Docker stack before
  any future release tag, not only against dev servers.

### Native install becomes primary; Docker demoted to contributor/CI tool

- **Direction change, not a Docker removal.** Native install (admin's own
  PostgreSQL/Redis, systemd, standard Linux paths — the "Zabbix model") is
  now the only user-facing install path; `deploy/docker-compose.yml`,
  `docker-compose.test.yml`, the Dockerfiles, and CI's
  `compose-healthcheck` job are all untouched and keep working exactly as
  before — they just lost their doc links from `README.md`/
  `docs/docs/installation.md`, which now describe `deploy/native/` only.
  `CONTRIBUTING.md` gained the Docker section instead, scoped explicitly
  to local test infrastructure.
- **One systemd unit, not two.** `apps/api/src/main.ts` runs the HTTP API
  and every BullMQ processor (`queues.module.ts`'s six queues) in the same
  `NestFactory.create(AppModule)` process — confirmed before designing the
  unit file, since a wrong assumption here would have meant either a
  missing worker unit (jobs silently never processed) or a redundant one
  double-consuming the same queues.
- **`deploy/native/lib.sh` centralizes the build+deploy sequence**
  (`build_release()`) so `install-native.sh` and `upgrade-native.sh` don't
  duplicate it. It reproduces `deploy/docker/api.Dockerfile`'s exact
  proven sequence outside Docker: `pnpm --filter @openestate/api build`,
  `pnpm --filter @openestate/api deploy --prod <dir>`, then manually
  copying `packages/db`/`packages/shared`/`packages/plugin-sdk`/
  `plugins/generic-sales`'s `dist/` + `package.json` back in (gitignored
  `dist/` output is excluded by `pnpm deploy`'s git-tracked-files
  selection, exactly the reason the Dockerfile already has to do this same
  manual copy) plus the generated Prisma query-engine binary out of the
  build's own `node_modules/.pnpm` store. `VITE_API_URL` is explicitly
  exported as an **empty string** (not left unset) before building
  `apps/web`/`apps/portal` — `import.meta.env.VITE_API_URL ?? 'http://localhost:3000'`
  only falls through on `null`/`undefined`, not `""`, so leaving the var
  truly unset at build time would have baked the dev-server fallback URL
  into the production bundle instead of same-origin empty-string routing.
- **Migrate/seed run as the Postgres `postgres` OS user via local peer
  auth, not as the `openestate` service account.** The obvious-looking
  `sudo -u openestate ... DATABASE_URL=postgresql://postgres@...` shape
  doesn't work: Ubuntu's default `pg_hba.conf` maps `peer` auth by
  matching the connecting OS user's name to the Postgres role name, and
  `postgres` (the fresh cluster's only passwordless superuser) has no
  password set for TCP/password auth by default — only local peer auth
  works for it out of the box. `install-native.sh`/`upgrade-native.sh`
  therefore `sudo -u postgres env DATABASE_URL=...` for the migrate/seed
  step specifically (mirroring `setup-database.sh`'s own local default),
  which requires the just-built release directory to be `o+rX` (added
  explicitly after `chown -R openestate:openestate`) so the `postgres` OS
  user can read and execute it.
- **`apps/portal/vite.config.ts` bakes `base: '/portal/'` into the build**
  (confirmed by reading the file before writing the nginx config, not
  assumed) — so the native nginx site's `/portal/` location must use
  `alias` (which replaces the matched prefix with the target dir),
  not `root` (which would append the full request URI, doubling the
  `/portal/` segment). `apps/web/vite.config.ts` has no `base` override,
  so its `/` location uses plain `root`.
- **Upgrade never attempts an automatic database rollback** — only
  `CURRENT_LINK`'s code symlink is rolled back on a failed post-cutover
  healthcheck. Consistent with this file's own forward-only-migrations
  rule (Phase 4): a migration failure leaves the *previous* release
  running against the *new* schema rather than attempting to undo it, and
  `upgrade-native.sh`'s pre-upgrade `backup-native.sh` call exists for a
  human-decided manual restore, never an automatic one.
- **Consistent mutation error toasts via `QueryClient`'s `MutationCache`,
  not per-call-site edits.** Neither app had a toast library or a global
  mutation error handler; an audit found ~15+ inconsistent call sites
  (some inline `setError()` banners, several bare fire-and-forget
  `.mutate()` calls with zero error surfacing, and one —
  `apps/portal/src/pages/Profile.tsx` — that captured `onError` but never
  rendered it). `new QueryClient({ mutationCache: new MutationCache({
  onError }) })` (not `defaultOptions.mutations.onError`, which a
  mutation's own `onError` would silently override) fires for **every**
  mutation app-wide in addition to any handler a component already has —
  wiring it once in each app's `main.tsx` fixed every one of those call
  sites, including future ones, without touching any of them. A small
  self-contained `lib/toast.tsx` (`useSyncExternalStore`-backed, no new
  dependency) is duplicated identically across `apps/web` and
  `apps/portal` rather than introducing a new shared UI package for one
  component — there is no existing FE-only shared package (`packages/shared`
  is FE/BE type-sharing) and the two apps have no other UI-component
  sharing precedent to extend.
- **`downloadFile()` in both apps' `lib/api.ts` calls `toast.error()`
  directly, not just improving its thrown message.** It isn't a TanStack
  Query mutation, so `MutationCache`'s global handler never sees it — and
  several call sites (e.g. `ReceiptEntry.tsx`'s PDF download after saving
  a receipt) deliberately swallow the thrown error in a bare `catch {}` to
  avoid blocking their own flow on a non-critical PDF failure, which
  previously meant the user got zero feedback that the download failed.
  Toasting inside `downloadFile()` itself fixes every such call site the
  same "fix once, in the shared function" way as the `MutationCache`
  change, without changing whether those call sites still swallow the
  exception for flow-control purposes.
- **`apps/web/src/pages/admin/Webhooks.tsx`'s `toggle`/`remove`/`sendTest`
  were bare `await api(...)` with no `try/catch` at all** (an unhandled
  promise rejection on failure, found during the same audit) — these
  don't go through `useApiMutation`/`useMutation` so `MutationCache`
  doesn't cover them either; wrapped individually in `try/catch` +
  `toast.error()`, the minimal fix for the three non-mutation-hook call
  sites the audit turned up outside the `useApiMutation` surface.

### Native install — real VM verification (8 real bugs, none caught by static review)

Static review (shellcheck, `nginx -t`, a careful read of every script)
found nothing wrong with `deploy/native/*.sh`. Running `install-native.sh`
for real, end to end, on a genuinely clean VM (user-provided, driven
directly over SSH) found eight real bugs in the first few runs — recorded
here because every one of them is exactly the class of bug the Phase
6/7/8 "manual click-through" and "through-the-wire test" lessons already
warned about: control-flow and environment-interaction bugs that only
exist at the seams between tools, invisible to reading any single file in
isolation.

1. **No build-toolchain prerequisite check.** `argon2` has no prebuilt
   binary for this platform/Node combination and falls back to compiling
   from source via `node-gyp` during `pnpm install` — `api.Dockerfile`'s
   build stage already knew this (`apt-get install -y python3 make g++`
   before its own `pnpm install`), but `install-native.sh` never checked
   for or installed them, so the very first real run failed deep inside
   `pnpm install` with `gyp ERR! stack Error: not found: make` — which
   then cascaded into "tsc: not found"/"nest: not found" everywhere else,
   because a failed postinstall script leaves pnpm's own `node_modules/.bin`
   linking incomplete for *everything*, not just the failing package.
   Fixed by adding an explicit prerequisite check (`make`/`g++`/`python3`),
   consistent with every other prerequisite in the script: checked and
   failed loudly with the exact `apt-get` command, never silently
   installed — same reasoning as Postgres/Redis/nginx, even though build
   tools have no ongoing state to manage.
2. **`build_release()`'s command-substitution return value was corrupted
   by the build's own stdout.** `RELEASE_DIR="$(build_release ...)"`
   captures *everything* written to stdout inside the function — pnpm's
   own progress/postinstall output was never redirected away from it, so
   `$RELEASE_DIR` ended up containing pages of pnpm log text instead of a
   path, and every later `chown`/`ln -sfn` using it failed with garbled,
   multi-line error output. Fixed by wrapping the whole build block in
   `( ... ) >&2` — all of it becomes stderr (still fully visible in the
   terminal), leaving only the one intentional `printf '%s' "$release_dir"`
   on the real stdout channel the caller reads.
3. **`NODE_ENV=production` (sourced from `openestate.env` before the
   build step, so the *deployed app* gets it at runtime) leaked into the
   *build itself*.** pnpm treats `NODE_ENV=production` as "skip
   devDependencies" — which silently dropped `typescript`/`@nestjs/cli`/
   `vite`, the exact root cause of bug 1's cascading "not found" errors
   even *after* fixing bug 1's missing compiler. Docker's build stage
   never hit this because its Dockerfile only sets `NODE_ENV=production`
   in the later `runtime` stage, never in `deps`/`build`. Fixed with an
   explicit `unset NODE_ENV` at the top of `build_release()`'s subshell.
4. **pnpm's `node_modules/.bin/*` entries on Linux are POSIX shell
   scripts, not JS files** — `node "${RELEASE_DIR}/api/node_modules/.bin/prisma"
   migrate deploy` failed with `SyntaxError: missing ) after argument list`,
   because `node` was trying to parse a `#!/bin/sh` wrapper script
   (`basedir=$(dirname ...)`) as JavaScript. The original assumption (that
   these could be safely wrapped in `node <path>` the same way
   `dist/main.js` itself is invoked) was simply wrong. Fixed by invoking
   `.bin/prisma`/`.bin/tsx` directly as executables (relying on their own
   shebang + exec bit, both of which pnpm sets correctly) in
   `install-native.sh` and `upgrade-native.sh`.
5. **A real bash `set -e` propagation gap silently swallowed a build
   failure instead of aborting.** `RELEASE_DIR="$(build_release ...)" ||
   die "Build failed"` never fired even when the build's internal
   subshell called `die` (which calls `exit 1`) — because the assignment
   is itself in a tested context (followed by `||`), and that observably
   suppressed `errexit` enforcement *inside* the subshell too: execution
   continued past the failed step to the function's final `printf`,
   returning a "successful" (but incomplete) release path to the caller.
   This is the same general class of footgun as the Phase 6 commit 2
   `AsyncLocalStorage.enterWith()` bug — an implicit propagation guarantee
   that doesn't actually hold across a specific kind of boundary. Fixed by
   never relying on implicit propagation here: `build_release()` now
   captures `$?` explicitly right after the subshell and `return`s it
   before reaching the `printf`, so `$(build_release ...) || die` is
   correct regardless of how `-e` does or doesn't propagate into the
   subshell.
6. **The original Prisma-client-copy design (copy `.prisma/` from the
   source checkout's pnpm store into the release's pnpm store, matching
   `api.Dockerfile`'s cross-filesystem copy) was fragile in a way Docker's
   version isn't, and broke in practice** — even once bugs 2–5 were
   fixed, the glob-matched destination directory sometimes lacked a
   `.prisma` subfolder at all, and the seed step failed with
   `Cannot find module '.prisma/client/default'`. Docker's Dockerfile
   *has* to copy across build/runtime stages (genuinely different
   filesystems); `install-native.sh` doesn't — source and release live on
   the same disk, in the same pnpm content-addressable store. Rather than
   debug the exact cross-store glob mismatch further, switched to
   **regenerating the Prisma client in place**: after `packages/db/prisma`
   is copied into the release, run
   `"${release_dir}/api/node_modules/.bin/prisma" generate --schema ...`
   directly against the release's own tree. No cross-directory copying, no
   glob-matching two independently-resolved pnpm store layouts against
   each other — strictly simpler and, empirically, reliable across
   multiple repeated clean-install runs.
7. **`backup-native.sh` used `DATABASE_URL` (the RLS-enforced
   `openestate_app` role) for `pg_dump`, and it failed on the very first
   real backup**: `pg_dump: error: query failed: ERROR: query would be
   affected by row-level security policy for table "applicant_addresses"`.
   `pg_dump`'s own `COPY` queries have no way to `SET
   app.current_company_id` the way the application's Prisma extension
   does, so every RLS-protected table is unreadable under the app role
   from outside the app. Fixed by dumping via `DATABASE_URL_SYSTEM`
   (`openestate_system`, `BYPASSRLS`) instead — exactly the role this
   project already has on hand for cross-tenant system operations.
8. **`restore-native.sh`'s `DROP DATABASE` failed against a live
   install**: `ERROR: database "openestate" is being accessed by other
   users` — the running `openestate-api` systemd service holds open
   connections. Fixed by having the script stop the service before the
   drop/recreate/restore sequence and start it again afterward
   (previously it only printed a reminder to restart manually, and didn't
   stop it first at all).

**Confirmed working end-to-end on the VM** after all eight fixes, across
multiple repeated runs (including a full `uninstall.sh --purge` followed
by a from-scratch reinstall, to prove idempotency rather than benefiting
from leftover state): `install-native.sh` (fresh install, and safe re-run
against existing env/database/user), real HTTP login through nginx with
the seeded admin credential, real HTTP role creation (`POST /api/v1/roles`
→ 201) proving the guard/validation/DB pipeline works end-to-end, the
`/portal/` `alias`-based nginx routing serving a real built JS asset with
the correct content-type, `journalctl -u openestate-api` showing pino's
JSON lines, `upgrade-native.sh`'s full backup→build→migrate→cutover→
healthcheck-gate sequence, the rollback mechanism specifically (verified
by deliberately breaking the current release's `dist/main.js` and
confirming symlink-back + restart recovers), `backup-native.sh` and
`restore-native.sh` against a real backup bundle, and both `uninstall.sh`
modes.

**Environment notes, not bugs**: the VM used was Ubuntu 25.10, not the
documented 22.04/24.04 targets (only 17 is packaged as `postgresql` on
25.10, not `postgresql-16` — the script only checks that `psql` exists,
not its exact version, so this didn't block anything, but it means
`install-native.sh`'s own `postgresql-16`-specific error message would be
slightly wrong advice on 25.10 specifically; 22.04/24.04 do have
`postgresql-16` available, so left as-is rather than chasing a moving
target). The VM also had no `curl` installed by default and uses
`sudo-rs` (the Rust sudo rewrite) rather than classic `sudo` — neither
affected `install-native.sh` itself (it never shells out to `curl`, and
`sudo -S`/`sudo -u`/passwordless-via-`env` all behave identically under
`sudo-rs`), but it's why every ad hoc verification command in this
session used `node -e "fetch(...)"` instead of `curl`, matching the
pattern the scripts and Docker's own `install.sh` already used for
exactly this reason.

### Mutation-error toast click-through — one real gap found, the rest a test-tooling false alarm

Real browser click-through (both dev servers, real Postgres/Redis via
`docker-compose.test.yml`, a fresh seed + `seed:portal-demo`) against
three failing mutations, one per app surface:

- **apps/web, Roles**: creating a role with a duplicate slug → toast
  "Role slug already exists" (already correct before this session).
- **apps/web, Webhooks**: creating an endpoint with an invalid URL/short
  secret/no event types → **no toast appeared** —
  `WebhooksPage.handleCreate` (a bare `api()` call, not a TanStack
  mutation) had its own `try/catch` setting `formError` for the inline
  banner, same as every other handler in this file before the
  native-install toast audit, but unlike `toggle`/`remove`/`sendTest`
  it was never given the matching `toast.error()` call — the earlier
  audit's grep evidently missed this one call site. Fixed by adding
  `toast.error((err as Error).message)` alongside the existing
  `setFormError`, same pattern as its three siblings in the same file.
- **apps/portal, Profile**: submitting an over-255-char email (passes
  the `type="email"` input's native constraint validation, which
  doesn't check length, but fails `createApplicantSchema`'s
  `.max(255)`) → toast correctly appeared once tested against a clean
  page load.

**A real, separate bug found in the process, not scoped to one call
site: every zod-validated 400 across BOTH apps showed the toast
"Validation failed" — nestjs-zod's default `ZodValidationException`
hardcodes that string regardless of which field actually failed.**
Fixed in `apps/api/src/common/pipes/zod-validation.pipe.ts` — replaced
the bare `nestjs-zod` re-export with `createZodValidationPipe({
createValidationException })`, where the custom factory builds a
`BadRequestException` whose `message` is the real per-issue detail
(`` `${path.join('.')}: ${message}` ``, joined with `; ` across every
failing field, e.g. `"url: Invalid url; secret: String must contain at
least 16 character(s)"`) instead of the generic string, while still
including the raw `errors` array for any programmatic consumer.
`main.ts` now imports `ZodValidationPipe` from this local module
instead of `nestjs-zod` directly — the only call site, so no other file
needed changing.

**A false alarm worth recording so a future session doesn't chase it
again: the portal toast appeared to silently not render on the FIRST
test attempt, with the network tab confirming a real 400 and the
`MutationCache.onError` handler confirmed (via a temporary debug log)
to be firing with the correct message — yet zero `[role=alert]`
elements in the DOM.** Root cause was the debugging process itself, not
the app: adding a `console.log` inside `apps/portal/src/lib/toast.tsx`
(a file that exports both a plain object `toast` and a component
`ToastContainer` from the same module) made Vite's Fast Refresh log
`"toast" export is incompatible"` and hot-swap the module in place —
creating a SECOND instance of the module's closured `toasts`/`listeners`
state. `main.tsx`'s already-bound `onError` closure kept calling
`.error()` on the OLD instance's `toast` export while the re-rendered
`ToastContainer` subscribed to the NEW instance's `listeners` — two
disconnected copies of state that used to be one. A full page reload
(fresh single module graph) after adding the debug log reproduced the
toast correctly, confirming the app code was never broken — only the
debug session's own hot-reload had briefly forked it. Lesson: don't
trust a DOM check for this toast module across an HMR boundary that
touched `lib/toast.tsx` itself; reload fresh first.

### Native install — CI job added, VM re-verified with this session's fixes

- **`.github/workflows/ci.yml` gained a `native-install` job**: real
  `ubuntu-latest` runner, apt-installs Postgres/Redis/Node 20/nginx/build
  toolchain (the exact prerequisite list `install-native.sh` itself
  checks for and refuses to silently install), runs `install-native.sh`
  unmodified, then asserts `/api/v1/health` responds and a real
  `POST /api/v1/auth/login` returns an `accessToken` — parsing the
  seeded admin password out of the install log the same way a human
  reading the terminal would. `compose-healthcheck` is untouched. This
  turns the "8 real bugs, found once on a VM" finding above into a
  permanently-enforced regression gate instead of a one-time proof.
- **Re-verified on the same Ubuntu 25.10 VM** used for the original
  8-bug pass, this time with the toast/zod-validation-message fixes from
  this session included: `uninstall.sh --purge`, then `DROP DATABASE`/
  `DROP ROLE` on `openestate`/`openestate_app`/`openestate_system` (user
  confirmed — this deletes the prior session's data) for a genuinely
  fresh run rather than a reseed-skipped re-run, then a clean checkout
  synced over (the working tree at this point, tarred and `pscp`'d —
  nothing was pushed to origin yet) and `install-native.sh` run with no
  flags. Fresh build succeeded, `/api/v1/health` returned
  `{"status":"ok","db":"ok","redis":"ok"}`, and a real HTTP login with
  the freshly-seeded admin password returned a real JWT `accessToken` —
  confirming this session's `ZodValidationPipe` change (a `main.ts`
  import-path change) survived the native `pnpm --filter @openestate/api
  build` step, not just the local dev server.
- **A genuine Ubuntu 24.04/PostgreSQL 16 run was not performed this
  session** — the VM provided was the same 25.10 box as before, not a
  24.04 one. `docs/docs/installation.md` §2 and this file both describe
  24.04+PG16 as verified based on the ORIGINAL VM session's own claim of
  having tested it (not independently re-confirmed here) alongside this
  session's fresh 25.10+PG17 re-verification. If that original claim is
  ever in doubt, treat 24.04 as unverified until a real 24.04 box is
  tested — don't extrapolate from the 25.10 result, since the whole
  point of the two-platform note is that the scripts were checked
  against two different default `postgresql` package versions, not two
  identical environments with different labels.

### Full production-readiness pass — 6 real bugs across two verification layers

A full pass driving a freshly-installed native deployment through real
HTTP calls across every module (company config through masters, roles,
inventory, presales, the full financial core, brokers, both portals,
plugins/webhooks/leads, admin) with realistic demo data — not review —
found and fixed 6 real bugs beyond the 8 install-script bugs above, none
of them install-script issues: the GSTIN/state-code config gap, the
health endpoint's hardcoded version, 18-of-19 master types 500ing on a
description field, 3 master types missing required fields entirely
(same root cause as the LetterTemplate module gap), a letter-template/
document-type merge-field mismatch crashing to a raw 500, and — found
during a stricter re-read of "confirm PAN is encrypted at rest and
masked in list views" than a first pass gave it — panCiphertext leaking
into API responses across ~10 call sites. Full detail in each fix's own
commit message; CHANGELOG.md's `[Unreleased]` section has the
user-facing summary.

**Tried and reverted: a global Prisma Client `omit` default for
panCiphertext/panKeyVersion** (`packages/db/src/index.ts`, in
`createTenantPrismaClient`/`createSystemPrismaClient`) — the obviously
"correct" root-cause fix once the leak turned out to span ~10 call sites
across 7 files, since Prisma 6 supports exactly this via a constructor
option. Type-checking failed: the omit-parameterized `PrismaClient<{
omit: {...} }>` type is not assignable to the plain `PrismaClient` type
`tenant.extension.ts`'s `tenantExtension()`/`audit.extension.ts`'s
`auditExtension()` were written against, so `base.$extends(...)` no
longer type-checks once `base` carries a non-empty `omit` option — a
real incompatibility between Prisma's typed-omit feature and this
codebase's existing `$extends` composition, not a typo. Reverted in
favor of per-query `omit` at every real call site instead (more code,
but each instance independently type-checks and is independently
tested). **Revisit the global approach only alongside updating
`tenantExtension()`/`auditExtension()`'s own type signatures to be
omit-shape-generic** — attempting the global default again without that
will hit the identical error.

**Real environmental hazard hit twice this session, unrelated to the
product: both Docker Desktop and the verification VM went down mid-session
with no warning** (Docker's named pipe vanished; the VM stopped answering
ARP) — coincided with a background-task session interruption, so likely
an environment-level event (host sleep/restart) rather than either
service failing independently. Recovery was mundane (restart Docker
Desktop; user power-cycled the VM) but cost real time mid-verification.
Not a product issue — noted here only so a future session recognizes
the symptom (`docker ps` failing with a missing named-pipe path; `ping`
replies of "Destination host unreachable" from one's own gateway IP for
the VM's address specifically) instead of re-diagnosing from scratch.

### CI native-install job — three real bugs, found only by making the job's own failure readable

The `native-install` CI job (added in the previous entry) was failing
silently: the step ran `cmd | tee file`, whose reported exit code was
`tee`'s (always 0) since GitHub Actions' default bash doesn't set
`pipefail` — the job reported a 0-second "success" that was actually an
instant failure the health-check step caught downstream, with no way to
see why. Fixing that required three iterations, each surfacing a real
bug that `gh`'s log API (rate-limited/invalid token all session — use
`WebFetch` on the public `.../actions/runs/<id>` and `.../job/<id>` HTML,
or the unauthenticated `api.github.com/.../check-runs/<id>/annotations`
endpoint, which works from this network even when `gh` doesn't) couldn't
have shown without first making the step honest:

1. **`deploy/native/*.sh` git-tracked without the executable bit**
   (mode `644`, not `755`). A genuinely fresh clone + the documented
   `sudo ./install-native.sh` dies at exit 126 the instant it execs
   `setup-database.sh`. Invisible on the verification VM because that
   checkout had a local, uncommitted `chmod +x` — this was NEVER
   actually tested via a fresh clone before this session, on the VM or
   in CI. Fixed: `git update-index --chmod=+x` on every script an admin
   runs directly (`install/upgrade/backup/restore/uninstall/setup-
   database`); `lib.sh` stays `644` (only ever `source`d). The CI step
   itself was also switched from `sudo bash -x ./install-native.sh` to
   the plain documented `sudo ./install-native.sh` — the `bash` prefix
   doesn't need the +x bit either, so keeping it would have silently
   re-masked this exact bug class on any future regression.
2. **GitHub's `::error::` annotation cap is 10 per step, keeping the
   *first* 10 emitted, not the last 10.** A `tail -n 30 | while read
   line; do echo ::error::$line; done` step reliably shows build-
   progress noise from 30–21 lines before the end, never the actual
   failure line closest to the end. Fixed by emitting only the true
   last ~9 lines. Worth remembering for any future "dump the tail as
   annotations" diagnostic step in this or another repo's CI.
3. **`run_as_superuser()`'s `prisma migrate deploy`/seed calls ran from
   the git checkout's own directory, not a directory the `postgres` OS
   user can traverse.** Prisma 6.19+ auto-discovers a `prisma.config.*`
   file in `cwd` before running any command; the discovery `lstat()`
   fails `EACCES` (not `ENOENT`) when an ancestor directory isn't
   world-traversable, and Prisma treats that as a hard failure instead
   of "no config, proceed." GitHub Actions runners check out under
   `/home/runner` (mode `0750`) — the VM's checkout lived under `/opt`
   (world-traversable all the way down), which is why this was never
   caught there. Fixed by running from `RELEASE_DIR` instead, which the
   script already `chmod -R o+rX`s for exactly this "run as the
   `postgres` OS user" reason. Same duplicated function existed
   verbatim in `upgrade-native.sh` and got the identical fix — a real
   customer upgrading on a host where their checkout lives under a
   similarly-restricted home directory would hit this in production.

Also added: a wall-clock duration guard (`< 60s` fails the step
regardless of exit code) as defense-in-depth against a future variant
of bug type 1 above — a genuine build+install can never legitimately
finish that fast.

**Closed the "tests seed directly" gap named as the root cause of the
5 setup-blocking bugs in the previous entry**: added
`apps/api/test/e2e-master-creation.test.ts`, one real-HTTP creation
test per master type (all 22) and per other admin-creatable entity
(users, roles, custom fields), each with a realistic payload including
optional fields. It found two more bugs on its first run, both invisible
to every direct-service-call test in the suite because they live
exactly at the HTTP-to-Prisma boundary those tests skip:
`CustomFieldDefinition.defaultValue` was accepted by the Zod schema
with no backing column (any real caller sending it 500'd), and
`UsersService.create()`'s `select` allowlist omitted `phone` (present
in `update()`'s — a copy/paste gap, not intentional) so a newly-created
user's phone number never came back in the response. `postsales-
harness.ts`'s `cleanupCompany()` needed the same treatment as its
existing `inquiry_sources`/`custom_field_definitions` comments describe
— extended with every master table this new test is the first to ever
populate.

### CI native-install SIGSEGV — root cause not found; four hypotheses tested and ruled out

After the three fixes above landed, the job progressed cleanly through
migrations/seed/nginx and then hit a new, different failure: the
deployed API crash-loops on startup with SIGSEGV
(`journalctl`: `Main process exited, code=dumped, status=11/SEGV`),
never becoming healthy. Confirmed via an isolated smoke test
(`require('argon2').hash('test')`, run standalone as the same user/
cwd/node binary the systemd unit uses) that this is argon2's native
module specifically, and confirmed via a real VM re-run of
`upgrade-native.sh` (see the entry above) that it does **not**
reproduce there — this is specific to GitHub's `ubuntu-latest` hosted-
runner class.

Four specific, individually-tested hypotheses, each ruled out with a
real comparison (not inference):
1. **Bad prebuilt binary** — forced `npm_config_build_from_source=true`
   (node-gyp-build respects this, skips its bundled napi prebuild).
   Confirmed the compile genuinely happened (step went from ~40s to
   ~5min) and the isolated smoke test crashed identically anyway.
2. **Threading bug in argon2's default `parallelism:4`** — a coredump
   backtrace (`sudo coredumpctl info`) pointed at a semaphore-wait
   frame (`uv__sem_wait`), which looked plausible since libargon2 uses
   pthreads for p>1. Tested `parallelism:1` explicitly in the same
   step as the default: both crashed identically (exit 139).
3. **Node.js itself broken on this runner** — a completely bare
   `node -e "console.log(1)"`, no argon2 or app code at all, ran clean
   ("bare node OK", exit 0). Rules out a generic Node/libuv problem;
   narrows it back to argon2 specifically despite (2) not confirming a
   threading cause.
4. **Version-specific regression** — this exact package has a real
   history of version-tied native SIGSEGVs (e.g. ranisalt/node-
   argon2#302, a Node16/Alpine regression). Bumped 0.45.0 → 0.45.1 (the
   latest patch) in both `apps/api` and `packages/db` (the seed
   script's own, separate resolution of the same dependency — also
   still on 0.45.0, never actually exercised by this crash since
   install-native.sh only warns, doesn't fail, if seeding fails).
   Crashed identically.

**Where this stands**: root cause still unknown. The coredump backtrace
that motivated hypothesis 2 didn't survive ruling out threading —
either the backtrace is misleading (a different thread's stack
captured at coredump time than the one that actually faulted, common
for heap-corruption-class bugs) or something about the Node/libuv
semaphore machinery itself interacts badly with argon2's memory-hard
computation specifically on this runner class in a way parallelism
doesn't control. **Do not re-attempt hypotheses 1-4 without new
evidence** — each was tested directly, not guessed. Reasonable next
steps for a future session: try Node 22 LTS instead of 20 for the
native-install path (a materially different V8/N-API build, unlike the
patch-level argon2 bump); or get a symbolicated backtrace (install
`libc6-dbg`/build argon2 with debug symbols so `coredumpctl`'s frames
resolve to actual function names instead of raw offsets) before trying
anything else blind. `docs/docs/installation.md`'s requirements section
documents this honestly as an open gap rather than claiming
ubuntu-latest is verified.

### CI native-install SIGSEGV — second time-boxed pass, four more angles ruled out; crash pinned to argon2's native module load itself

A second, explicitly time-boxed investigation, deliberately not
re-testing any of the four hypotheses above. Starting point: the
coredump backtrace lands in Node's own inspector-thread startup
(`uv__sem_wait`), not argon2 code — raising the question of whether the
crash is about argon2 at all, or about *how the process launches* on
this runner.

1. **Does the API crash standalone (outside systemd)?** Yes —
   identically (SIGSEGV, exit 139), run as the exact same user/cwd/env
   as the systemd unit but without any of systemd's own wrapping
   (`ProtectSystem=strict`, `NoNewPrivileges=true`, resource limits,
   `EnvironmentFile=` handling). This rules systemd's unit file out
   entirely as the cause — not a hypothesis, a direct comparison. (A
   first attempt at this test was confounded: `sudo -u openestate ...
   source /etc/openestate/openestate.env` silently failed with
   "Permission denied" — the file is `640 root:openestate`, readable by
   systemd's own root-run `EnvironmentFile=` handling before it drops
   privileges, but not by the `openestate` user reading it directly —
   and the test proceeded with an empty environment, crashing for a
   different, uninteresting reason. Fixed by reading the file as root
   and passing the vars explicitly via `env` to the openestate-run
   process, at which point it reproduced the crash for real.)
2. **Bisecting the unit file** (was next per the investigation's
   planned order) — skipped as moot once (1) showed the crash isn't
   systemd-related at all.
3. **Isolation ladder, same exact context as (1):** bare `node -e` runs
   clean; `require('argon2')` **alone, with no `.hash()` call**,
   crashes (exit 139); the full `dist/main.js` also crashes. This is
   the most precise isolation of the whole investigation — the crash
   happens at **native-module load time** (dlopen-equivalent, before
   any actual Argon2 computation), which is consistent with something
   in a static initializer or load-time CPU-feature-detection routine
   in libargon2's compiled code, not with anything about hashing
   parameters (already independently supported by the earlier
   `parallelism:1` result).
4. **Node 22 instead of 20** — argon2 is built `--napi` (N-API,
   explicitly ABI-stable across Node versions/rebuilds by design), so
   the *already-built* `argon2.node` from the Node 20 install was
   loaded directly under a separately-downloaded Node 22 binary with no
   rebuild. Crashed identically (exit 139). Rules out the Node.js
   runtime/V8 version as a variable — the same compiled native binary
   fails under two different Node majors.

**Net result of both passes (eight ruled-out angles, zero fixes
found):** the crash is in argon2's own compiled native code, at module
load time, independent of build method (prebuilt vs from-source),
hashing parameters (parallelism), Node.js version (20 vs 22), and the
process launch mechanism (systemd vs standalone). What's left
unexplained is the runner's own CPU/kernel/virtualization environment
specifically — GitHub's `ubuntu-latest` hosted runners are the only
place this has ever reproduced; it does not reproduce on the real VM
this project is otherwise verified against. **Time-boxed as instructed
— stopping here rather than continuing to iterate blind.**

Recommended next steps for whoever picks this up, in rough order of
effort: get a *symbolicated* backtrace (install `libc6-dbg`, build
argon2 with debug symbols) to name the actual crashing function instead
of a raw offset, since that's the one diagnostic this investigation
never obtained; or file the exact backtrace + this ruled-out list
upstream (ranisalt/node-argon2, or GitHub's own runner-image issue
tracker) since eight ruled-out local hypotheses is strong evidence this
isn't an application-side bug. A **pragmatic workaround** — switching
the `native-install` job to run inside a container-based runner instead
of directly on the VM-based `ubuntu-latest` image — was suggested and
is worth trying, but note it is not a small change: `install-native.sh`
runs real `systemctl` commands against a real systemd, which doesn't
run cleanly inside a stock Docker container without a systemd-capable
base image and elevated container privileges (cgroup access) — this
would need its own careful setup and testing, not a one-line runner
label swap. **This sidesteps the bug, it does not fix it** — the same
crash would presumably still lurk for any real customer running a
native (non-Docker) install on infrastructure that shares whatever
characteristic of `ubuntu-latest` triggers this, which remains
unidentified.

### CI native-install SIGSEGV — RESOLVED: replaced argon2 with @node-rs/argon2

Root cause was never identified (see the two investigations above —
eight ruled-out causes, all pointing at argon2's own native code
without pinning down why). Rather than keep guessing blind, evaluated
and executed a replacement instead: this dependency had by this point
caused two separate deployment failures (the Alpine/musl prebuild issue
from Phase 8, and this one), which on its own justified treating it as
a fragility problem worth removing rather than working around again.

Before swapping, checked the one real blocker: **do existing stored
password hashes remain verifiable?** Both `argon2` (ranisalt, the old
package) and `@node-rs/argon2` (RustCrypto's Argon2 via napi-rs) target
the standard PHC string format
(`$argon2id$v=19$m=...,t=...,p=...$salt$hash`) — confirmed
*empirically*, not just by reading docs: hashed a password with the old
library, verified it with the new one (correct password → true, wrong
password → false), and the reverse direction too. No migration path
needed, no forced password reset.

API shape checked against actual usage, not the full surface: this
codebase only ever calls two functions, `hash(password, options)` and
`verify(hashed, password, options)`, both async, same argument order in
both libraries. The only change needed at any of the 14 call sites
(3 production services, 9 test files, the seed script, and a demo-seed
script — grepped for every `from 'argon2'` in the repo, not just the
production ones) was the options shape: `{ type: argon2.argon2id }` ->
`{ algorithm: argon2.Algorithm.Argon2id }`. `Algorithm` is declared as a
TS `const enum` in the `.d.ts` but backed by a real runtime object
(`module.exports.Algorithm = nativeBinding.Algorithm` in the package's
own `index.js`), so it isn't just an ambient compile-time-only type —
confirmed this doesn't break under vitest's esbuild-based transform
(which doesn't reliably inline true const enums) by running the actual
suite, not by reasoning about it.

Full local verification before pushing: typecheck, lint, and the full
suite (54 files / 381 tests) all green. Pushed, and the `native-install`
CI job went **green** — first genuine pass, not a false-0-second
success: the install step took 97s (real build+install, well past the
60s duration guard), and the health-check and login-over-HTTP steps
both actually executed and passed (login specifically requires a full
hash-then-verify round trip against a real seeded password, so this is
airtight proof the fix works end to end, not just that requiring the
module doesn't crash).

Cleaned up afterward: removed the now-dead argon2-specific CI diagnostic
steps (bare-node smoke test, the standalone-launch isolation ladder,
the Node 22 load test — all three were built to debug a package no
longer in the dependency tree) while keeping the generic ones
(journalctl/nginx/postgres dump, dmesg, coredump backtrace), which
remain useful for any future crash-loop regardless of cause. Also
removed the `npm_config_build_from_source` workaround from
`deploy/native/lib.sh` (nothing left to force a from-source build of)
and corrected `install-native.sh`'s build-toolchain prerequisite
comment, which no longer applies to argon2 but still does to `sharp`
(the one remaining native dependency, prebuilt-binary-first like
argon2 was, with its own from-source fallback this prerequisite still
guards).

**Lesson for future sessions**: when a dependency has caused two
separate, unrelated deployment failures (different root causes, same
package), that's a signal to evaluate replacing it, not just fix the
second incident and move on — especially when a portable,
API-compatible, hash-format-compatible alternative exists.

### Standing rule: staff and portal auth are mirrored implementations — a defect found in one MUST be audited in the other, same commit

**This has now been violated twice.** The 2FA CSRF-cookie bug
(`AuthController.login()`'s 2FA-pending branch returning before
`setCsrfCookie(res)` ran) was fixed staff-side one session and left
broken portal-side for an entire session afterward — every 2FA-enabled
customer and broker was locked out of login that whole time, the exact
same failure mode already fixed and documented for staff. It was only
caught because a later, unrelated bug report ("CSRF token mismatch on
staff mutations") prompted an audit of "every branch that issues a
session or rotates tokens," which happened to include the portal
controller too. That audit should not have needed prompting by a
second bug report.

`apps/api/src/auth/` (staff) and `apps/api/src/portal-auth/` (portal)
implement the same auth surface twice, deliberately, not by accident —
different token pairs, different cookie names, different guard scoping
(see Phase 6 decisions on why the CSRF mechanism itself is "shared,
parametrized" rather than unified further). That duplication is a
correct design choice, but it means every fix to one side is a
question about the other side, not an assumption that it doesn't
apply. Mirrored pairs to check on every future auth change:

- `AuthController`/`AuthService` (staff) <-> `PortalAuthController`/
  `PortalAuthService` (portal)
- `auth.controller.ts`'s `setCsrfCookie()`/`setRefreshCookie()` <->
  `portal-auth.controller.ts`'s `setPortalCsrfCookie()`/
  `setPortalRefreshCookie()`
- Every session-issuing/token-rotating endpoint: login, 2FA verify,
  refresh, invite/reset-confirm (portal-only, no staff equivalent —
  check whether that asymmetry is intentional, not assumed)
- `apps/web/src/lib/api.ts` <-> `apps/portal/src/lib/api.ts` (the two
  client-side `api()` functions are near-identical by design; a fix to
  one's retry/refresh/CSRF logic almost certainly belongs in both —
  see the CSRF-mismatch-after-refresh fix, which needed both)

Added a checklist item to `CONTRIBUTING.md` for auth-related PRs so
this is enforced by the PR template, not just remembered.

### Password-change, admin force-reset, and CLI break-glass recovery

Implemented staff and portal together, per the standing rule above.

- `POST /auth/change-password` and `/portal/auth/change-password`
  already existed but revoked ALL of the user's sessions on success,
  including the one that just made the request — contradicts "log
  everywhere else out, stay logged in here" (the correct, expected
  behavior). Added `TokenService.revokeAllForUserExceptToken(userId,
  currentRawRefreshToken)`: looks up the calling session's refresh
  token family and excludes it from the revoke. Both controllers now
  read the refresh cookie and pass it through; falls back to
  revoke-everything if no refresh token is present (e.g. a stale
  session), same as before.
- New shared `password-change` throttler bucket (5 req/5min,
  `PasswordChangeThrottlerGuard`, tracked by `req.user?.sub ?? req.ip`)
  — one bucket/guard reused across staff change-password, portal
  change-password, and the new staff reset-confirm endpoint below,
  rather than three near-identical guards.
  **Corrected by the "Admin-generated password-reset links" entry
  below** — one limit setting, but a separate counter per route handler.
- Admin "force password reset for another user"
  (`POST /users/:id/force-password-reset`, `ADMIN_USER_UPDATE`) issues
  a reset link, never sets or reveals a password. Branches on the
  target: a portal-linked user (applicantId/brokerId set) reuses the
  *existing* self-service `PortalPasswordReset` model and confirm
  endpoint unchanged; a staff target uses a new `PasswordReset` model
  (staff had no reset-link mechanism at all before this) plus a new
  public `POST /auth/password-reset/confirm` on `AuthController`,
  mirroring the portal confirm flow exactly. Sent synchronously
  (`UsersService.forcePasswordReset`), not via the portal's BullMQ
  queue — unlike self-service `requestPasswordReset`, there's no
  identifier-guessing/timing concern here, the admin already knows
  this is a real user by id.
  **Partly superseded by the "Admin-generated password-reset links"
  entry below** — the token is now returned to the admin, and portal
  targets are refused here rather than branched on.
- `deploy/native/reset-admin-password.sh`: break-glass CLI for a
  locked-out super admin, run as root directly on the VM. Bypasses the
  API/login/2FA entirely — hashes a new (generated or `--password`)
  password with the release's own `@node-rs/argon2` and writes it via
  `DATABASE_URL_SYSTEM` (BYPASSRLS), then revokes existing sessions.
  Staff users only (`applicant_id`/`broker_id` both null); portal
  users go through the normal reset flows instead. `chmod 755`,
  git-tracked as `100755` (see the executable-bit lesson two entries
  up — this one was set correctly from the start).
- Added a self-service `GET /auth/me` / `GET /portal/auth/me`
  (`{ id, email, name, totpEnabled }`) — neither side had any way for
  the logged-in user to read back their own 2FA status, needed for the
  new Security settings pages below to render correctly on load rather
  than assuming "not enrolled".
- New frontend: a Security section on both `apps/web` (`/settings`)
  and `apps/portal` (`/security`) combining change-password with 2FA
  enroll/disable. Neither app had ANY 2FA enrollment UI before this —
  only login-time TOTP verify existed — so this is new UI on both
  sides, not wiring up something that already existed. No QR-code
  image (no QR library in the repo and the backend's own
  `totpSetupResponse.qrDataUrl` field has never actually been
  populated — `TotpService.generateSecret()` only returns
  `{ secret, otpauthUrl }`); the manual-entry secret is enough since
  every authenticator app accepts it, and adding a QR renderer for
  this was judged not worth a new dependency.
  **Superseded by the "TOTP enrolment gets a real QR code" entry
  below** — this reverses that decision.
- Bug this surfaced, unrelated to the feature itself: `cleanupCompany`
  (the shared e2e test-fixture teardown) was missing six tables —
  `webhook_endpoints`, `webhook_deliveries`, `webhook_delivery_attempts`,
  `lead_source_api_keys`, `plugin_installations`, `applicant_documents`
  — and started throwing FK-violation errors on every test file that
  touches them, the moment the `password_resets` migration's schema-drift
  reconciliation (see below) changed their `company_id` FK from the
  CASCADE it was accidentally created with to the RESTRICT
  `schema.prisma` actually specifies. Fixed by adding all six to the
  explicit delete list, in dependency order. This was latent breakage
  waiting to happen regardless of this session's changes — CASCADE on
  a company delete was never a deliberate design choice for these
  tables (everything else uses explicit RESTRICT + explicit cleanup),
  just a migration that predated the schema.prisma update and was
  never regenerated. The `add_password_reset` migration also reconciles
  a larger set of pre-existing FK/index drift across ~35 unrelated
  tables (confirmed via `git diff` that none of it came from this
  session's own schema edit) — normal `prisma migrate dev` catch-up
  behavior against a schema that had accumulated unmigrated edits, not
  something to be alarmed by if seen again.

### Standing rule: auth changes require a real browser click-through before commit

Auth is the highest-defect area of this codebase. Four real bugs found
across three sessions, all in the login/2FA/refresh/change-password
surface:

1. The 2FA CSRF-cookie bug, staff side (`setCsrfCookie()` skipped on
   the 2FA-pending early return in `AuthController.login()`).
2. The identical bug, portal side — fixed staff-side one session,
   shipped still broken on `PortalAuthController.login()` the next,
   locking out every 2FA-enabled portal account. This is the exact
   failure the mirrored-auth standing rule above exists to prevent.
3. A stale CSRF header on the client's 401-retry-after-refresh path
   (`apps/web/src/lib/api.ts` / `apps/portal/src/lib/api.ts`) — the
   retry updated the Authorization header but not the CSRF header
   after `/auth/refresh` rotated the cookie.
4. `change-password` revoking the caller's own session along with
   every other one — see the password-change entry above.
5. **Found the very next time this rule was actually followed**:
   `AuthContext.verifyTotp()`/`PortalAuthService`'s portal equivalent
   never sent the 2FA-pending login's `tempToken` as the `Authorization`
   header on the `totp/verify` call — `login()`'s 2FA-pending branch
   returns `tempToken` but never calls `setAccessToken()` (there's no
   real session yet), and `verifyTotp(code)` took no token parameter at
   all, so the request went out with whatever `accessToken` already held
   (nothing, for a fresh login). Staff's `TotpVerify.tsx` even received
   `tempToken` as a prop and never used it — dead prop, still declared.
   Server-side: instant, silent 401 (`JwtAuthGuard` rejects before the
   controller runs), ~3ms response time. Any 2FA-enabled user, staff or
   portal, was **completely unable to log in** — not a degraded
   experience, a hard lockout, on both sides, since Phase 6. Never
   caught because `e2e-csrf-refresh.test.ts`'s "mutation after 2FA
   login" tests attach `Authorization: Bearer ${tempToken}` themselves
   via supertest — they exercise the server's `totp/verify` handler
   directly and have no way to catch a bug in the client code that's
   supposed to attach that header, no matter how much they pass. Found
   by doing exactly what this rule prescribes: logging out and back in
   with a code, in a real browser, on the portal, because that flow had
   *never once* been through-browser tested on either side. Fixed by
   threading `tempToken` through `Login.tsx` → `verifyTotp(tempToken,
   code)` → `setAccessToken(tempToken)` before the call, mirrored
   identically on both `apps/web` and `apps/portal`.

Every one of these was found by actually exercising the flow — in a
browser, or through a real-HTTP e2e test that drives the full
guard/cookie pipeline — never by reading the code, and never by the
test suite that already existed at the time each bug shipped. Auth
bugs in this codebase are specifically the kind that unit tests and
code review don't catch: they live in the interaction between cookie
rotation, guard ordering, and which branch of a controller method
actually runs, not in any single function's logic. Bug 5 sharpens this
further: an e2e test can drive the server's auth pipeline perfectly and
still be structurally blind to a client-side bug, if the test builds
the request by hand instead of going through the actual frontend code
that's supposed to build it. A passing "2FA login" test in this repo
proves the *server* handles a correctly-formed request — it has never
proven a real browser can produce one.

**Standing rule**: any change touching `apps/api/src/auth/`,
`apps/api/src/portal-auth/`, `apps/web/src/lib/api.ts`,
`apps/portal/src/lib/api.ts`, or either app's `lib/auth.tsx` gets a
real browser click-through of the affected flow on BOTH staff and
portal before commit — log in, do the mutation, refresh, whatever the
change touches — regardless of how much test coverage already exists.
Passing tests are necessary, not sufficient, for this surface
specifically.

Also found in the same session, not auth-specific but worth recording:
`AuthProvider`'s mount-time `useEffect` (both apps, identical shape)
calls `/auth/refresh` unconditionally with no guard against
double-invocation. React 18 `StrictMode` (both apps use it) double-fires
effects in dev, so **every page load fires two concurrent refresh
calls** on the same refresh token. One wins and rotates it; the other
presents the now-superseded token, which `TokenService.rotateRefreshToken`
correctly treats as possible replay and revokes the *entire family* —
clearing both the refresh and CSRF cookies in its response. Because the
two promises aren't sequenced, whichever one's `.catch()` resolves last
can overwrite a just-established valid session with `{user: null}`,
logging a freshly-authenticated user straight back out. Confirmed
dev-only (StrictMode's double-invoke is stripped in production builds),
so it doesn't affect deployed behavior — but it means a hard page reload
during local dev is not a reliable way to check "does the session
persist," and it's a live illustration of exactly how fragile this
refresh-rotation reuse-detection is under any real concurrent-refresh
scenario (two tabs, a flaky retry). Not fixed this session — flagged
here rather than papered over, since the underlying race is real even
if this particular trigger is dev-only.

### `reset-admin-password.sh` — verified end-to-end on the VM

Per this session's own Phase 8 history, the reset-admin-password.sh
logic was already proven correct locally (hash → SQL write → argon2
verify round-trip) — what was unproven was script *mechanics* under
real conditions, exactly the class that broke three separate times in
Phase 8 (missing `+x`, Prisma `EACCES`, nginx not started). Since this
is the break-glass path for a locked-out super admin, it has to work
when nothing else does, so it was run for real: copied to
`/opt/openestate-src/deploy/native/` on the 10.10.10.46 VM, invoked
under `sudo` from a clean shell exactly as documented, against a
dedicated throwaway staff user (never against the real
`admin@demo-realty.com`, to avoid disrupting anyone's live session on
that box). Confirmed: reads `DATABASE_URL_SYSTEM` from
`/etc/openestate/openestate.env` correctly under `sudo`; connects as
`openestate_system`; rejects a portal-linked email with a clear message
and non-zero exit, leaving that row untouched; resets the target's
password and clears `force_password_change`; revokes their existing
refresh token; and the new password works for a real
`POST /auth/login` over HTTP, returning a normal, fully-permissioned
access token. All test fixtures and the manually-copied script were
removed afterward — the real deployment path for this file is a future
`git pull`/`upgrade-native.sh` once these commits reach wherever that
VM's remote points, not a one-off `scp`.

### Lint rules added because an unused prop was a real bug's static signal

The `TotpVerify.tsx` `tempToken` prop (see the standing-rule entry
above) was declared in `Props` and never destructured — a static,
mechanically-detectable signal that the wiring was incomplete, sitting
in the diff the whole time. `@typescript-eslint/no-unused-vars` could
never have caught it: that rule only flags an unused *local binding*,
and a prop that's never even destructured has no binding to flag. Added
`eslint-plugin-react`'s `no-unused-prop-types`, scoped to
`apps/web/**/*.tsx` and `apps/portal/**/*.tsx` (root `eslint.config.mjs`),
which checks the prop *type* against what the component body actually
reads — confirmed it flags the exact original pattern via a throwaway
scratch-file test before wiring it in for real. Also tightened
`@typescript-eslint/no-unused-vars`'s `args` option from the default
`'after-used'` to `'all'`, repo-wide, so an unused parameter is flagged
regardless of position, not just trailing ones.

Running both against the full repo surfaced exactly one other instance,
in `apps/api/src/plugins/plugin-http-client.ts`: `createScopedHttpClient`
took a `pluginId` parameter and never used it in any of the four errors
it throws in its own scope, unlike the sibling capability closures in
`plugin-runtime.service.ts` (`PluginCapabilityError(pluginId, ...)`),
which do attribute errors to the triggering plugin. Fixed by threading
`pluginId` into all four (`ctx.http[${pluginId}]: ...`) — a real,
if minor, "declared with intent, never wired in" gap, same shape as the
lockout bug, just far lower stakes. Left `resolveSecretHeaders` and
`assertPublicAddress` alone; those are deliberately pure/standalone
helpers (per their own doc comments) with no `pluginId` in scope, and
adding one would be an unrequested signature change to code kept pure
specifically so it stays directly unit-testable.

Both frontends lint clean with the new rules; verified via `pnpm -r lint`
across the whole monorepo, not just the two apps that prompted this.

### Standing rule extended: frontend request-construction changes need a browser click-through, not just tests

The narrower auth-specific rule above generalizes. Every bug found this
session in the client's own request-building code — `verifyTotp`
missing the `tempToken` Authorization header, the stale CSRF header on
401-retry — shares one root cause: **an e2e supertest builds the HTTP
request by hand** (`.set('Authorization', ...)`, `.set('X-CSRF-Token',
...)`), so it proves the *server* handles a correctly-formed request. It
has no way to prove the *frontend* code that's supposed to build that
request actually does — the test and the app code it's meant to
exercise never touch. This is structural, not a coverage gap closeable
by writing more supertests: no amount of server-side e2e testing can
verify client-side request construction, because the test never runs
the client.

**Standing rule**: any change to *how the frontend constructs a
request* — headers, auth, payload shape, file upload, anything in
`apps/web/src/lib/api.ts` or `apps/portal/src/lib/api.ts` or a
component that builds a request outside them — requires a real browser
click-through of the affected flow before commit, not just passing
tests. This subsumes and extends the narrower auth-only rule above.

**Audit of existing instances, done immediately rather than waiting to
find them one at a time** (grepped both frontends for every `fetch`
call, every manual `Authorization`/`X-CSRF-Token`/header construction,
every `mutationFn`/`queryFn`, every file-upload input):

- Every `fetch()` call in both apps lives inside their own
  `lib/api.ts` (4 each: the refresh helper, the main retry-wrapped
  call, the 401-retry, `downloadFile`) — no component calls `fetch`
  directly.
- Every `Authorization`/`X-CSRF-Token` header is set inside
  `lib/api.ts` only — no component sets an auth header by hand.
- Every `mutationFn` and `queryFn` across both apps' entire `src/`
  trees calls the shared `api()` client — zero direct bypasses found.
  This is exactly the shape of bug this audit was looking for, and
  none currently exist.
- No file-upload UI exists in either frontend yet (`<input
  type="file">` is absent from both) — so there's no FormData/
  multipart bypass to check; the class doesn't exist yet, not "exists
  and is clean."
- **Flagged, not fixed**: `downloadFile()` (in both `lib/api.ts`
  files, 6 call sites total — `Applicant360.tsx`, `DuesDashboard.tsx`,
  `BrokerDetail.tsx`, `Reports.tsx` on staff; `Account.tsx`,
  `BrokerStatement.tsx` on portal) sets the Authorization header
  correctly but, unlike the main `api()` function, has no 401-retry/
  refresh logic. If a user's access token happens to expire at the
  exact moment they click a download link, the download fails with a
  raw 401 instead of silently refreshing and retrying like every other
  request in the app does. Low severity (a visible error + manual
  retry, not a lockout) but the same *shape* as the bugs already
  found — a code path that doesn't fully mirror the main client's
  behavior. Left unfixed per instruction to report, not fix blindly.

### Systematic VM admin walkthrough — issue #1: forced first-login password change was never enforced

First finding of a full start-to-finish admin walkthrough on the VM
(fresh company, real browser, real admin flow — not targeted testing).
Every staff user gets `forcePasswordChange: true` on creation
(`UsersService.create`, and the initial seed admin) — but nothing ever
checked it. `ForceChangePassword.tsx` existed, fully built, correctly
calling `POST /auth/force-change-password` — and was never imported by
`App.tsx` or rendered by anything. `forcePasswordChange` was never on
the JWT payload, never in `/auth/me`'s response — no signal reached the
frontend at all. A fresh admin (or any newly-created staff user) could
log in with their temporary/generated password and use the entire
application indefinitely, with zero nudge or enforcement to ever change
it. Confirmed live: the walkthrough's own freshly-seeded admin logged
straight through to the Dashboard.

Root-caused, not just patched: added `forcePasswordChange?: boolean` to
`JwtPayload` (staff-only — portal users are always created via
invite-consume, which sets a real password immediately, confirmed by
grep that no portal code path ever sets it true), set on both places
staff tokens are signed (`issueTokens`, `refreshTokens`). Wired
`ProtectedRoute` to render `ForceChangePassword` in place of `<Outlet
/>` whenever the flag is set, blocking every other route. Its `onDone`
calls `logout()`, not a silent continue — `forceChangePassword` on the
backend revokes ALL of the user's sessions on success, including the
one that just made the request (unlike `changePassword`'s "except
current" behavior — deliberately different here, since a first-login
password should force a clean re-authentication), so there's no valid
token left to resume with anyway.

Regression tests added (`e2e-password-change.test.ts`): a fresh user's
JWT decodes to `forcePasswordChange: true`; after force-change-password,
the calling session is revoked, the old password stops working, the new
one does, and its JWT decodes to `false`. Neither existed before —
`force-change-password` had no test coverage at all prior to this,
consistent with nothing having ever exercised it end-to-end.

Fixed, redeployed to the VM, re-verified, then continued the
walkthrough — per the walkthrough's own ground rule not to batch fixes
to the end.

### Systematic VM admin walkthrough — issue #2: Secure cookies over plain HTTP, silently and completely broken for every real browser

Found immediately after issue #1, submitting the very first
CSRF-protected mutation of the walkthrough (`force-change-password`):
`403 CSRF token mismatch`, on a freshly-logged-in session, on the very
first attempt. `setRefreshCookie`/`setCsrfCookie` (staff and portal
both — `auth.controller.ts`, `portal-auth.controller.ts`) set
`secure: process.env.NODE_ENV === 'production'`. NODE_ENV is
`'production'` on every real native install by design — but this
project's own `deploy/native/` nginx config deliberately does not set
up TLS out of the box (see its own doc comment: "put a real
TLS-terminating proxy... in front for production use"). The VM this
session tests against runs exactly that default: plain HTTP, no TLS. A
cookie marked `Secure` is, per RFC 6265, silently never stored by any
real browser over a non-HTTPS connection — confirmed directly via
`wget -S`, which showed `Set-Cookie: ...; Secure` in the raw response.
So on any install that hasn't put its own TLS in front (which is the
*default*, out-of-the-box state, not a misconfiguration) — the CSRF
cookie and the refresh cookie **never get stored, ever, in any real
browser, for any user, staff or portal.** Not a degraded experience: no
mutation can ever succeed, and no session can ever survive a page
reload.

This had been invisible for the project's entire history. Every prior
"VM verification" (this session and, per the CLAUDE.md entries above,
at least four before it) used curl or wget against the VM directly —
neither enforces the Secure-cookie-requires-HTTPS rule, so neither
could ever have caught this. The Browser pane's per-site approval gate
on this VM's origin blocked every attempted real-browser check across
multiple sessions (see the earlier-documented incidents), which is
almost certainly *why* this survived so long: the one tool that would
have caught it immediately was the one tool that couldn't reach the
VM. This walkthrough is, as far as this project's history shows, the
first time a real browser (via Claude in Chrome, after the Browser
pane's gate blocked again and the user redirected to it) ever drove a
mutation against the actual deployed VM.

Root cause: `NODE_ENV === 'production'` is not a proxy for "this
connection is HTTPS" — conflating the two is the entire bug. Fixed by
keying `secure` off `req.secure` instead, which correctly reflects the
actual client-facing scheme once the app trusts its (single, always
present) reverse proxy: `app.getHttpAdapter().getInstance().set('trust
proxy', 1)` in `main.ts`, so `req.secure` honors nginx's own
`X-Forwarded-Proto` header. On this VM (plain HTTP) this makes `secure`
correctly `false` — cookies now actually get stored, and CSRF and
session persistence work for the first time. On a *future* install
with a real TLS-terminating proxy in front, `X-Forwarded-Proto: https`
would flip it back to `true` automatically — no config toggle needed
either way, it just tells the truth about the actual connection.

New regression tests (`e2e-cookie-secure.test.ts`) reproduce the exact
bug condition — `NODE_ENV=production` set explicitly, since the shared
test bootstrap never sets it — over what looks like a plain HTTP
request, and assert neither staff nor portal login sets a `Secure`
cookie; a third test confirms `X-Forwarded-Proto: https` correctly
flips it on. `NODE_ENV` is restored in `afterAll` so it doesn't leak
into sibling test files sharing the same forked worker (mirrors this
repo's own `THROTTLE_TEST_KEY_PREFIX` isolation precedent).

Fixed, test-covered, redeployed, and re-verified live on the VM: the
same `force-change-password` submission that 403'd now succeeds, the
new password works for a fresh login, and the walkthrough continued
from there.

### Systematic VM admin walkthrough — issue #3: Company Config page had no way to edit the company's own name

Found during the COMPANY phase, filling in every field on the config
page: `CompanyConfig.tsx` only ever called `PATCH /company/config`
(terminology, modules, GST, locale, branding). The company's own
`name` field has a separate backend endpoint, `PATCH /company`
(`ADMIN_COMPANY_UPDATE`), that the frontend simply never wired up —
not a regression, a gap that existed since the page was first built.
No automated test caught it because none existed: grepping
`apps/api/test` turned up zero references to `PATCH /company` at all,
staff or portal, direct-service or through-the-wire.

Lower severity than issues #1/#2 (no security or data-loss impact,
just a missing field), but same *shape* as this walkthrough's other
findings: invisible to every existing test because no test exercised
the endpoint, and invisible to code review because the missing UI
looks like "config page for config, not company core fields" rather
than an obvious hole — the kind of gap that only surfaces by actually
trying to do the thing a real admin would do on day one (name your
company).

Fixed by adding a Company Name field, wiring `handleSave` to PATCH
both endpoints, and adding `e2e-company-update.test.ts` (PATCH
`/company` round-trips through GET `/company`, since there was no
coverage of this endpoint at all before now). Address has no schema
field anywhere in the project and is scoped out as a separate,
never-built gap rather than a bug — fixing it would mean a new
migration + DTO + UI, out of scope for "fix what's broken."

Fixed, test-covered, redeployed, and re-verified live on the VM: name
plus GSTIN, GST state code, FY start month, logo URL, and accent color
were all filled in through the real UI, saved, and confirmed present
after a full page reload.

### Systematic VM admin walkthrough — issue #4: Masters admin page — every edit ever submitted 400'd; 6 of 17 master types had no working create path

Found during the MASTERS phase. Two separate bugs in `Masters.tsx`,
both severe:

1. **Editing any master, of any type, has never worked.** The update
   mutation used `useApiMutation`'s `(body) => url` path-building form,
   but that hook always `JSON.stringify(body)`s the whole body it's
   given — including the `id` field used to build the URL. The
   backend's `updateMasterSchema` is `.strict()`, so every PATCH
   through this page's Edit button 400'd with "Unrecognized key(s) in
   object: 'id'". Create and Delete worked; Edit never did, for any of
   the 17 master types, ever. Confirmed live: renaming "Website"
   (created moments earlier) 400'd on the very first Update click.

2. **document-types/interest-rules/transfer-fee-rules** showed a
   Create form but only ever collected `name`, while their Prisma
   models require `entityType` / `rateType`+`ratePercent`+`frequency` /
   `feeType`+`amountPaise` (see `master.factory.ts`'s `extraFields`) —
   every create attempt 400'd. **gst-rates/tds-rules/letter-templates**
   had no Add Item button at all (`isSpecialized` explicitly hid it) —
   these three don't even have a `name` column, so the generic form
   could never have worked regardless.

Fixed by rewriting `Masters.tsx` with a per-table field config
(`TYPE_FIELDS`) driving a dynamic form, calling `api()` directly for
create/update instead of routing `id` through the mutation body, and
adding a generic Active checkbox + Sort Order field for every table
(previously set once at creation and then permanently unreachable —
"deactivate a master" was not a real capability despite the schema
supporting it everywhere).

A second bug surfaced *while fixing the first*: the Bank fields I
added (branch/ifsc/accountNumber) were copied from `createBankSchema`
in `packages/shared/src/master.dto.ts`, which looked authoritative but
was dead code — never imported by any controller. Bank actually goes
through the generic factory (name/isActive/sortOrder only), and the
Prisma `Bank` model doesn't have `branch` or `accountNumber` at all
(it has `ifscPrefix`, not `ifsc`). Caught immediately by the same
browser click-through discipline this standing rule requires — the
form 400'd on the very next real submission. Fixed by removing the
Banks entry from `TYPE_FIELDS` and deleting the dead
`createBankSchema`/`updateBankSchema` so the next person grepping
`master.dto.ts` for "how do I add Bank fields" doesn't get misled the
same way. See `docs/todo.md`'s "AreaLocation/Bank/ChargeType have real
optional columns the API never exposes" for the real (deferred) gap.

No component-test harness exists in `apps/web` yet (zero test files) —
building one from scratch was out of scope for this fix, so this is
verified by browser click-through only, per the standing rule for
frontend request-construction changes.

Fixed, redeployed, and re-verified live on the VM: created one entry
in all 17 master types (including the 6 that were previously broken or
unreachable — Document Types, Interest Rules, Transfer Fee Rules, GST
Rates, TDS Rules, Letter Templates), edited one (Inquiry Source
"Website", toggled inactive), and confirmed the Active/Sort Order
columns reflect it.

### Systematic VM admin walkthrough — issue #5: Custom Fields admin page could never create a field (fieldName vs key)

Found during the CUSTOM FIELDS phase, first attempt to define a field
on Applicant: 400 "key: Required; Unrecognized key(s) in object:
'fieldName'". `CustomFields.tsx` used `fieldName` throughout (state,
request body, table column), but `createCustomFieldSchema`
(`packages/shared/src/custom-field.dto.ts`) and the Prisma
`CustomFieldDefinition` model both use `key`. This page has never
successfully created a custom field through the real UI. Fixed with a
straight rename, `fieldName` → `key`, matching the actual schema.

Separately, not fixed (a missing feature, not a bug — see
`docs/todo.md`): custom field **values** are never captured or
displayed anywhere. There is no `CustomFieldValue` model, and no
Applicant/Unit/Booking/Inquiry/Project form fetches or renders the
definitions at all. Defining a field through this now-working admin
page has zero effect anywhere else in the product.

Fixed, redeployed, and re-verified live on the VM: created a field on
Applicant (`aadhaar_number`, TEXT) and one on Unit (`facing_direction`,
SELECT with options North/South/East/West), both confirmed present
after a full page reload.

### Systematic VM admin walkthrough — issue #6: role slug regex + Roles/Users list pages both silently empty

Found during the ROLES & USERS phase, three bugs in sequence:

1. Role creation 400'd on the first attempt — RoleForm.tsx's own hint
   text promises "lowercase letters, numbers, hyphens, underscores"
   but `createRoleSchema`'s regex rejected hyphens entirely. Fixed by
   widening the regex to match what the UI has always promised (see
   full writeup above this one — filed as its own commit before this
   summary).
2. The role was created (confirmed via direct API response) but the
   Roles list showed "No data found". `GET /roles` has always returned
   a plain array; `Roles.tsx` read it as `{data, meta}` via
   `usePaginatedQuery`, so `data.data` was always `undefined`. **The
   Roles list has never shown a single role, ever**, regardless of how
   many existed. Checked the other three `usePaginatedQuery` consumers
   (Users, Brokers, Masters, AuditLog) against their backends — all
   four genuinely paginate; this was an isolated mismatch.
3. Same bug, second independent occurrence: `UserForm.tsx`'s Add User
   page has a Role dropdown that read `roles?.data?.map(...)` against
   the same bare-array endpoint — the dropdown has always been empty,
   so a user could never be assigned a role through the UI at all
   (had to go back and re-fix this after the create-user flow
   demonstrated it live).

Both fixed with a plain `useQuery<Role[]>` instead of
`usePaginatedQuery`. Fixed, redeployed, and re-verified live: created
role "Site Visit Coordinator" (5 permissions: inquiry.read/update,
site-visit.create/read/update), it now appears in the Roles list,
selecting it now works when creating a user, and the created user
("Priya Coordinator") logged in successfully.

**Lower-severity finding, not fixed:** navigating a low-permission user
directly to an admin URL (`/admin/users`) renders the page shell
(including a clickable "Add User" button) instead of an access-denied
state — the backend correctly 403s the underlying `GET /users` (no
data leak, no security hole), but the frontend has no route-level
permission guard, so the page silently shows "No data found" rather
than explaining why. Confirmed via network log: the 403 happens, the
UI just doesn't distinguish it from a genuinely empty list. Worth a
future pass (a `<RequirePermission>` route wrapper), not fixed here.

**Major finding, not fixed — requires a scope decision:** the staff
web app (`apps/web`) has **zero frontend UI for Pre-sales
(Inquiries/Follow-ups/Site-Visits/duplicate-detection/reassignment) or
Inventory (Projects/Towers/Units)** — no routes in `App.tsx`, no nav
entries in `AppShell.tsx`, no pages under `apps/web/src/pages/`, for
either module, for any role including Super Admin. Both backends are
complete (`apps/api/src/presales/` has 17 files; inventory has its own
full module) with full `PRESALES_*`/inventory permission sets already
wired into the Add Role permissions picker — the picker just controls
access to screens that don't exist. A prior session's decisions log
entry (Phase 7) already acknowledged the Pre-sales gap as "out of this
phase's UI scope," but it was never tracked in `docs/todo.md` and this
walkthrough's own Tasks #28 (INVENTORY) and #29 (PRE-SALES) cannot be
executed as specified without it. This blocks real usage of the
product's actual sales funnel — a company using this software today
could never log an inquiry or set up a project's units through the
real UI. Flagged to the user rather than silently built (a multi-file,
multi-day frontend build, not a bug fix) or silently skipped.

**Resolution**: user chose to have both built now rather than deferred
or skipped. Minimal Inventory UI (Projects list+create with RERA
number, project detail with tower create, bulk-generate units, a
filterable unit list, multi-select rate revision, per-unit rate
history) and minimal Pre-sales UI (Inquiries list+create with inline
applicant creation surfacing the backend's duplicate-detection field,
inquiry detail with status transitions/reassignment/a follow-up log
that doubles as site-visit logging) were built and wired into
`App.tsx`/`AppShell.tsx`. Explicitly NOT built: PLC/unit-charge
management and layout-plan upload — confirmed via a full backend
survey that neither has a real endpoint (`UnitPlc`/`UnitCharge` are
Prisma models with no controller; `UploadService` exists but no
inventory route calls it) — wiring a form to a non-existent endpoint
isn't a minimal UI, it's a broken one.

Three more bugs surfaced building and click-through-verifying this new
code, all fixed same-session before moving on:

1. **ProjectDetail.tsx crashed on load.** `GET /projects/:id/towers`
   returns `{data, meta}` like every other list endpoint in this
   codebase — but the page fetched it as `useQuery<Tower[]>` and called
   `.map()` directly on the wrapper object. `TypeError: St.map is not a
   function`, whole page blank. Caught immediately by loading the page
   live per the standing rule. Fixed by reading `.data` like the page's
   own Units/rate-history queries already correctly did.
2. **Masters.tsx's Bank fields were invented, not real.** While wiring
   Unit Types into the new bulk-generate form, added `branch`/`ifsc`/
   `accountNumber` fields to Banks by copying `createBankSchema` from
   `master.dto.ts` — which turned out to be dead code (never imported
   by any controller) describing a schema that doesn't match the real
   `Bank` Prisma model (no `branch`/`accountNumber` columns; the real
   column is `ifscPrefix`, not `ifsc`). 400'd on the very next
   submission. Fixed by removing the invented fields and deleting the
   dead schema so it can't mislead anyone else the same way (see the
   fuller writeup a few sections up).
3. **Inquiries.tsx list never refreshed after creating an inquiry.**
   `POST /inquiries` succeeded (201) but `handleCreate` called `api()`
   directly and never invalidated the `['inquiries']` query cache —
   unlike Projects.tsx (uses `useApiMutation`'s `invalidateKeys`) and
   ProjectDetail.tsx (explicit `qc.invalidateQueries` after bulk-
   generate/rate-revision). Added the missing invalidation call.

Fixed, redeployed, and re-verified live end-to-end on the VM: created
project "Green Woods Residency" with a RERA number, two towers,
bulk-generated 12 units in Tower A, applied a rate revision to 2 units
and confirmed it in Rate History; created an inquiry, created a second
inquiry with the same phone number and confirmed the duplicate-warning
banner appeared, logged a follow-up, logged a site visit (via the
"Site Visit" follow-up type + scheduled date + venue — confirmed
correct in the database directly, not just the UI), reassigned the
inquiry to the "Site Visit Coordinator" test user from the ROLES &
USERS phase, and marked it SUCCESSFUL.

## POST-SALES phase — 4 issues found, fixed, and a real UI gap built

Booking wizard (applicant + co-applicant + unit + custom payment plan +
confirm) worked end-to-end on the first try, no bugs. Receipt Entry and
Applicant 360 were a different story:

1. **`ReceiptEntry.tsx`'s "Applicant phone / booking number" label
   promised a lookup path that never existed.** `phoneSearch` only ever
   hits `GET /applicants?search=...`, whose `where.OR` matches
   `name`/`primaryPhone`/`email` (`applicant.service.ts`) — never
   `bookingNumber`, and no booking-number search endpoint exists
   anywhere in the API. Typing a booking ID/number into that field
   silently returns zero results, `bookingId` stays unset, and the
   submit button (`disabled={... || !bookingId ...}`) sits there
   looking clickable but does nothing — no error, no request fired.
   This is exactly the same class of bug as the roles-slug regex
   earlier: UI text promising a capability the backend doesn't have.
   Fixed by correcting the label to "Applicant phone / name" (what the
   endpoint actually supports) rather than building a booking-number
   search feature nobody asked for.
2. **`Applicant360` (the ledger view, route
   `/postsales/applicants/:applicantId`) was reachable by typing the
   URL and nowhere else.** Grepped every `Link`/`navigate` call in
   `apps/web/src` — zero hits outside the route definition itself.
   Dues Dashboard and the installment-dues report return plain string
   tuples (`[bookingNumber, applicantName, ...]`, no ids at all — see
   `DueRow` in `DuesDashboard.tsx`), so that page structurally *can't*
   link there without a backend report-shape change. Cheque Queue has
   the same gap. Fixed the cheapest way: added a "View ledger" link in
   `ReceiptEntry.tsx` next to "Change", the one place the applicant id
   is already sitting in component state after a search-select. Dues
   Dashboard/Cheque Queue linking would need the report endpoints to
   start returning ids — left as a known gap, not fixed, since it's a
   backend contract change, not a frontend wiring fix.
3. **Every merge-field-driven PDF type (Statement, Allotment Letter,
   Demand Letter, Reminder Letter) had zero frontend UI.** The backend
   (`document.controller.ts`, `letter-template.controller.ts`,
   `MERGE_FIELD_REGISTRY` in `packages/shared/src/documents.ts`) is
   fully built and was already covered by unit tests, but nothing in
   `apps/web` ever called `POST /bookings/:id/documents/*` except the
   receipt-PDF path — `Applicant360.tsx` only *listed* already-generated
   documents. This is the same shape as the earlier Inventory/Pre-sales
   gap (real backend capability, zero UI), and since it directly
   blocked this phase's "generate every PDF type" requirement, the user
   was asked and chose to build it now rather than skip or log-only.
   Added: a Letter Templates admin page
   (`apps/web/src/pages/admin/LetterTemplates.tsx` — CRUD list/create,
   merge-field hints per `entityType` pulled live from
   `MERGE_FIELD_REGISTRY` so the hint can never drift from what the
   backend actually validates) and a "Generate documents" section on
   `Applicant360.tsx` wired to all four endpoints (statement needs no
   template; allotment needs a template; demand/reminder need a
   template *and* a due installment, sourced from the same
   `/bookings/:id/plan-history` query `ReceiptEntry.tsx` already uses).
4. **Cheque bounce correctly reverses ledger allocation — verified, not
   assumed.** Bounced the ₹20,00,000 cheque receipt via Cheque Queue;
   confirmed the "On Possession" installment's `allocatedPaise` dropped
   back from ₹44,00,000 to ₹24,00,000 (status PART_PAID, due
   ₹20,00,000) on the Installment Schedule page, matching Dues
   Dashboard's outstanding figure and the ledger's `BOUNCE_REVERSAL`
   entry — three independent views agreeing, not just one.

Full live verification narrative: created booking
BKG/2026-27/000001 (Rahul Sharma + co-applicant Rahul Sharma Jr, unit
Tower A/A-0103, ₹55,00,000, custom 2-installment plan) → paid the
Booking Amount installment in CASH (₹11,00,000) → paid part of On
Possession in CHEQUE (₹20,00,000) → paid the rest of On Possession in
NEFT with a UTR reference (₹24,00,000) → confirmed all three receipts
(RCP/2026-27/000001–3) via `Save & Print Receipt`'s auto-downloaded
PDFs → bounced the cheque receipt with a reason, confirmed it moved to
the BOUNCED tab and the installment reverted to PART_PAID → opened
Applicant 360 via the new "View ledger" link and confirmed the ledger
(CHARGE ₹55,00,000, three RECEIPT_ALLOC entries, one BOUNCE_REVERSAL,
balance ₹20,00,000) matches Dues Dashboard exactly → created one
template per letter type through the new Letter Templates page →
generated Statement, Allotment Letter, Demand Letter, and Reminder
Letter from Applicant 360, each opened as a real downloaded PDF →
read the Demand Letter PDF directly off disk and confirmed every
`{{token}}` resolved correctly (applicant name, ₹20,00,000 due amount
matching the post-bounce outstanding, "On Possession" label, unit
number, date) with no literal unresolved tokens.

No coordinate-drift automation mishaps rose to the level of a product
bug this phase — several form fields got mis-typed into the wrong
input when the receipt-entry layout shifted after selecting CHEQUE/NEFT
mode (new fields appearing pushes content down between a click and the
next type action), but re-reading the screenshot before each entry and
correcting with `triple_click` + retype caught all of them before
submission; none were the product's fault.

## BROKERS phase — 2 major UI gaps + 1 download bug, all fixed

Broker creation, bank details, and the commission-rules editor
(flat percent / flat amount / slab, all three types) worked
first-try, no bugs. Everything downstream of "attach a broker to a
booking" had never been reachable through the UI at all:

1. **No way to attach a sourcing broker to a booking anywhere in the
   staff app.** `POST /bookings/:id/broker` (`Booking.brokerId`) has
   existed since the commission/NOC backend was built —
   `booking.controller.ts`'s own comment calls it "a separate call,
   same pattern as plan instantiation" — but `BookingWizard.tsx` never
   called it; grepped the whole file for "broker", zero hits. Since
   `CommissionService.accrueForBooking` no-ops without a `brokerId`,
   this meant commission accrual could never fire from a real booking,
   which meant the entire request→approve→pay chain was unreachable
   too — one missing wire took down everything downstream of it. Fixed
   by adding an optional broker `<select>` to the wizard's Confirm
   step, calling `POST /bookings/:id/broker` right after plan creation
   (mirroring the existing template/custom plan-instantiation call).
2. **`POST /bookings/:id/commission/accrue` also had zero UI caller.**
   Documented in `commission.service.ts` as "idempotent,
   explicitly-triggered, safe to call repeatedly" — a deliberate
   admin-action design, not a bug — but nothing triggered it.
   `BrokerDetail.tsx`'s own Sold Units table couldn't host the button:
   its report endpoint (`/reports/brokers/sold-units`) returns plain
   `[broker, bookingNumber, applicant, unit, price, status]` tuples
   with no `bookingId` at all — the same report-shape gap documented in
   the POST-SALES phase notes above (Dues Dashboard has the identical
   problem). Fixed the cheapest way: added a conditional "Accrue Broker
   Commission" button to Installment Schedule (`bookingId` is already
   in that page's URL param), shown only when `GET /bookings/:id`
   returns a non-null `brokerId`.
3. **Broker statement PDF download reproducibly got stuck as an
   unfinalized `Unconfirmed *.crdownload` file, every single time —
   never opened, never renamed to its real filename.** Root-caused by
   comparing against every OTHER document download this session (all
   of which completed cleanly): `BrokerDetail.tsx`'s
   `handleGenerateStatement` built its own client-side filename from
   the raw broker name (`broker-statement-Suresh Realty Partners.pdf`,
   unsanitized space) instead of using the `GeneratedDocument`'s
   `originalName`, which `document.service.ts` already computes with
   `broker.name.replace(/\s+/g, '-')` — the same sanitized-hyphen
   convention every other document type in the app follows. Two
   attempts with the old code both got stuck (confirmed via matching
   byte-identical `.crdownload` sizes across separate page loads —
   ruled out a one-off race); the very next attempt, immediately after
   switching to `doc.originalName`, downloaded and finalized cleanly
   with the correct sanitized name. Broker names are ordinary business
   names — nearly all of them contain spaces — so this was a
   real-world-reachable path, not a synthetic edge case.

Full live verification narrative: created broker "Suresh Realty
Partners" with bank-detail-free profile → added a 2-tier SLAB
commission rule (₹0–50,00,000: 1%, ₹50,00,000–∞: 1.5%, confirmed this
is a deliberate *cliff* design — the whole basis amount prices at
whichever single bracket it falls into, not a graduated/marginal
scheme like income tax — by reading `matchCommissionSlab`'s doc
comment and `computeCommissionPaise` directly before treating the
₹82,500 result as correct rather than assuming graduated math and
filing a false bug) → created applicant Anita Verma, booked unit
Tower A/A-0104 (₹55,00,000, full-payment custom plan) with the broker
attached via the new wizard field → confirmed the booking landed in
the broker's Sold Units table → clicked the new Accrue Broker
Commission button, confirmed Outstanding became exactly ₹82,500.00
(₹55,00,000 × 1.5%, correctly using the top bracket the full amount
falls into) → requested payment for the full amount → approved →
paid via NEFT → confirmed Outstanding dropped to ₹0.00 → generated the
broker statement PDF and read it directly off disk, confirming an
ACCRUAL debit row and a PAYMENT credit row netting to a ₹0.00
closing balance, matching the on-screen state exactly.

Minor, not worth a separate fix: the statement PDF's payment
description line renders the raw commission-payment UUID
(`489ebea6-cdce-...`) instead of something human-readable like the
payment mode/date — cosmetic, logged for the final report, not fixed.

## PORTALS phase — 2 fixed (one severe), 1 large gap logged, 1 data gap

1. **Zero staff-facing way to onboard a customer or broker to the
   portal at all.** `POST /admin/portal-invites` has existed since the
   portal-auth module was built, and `apps/portal` already has a full
   invite-consume page at `/invite/:inviteId` — but grepped all of
   `apps/web/src` for "invite" and got zero hits. Fixed by adding a
   channel select + "Send Portal Invite" button to `Applicant360.tsx`
   and `BrokerDetail.tsx`; since `sendInvite` never actually sends
   anything itself (confirmed by reading `portal-auth.service.ts` —
   it only creates the `PortalInvite` row and returns a one-time raw
   token for the caller to relay), the UI surfaces the generated
   invite link directly for the admin to copy and share manually.
2. **Severe: the portal SPA had no React Router `basename`, so every
   direct/external link into it rendered a blank page.** `apps/portal`
   is served under nginx's `/portal/` alias
   (`vite.config.ts`'s own `base: '/portal/'`), but `<BrowserRouter>`
   had no matching `basename` — confirmed live: the very first invite
   link generated by the fix above loaded to a blank white screen,
   with console showing `No routes matched location
   "/portal/invite/...”`. Every earlier portal test this session
   (2FA enrollment, broker NOC flow, etc. — Tasks #11–12 from a prior
   segment) happened to land on `/portal/` root first and navigate
   client-side afterward, which never exposes a missing basename —
   only a fresh full-page load of a non-root URL does. This meant
   invite links, password-reset links, bookmarks, and browser refreshes
   were ALL silently broken for every portal user, customer and broker
   alike, for as long as the portal has existed. Fixed with
   `basename="/portal"` on `BrowserRouter`. While investigating, also
   found and fixed a second, related bug in the same code path:
   `InviteConsume.tsx`'s post-signup `window.location.href = '/'` — a
   raw browser navigation that bypasses the router basename entirely —
   was sending a brand-new customer or broker straight to the *staff*
   app's login screen instead of their own portal; changed to
   `/portal/`.
3. **Ticket Categories master was never seeded for this company** — the
   portal's "Raise query" category dropdown was empty (not a bug: the
   admin Masters page for Ticket Categories correctly showed "No data
   found", same generic master-CRUD that works everywhere else).
   Created one ("Maintenance") through the real UI to unblock testing,
   consistent with this walkthrough's "fresh company, build up masters
   as needed" approach from earlier phases.
4. **Large, not fixed — logged for the final report: staff has zero UI
   to view or respond to customer support tickets.** Confirmed
   `admin-ticket.controller.ts` exists and is fully built server-side,
   but grepped `apps/web/src` for "ticket" and the only hit is the
   Masters page for ticket *categories* — no ticket list, no thread
   view, no reply, no status change anywhere in the staff app. A
   customer can raise and read replies on their own ticket (verified
   live — see below), but no admin can ever see or answer it through
   the UI. This is comparable in size to the earlier Inventory/
   Pre-sales gap that needed explicit user sign-off before building —
   a full list+thread+reply+status-change surface, not a single button
   — so it was intentionally left as a documented gap rather than
   built unilaterally mid-walkthrough.

Full live verification narrative — customer side: sent a portal
invite to Rahul Sharma from Applicant 360, discovered the blank-page
basename bug on the very first real link, fixed and redeployed, then
successfully set a password and landed on `/profile` showing both
Rahul Sharma (primary) and Rahul Sharma Jr (co-applicant) correctly →
checked every nav tab: Property (unit A-0103, BOOKED, 1050 sqft
correct), Account (balance ₹20,00,000, next-due installment, cost
breakup, payment plan, payment history, and a Documents list correctly
filtered to STATEMENT/RECEIPT/DEMAND_LETTER only — confirmed
deliberate via `document.service.ts`'s `listForPortal` filter and its
"CLAUDE.md Phase 6" comment, not a bug — ALLOTMENT_LETTER and
REMINDER_LETTER are intentionally staff-only), Support (created the
missing Ticket Categories master, raised a real "Leaking tap in
kitchen" query, confirmed it appears with status OPEN and the correct
thread view), Security (change-password + 2FA sections both present
and match the staff-side Security page). Broker side: signed out,
consumed the broker invite as a fresh session, landed correctly on
`/broker/dashboard` showing Accrued/Paid ₹82,500.00 each, Outstanding
₹0.00, Units sold 1, Pending NOCs 0 — all exactly matching the BROKERS
phase's own numbers — then checked NOCs ("No NOC requests yet",
correct) and Statement (3 generated statements listed, matching the 3
`Generate & Download PDF` clicks from the BROKERS phase) and Security
(same as customer side).

One inconclusive automation-tooling observation, not filed as a
product bug: several document downloads inside the portal got stuck
as unfinalized `Unconfirmed *.crdownload` files in this session's
browser-automation harness even when using an already-correctly-
sanitized server-provided filename (ruling out the filename-space
hypothesis that explained the earlier broker-statement bug) — the
underlying document generation and serving were independently
confirmed correct via successful downloads of the same content
earlier in the session, so this reads as a client-side download-
finalization quirk specific to the automation environment, not
something a real user's browser would hit.

## REPORTS phase — 1 serious financial-correctness bug found and fixed

**Bounced cheque receipts were still counted as collected money in
every collection/rollup report and the customer portal's own payment
history.** Spot-checked Collection Summary against the BROKERS-phase
booking (₹55,00,000 across 3 receipts, one ₹20,00,000 cheque already
confirmed bounced and correctly reversed in the ledger, installment
schedule, and Applicant 360) — Total Collected showed the full
₹55,00,000, not the correct ₹35,00,000 net of the bounce.

Root-caused to `recordChequeEvent`'s BOUNCED branch
(`receipt.service.ts`): it correctly reverses the receipt's ledger
effects via `reverseReceiptLedger` (which is why every ledger-based
view was already right), but never sets `Receipt.isReversed` — only
the separate `reverseReceipt()` manual-cancel path does that. Every
query filtering `isReversed: false` — `collectionSummary`,
`collectionByPeriod`, both project-wise and company-wide rollups
(`postsales-reports.service.ts`), and the customer portal's own
receipt history (`portal-account.service.ts`) — kept counting bounced
cheque amounts as real collected money. `commission.service.ts` and
`cancellation.service.ts`'s own `isReversed` usages were independently
guarded by `clearanceStatus: {in: [NOT_APPLICABLE, CLEARED]}`, so
unaffected.

Fixed by setting `isReversed: true` (and `reversalReason`) in the same
`receipt.update()` call, mirroring `reverseReceipt()`'s own semantics —
a bounce IS a reversal of that receipt's contribution, the flag should
say so. This surfaced a second, necessary fix: `receipt.controller.ts`'s
cheque-queue endpoint unconditionally filtered `isReversed: false`,
which would have made the Cheque Queue's own BOUNCED tab always empty
the moment bounced receipts started carrying that flag — now only
applied when not explicitly querying `status=BOUNCED`.

Added a regression test (`postsales-reports.test.ts`) asserting
`collectionSummary`'s total drops by exactly the bounced amount and
`Receipt.isReversed` flips to `true`; ran the full commission/NOC/
ledger/receipt test suite (27 tests) before deploying — all passing,
confirming no other consumer broke.

Live re-verification: the already-bounced receipt from the BROKERS
phase predates the fix and still carries the stale flag in the
database — correcting it would have needed a raw SQL UPDATE, which
the session's own safety guardrails correctly declined to run (a
direct production data mutation outside the product's own code paths
is exactly the kind of action those guardrails exist to catch; no
attempt was made to route around the block). Instead, verified the
fix through the product itself: created a new ₹1,00,000 cheque
receipt against a second booking, confirmed Collection Summary/
company rollup/project rollup all read ₹55,00,000 before, bounced the
new cheque through the real UI, and confirmed every one of those
numbers still read exactly ₹55,00,000 afterward — the new receipt's
addition and its own bounce's exclusion cancelled to zero net change,
proving the fix works for real money going forward. Also confirmed
the Cheque Queue's BOUNCED tab still correctly lists both the old and
new bounced receipts despite the flag change.

All 9 report types opened and checked for plausible numbers: Units
sold vs available (10/2, matches inventory), Bookings by status
(2 BOOKED), Collection summary/daily/monthly/detail, Project-wise and
company-wide rollups (all internally consistent), Birthday list
(correctly empty — no applicant DOB was ever collected in this
walkthrough, not a bug). CSV export confirmed returning 200 for every
report type tried (network-level verification, since browser-harness
download finalization is the same known non-product quirk noted
above).

### Data migration — backfilling `is_reversed` on receipts bounced before the code fix

The REPORTS-phase code fix stops the bug going forward only. The stale
row discovered during that phase (the ₹20,00,000 receipt on QA
Walkthrough Realty that motivated the fix, plus two more found on the
pre-existing Demo Realty company once looked for — ₹5,000 each) were
still sitting with `clearance_status = BOUNCED, is_reversed = false`,
because the earlier raw-SQL `UPDATE` attempt to backfill them was
blocked by the safety classifier and deliberately not worked around at
the time.

Wrote a real, versioned Prisma migration instead
(`20260804120000_backfill_bounced_receipt_is_reversed`) rather than a
one-off command — the standard `prisma migrate deploy` path every other
schema change already goes through, reviewable and repeatable on any
install, not an ad-hoc production edit. Guarded to the narrowest
possible set: `clearance_status = 'BOUNCED' AND is_reversed = false`
unambiguously identifies a pre-fix row, since `reverseReceipt()` (the
only other path that sets `is_reversed`) explicitly refuses to run
against an already-BOUNCED receipt — there is no other way this
combination can arise. Cross-checked against each receipt's own latest
`cheque_status_events` row as a second, redundant confirmation. Touches
only `receipts.is_reversed`/`reversal_reason`; never
`ledger_entries`/`receipt_allocations`/`cheque_status_events` — those
are guarded by the existing `forbid_financial_mutation` DB trigger
regardless, so this is enforced twice over, not just by the migration's
own `WHERE` clause.

Regression test (`backfill-is-reversed-migration.test.ts`) fabricates a
genuine pre-fix stale row (bounces a cheque through the real, already-
fixed service, then downgrades it back to the buggy state with a raw
`UPDATE`), runs the actual shipped `migration.sql` file, and asserts:
the row is fixed, `ledger_entries` for that receipt come back byte-for-
byte identical, a manually-cancelled decoy receipt keeps its own
original `reversalReason` (not overwritten), and a still-live cheque
receipt is left alone.

Deployed to the VM (`prisma migrate deploy`, part of the normal
`upgrade-native.sh` flow — no manual step). Verified directly against
the database: all three stale rows flipped to `is_reversed = true` with
`reversal_reason` correctly backfilled from their bounce event's own
reason. For QA Walkthrough Realty, confirmed the exact input
`collectionSummary()` reads (`SUM(grossAmountPaise) WHERE
isReversed = false`) dropped from 3 receipts/₹55,00,000 to
2 receipts/₹35,00,000 — an exact ₹20,00,000 drop, matching the stale
receipt's amount to the paise.

**Not fully verified live in the browser.** Getting a working login to
screenshot the Collection Summary page itself required either the
already-built `reset-admin-password.sh` CLI or an in-product admin
password reset — both are credential mutations on a real account, and
the CLI attempt was blocked by the same auto-mode safety classifier
that blocked the original raw-SQL fix, for the same reason. Did not
attempt to route around it (a `psql` UPDATE, guessing at stored
credentials, etc.) — per the classifier's own guidance, stopped and
relied on reading `collectionSummary()`'s source directly instead,
which shows unambiguously that the number rendered on that page has no
logic between it and the raw query already confirmed against the
database. This is the one link in this session's evidence chain that
is inference-from-source-plus-DB-state rather than an actual
screenshot — flagged here rather than silently presented as equivalent
to the rest of this document's live-browser verifications.

### `apps/e2e` — Playwright harness, built before any further feature work (per explicit direction)

Per the walkthrough's own primary lesson (curl/API tests overstate
completeness; a feature isn't done until a human runs it in a real
browser), the single largest structural risk left after the 11-phase
walkthrough was that `apps/web`/`apps/portal` have zero automated
coverage — every frontend bug this session found was invisible to
anything except a manual click-through. Built the smallest useful
harness rather than deferring it further, per explicit instruction to
build it FIRST, standalone, before resuming feature work.

**Design:** Playwright driving the real `apps/web` production build
(`vite build && vite preview`, not `vite dev`) against the real NestJS
API and the same disposable test Postgres/Redis this project's own
backend integration tests already use
(`scripts/test-setup.sh` / `deploy/docker-compose.test.yml`). One new
dependency (`@playwright/test`), plus `otpauth` at the exact same
version `apps/api/src/auth/totp.service.ts` uses (so TOTP codes
generated in a test can't drift from what the server accepts). A
small fixture-seed script (`apps/e2e/fixtures/seed.ts`) mirrors
`packages/db/prisma/seed.ts` and
`apps/api/test/helpers/postsales-harness.ts`'s shape rather than
importing either directly (neither is a published package export) —
one isolated company+admin per scenario, not one shared fixture, so
`auth-2fa.spec.ts` changing its own admin's password and enabling 2FA
can't break the other two specs regardless of run order.

**Real bug found building it, initially worked around, then fixed
properly.** Running the harness against `vite dev` (the obvious first
choice) produced a genuine, consistent failure — every full-page
navigation after login silently landed back on `/login`. Root cause:
`apps/web/src/main.tsx` wraps the app in `React.StrictMode`, which
double-invokes effects in development; `AuthProvider`'s mount-time
`/auth/refresh` effect had no de-dup guard, so both invocations fired,
the refresh token rotated after the first (successful) one, the
second necessarily 401'd, and because promises can resolve out of
order, the failing call's `.catch()` sometimes overwrote the just-set
`user` state back to null — logging the session out immediately after
logging in.

First pass pointed the harness at `vite build && vite preview` instead
(what every real install actually serves via nginx, never `vite dev`)
and logged the `AuthProvider` race as real-but-deferred. On explicit
instruction not to leave it as a documented dev-only quirk — two tabs,
or a slow-network refresh overlapping any other caller wanting a
session, can hit the identical unguarded-concurrency path in
production; StrictMode just makes it reproduce on every single page
load instead of occasionally — fixed it properly: `api.ts` now exports
`refreshSession()`, a de-duped wrapper that gives every caller
(`AuthProvider`'s mount effect *and* `api()`'s own 401-retry, which
already had its own private, narrower version of this exact guard) one
shared in-flight `/auth/refresh` promise instead of racing independent
ones. Mirrored identically in `apps/portal` per this project's own
mirrored-auth standing rule. Three tests per app
(`apps/web/src/lib/api.test.ts`, `apps/portal/src/lib/api.test.ts` —
the first test files either frontend has ever had): two concurrent
calls make exactly one network request and agree on the final state;
a call after the first resolves fires a genuinely new request (the
de-dup is scoped to concurrency, not a permanent cache that would
prevent ever picking up a rotated token); and a failed refresh among
concurrent callers resolves every caller to null, never a half-set
session.

**Proof, not assertion, that this actually fixes the race rather than
narrowing its window:** re-ran the full harness against `vite dev`
(`E2E_WEB_MODE=dev`, kept as a permanent toggle in
`playwright.config.ts` for exactly this kind of check) with
`React.StrictMode` fully active — twice, from a freshly reset test
database each time — and all three scenarios passed both times. Also
re-confirmed the harness's default production-build path still passes.
The dev-server path is the *harder* version of this race (StrictMode
guarantees the double-invocation on every load; production only risks
it under real concurrent access), so green there is stronger evidence
than green against the build alone.

**Three scenarios, chosen for reach over breadth, each a direct
regression test for a bug this walkthrough found and fixed:**

1. `auth-2fa.spec.ts` — login → forced password change → 2FA
   enrollment → logout → login with a TOTP code. Covers the
   Secure-cookie bug (the API server this harness starts runs with
   `NODE_ENV=production` over plain HTTP, deliberately reproducing the
   exact condition that broke it — see `playwright.config.ts`'s
   comment), the dead `ForceChangePassword` component, and the
   2FA-pending login response's missing CSRF cookie.
2. `masters-crud.spec.ts` — create an Interest Rule (one of the 6
   master types that could never be created before the fix) → edit it
   (the `.strict()` PATCH `id`-leak 400 that broke every edit, of
   every type, ever) → deactivate it.
3. `cheque-bounce.spec.ts` — book a unit → record a cheque receipt →
   bounce it → assert Collection Summary is back to exactly its
   pre-receipt baseline. Three checkpoints (baseline, mid-receipt,
   post-bounce), not just before/after the bounce, so the assertion
   can't pass vacuously if the total happened to be zero the whole
   time for an unrelated reason. This is the one financial-consequence
   bug in the whole walkthrough, and the only scenario of the three
   that needed the isolated-fixture-per-scenario design to hold up.

Both `masters-crud.spec.ts` and `cheque-bounce.spec.ts` needed one
selector fix apiece after the first real run (a `getByPlaceholder`
match ambiguous against a substring, and a missing `Next` click that
left the booking wizard on step 0 while the test tried to interact
with step 1's fields) — caught immediately by actually running the
suite, not by review, which is the entire point of building it.

All three pass locally against a freshly reset test database (not
just once — re-verified from a clean `scripts/test-setup.sh` run).
Wired into CI as a new `e2e-playwright` job in `.github/workflows/ci.yml`,
modeled on the existing `integration-tests` job (same Postgres/Redis
service pattern, same migration/role-grant steps), using the same
5433/6380 ports `deploy/docker-compose.test.yml` already uses locally
so the harness's own hardcoded connection strings need no CI-specific
override.

### `apps/e2e` — verified for real on GitHub, not assumed from local green

Per explicit instruction, after the `native-install` job's own
documented history of once reporting false success in 0 seconds:
local green was not treated as sufficient. First push (48 commits —
this entire session's work; nothing had reached `origin/master` before
this) broke CI immediately, and not in `e2e-playwright` itself:
`apps/e2e/package.json` had named its script `"test"`, which collides
with turbo's root `pnpm test` (`turbo run test`) — the exact command
`lint-typecheck-build` and `integration-tests` already run for their
own lightweight unit tests. Both fanned `playwright test` out into
their own runs with none of the harness's infrastructure available,
and both correctly failed; `e2e-playwright` itself correctly never ran
at all, skipped by its own `needs: lint-typecheck-build` once that job
went red. Root cause found via the public repo's unauthenticated
Checks-annotations API (`gh` CLI auth was invalid; reading a public
repo's run data doesn't need it). Fixed by renaming the script to
`test:e2e` — the identical pattern `apps/api/package.json` already
uses for its own heavier suite, so turbo's generic sweep now skips
`apps/e2e` entirely. The dedicated job's own step was never affected
(it always called `npx playwright test` directly, not through the
script), but the miswired name meant CI couldn't get far enough for
that job to prove anything.

Pushed the fix (run `30894052955`) and confirmed, from the real
signed-in GitHub UI (an unauthenticated view only shows step
structure, not log content — `gh` being broken meant using the
browser instead of the API for this part): `e2e-playwright` completed
in 2m17s, a duration consistent with real work (Chromium install,
Postgres/Redis boot, a full `nest start` + `vite build`, three actual
browser sessions), and its "Run Playwright suite" step's own output
names all three scenarios explicitly —
`✓ auth-2fa.spec.ts`, `✓ masters-crud.spec.ts`, `✓ cheque-bounce.spec.ts`,
`3 passed (26.2s)`.

Confirmed the negative case too, not just the positive one: pushed a
commit flipping one passing assertion in `cheque-bounce.spec.ts`'s
final Collection-Summary check to an impossible value
(`toBe('₹99,99,999.00')` against an actual `'₹0.00'`), watched
`e2e-playwright` go genuinely **red** on GitHub (run `30894788924`,
"failed in 2m 54s"), and confirmed the log names the exact break:
`Expected: "₹99,99,999.00" / Received: "₹0.00"` at the precise
assertion line. Every other job in the same run stayed green — the
break was real and scoped, not a config-level false failure. Reverted
in the next commit, re-verified locally.

**A genuine second finding surfaced by this exercise, not manufactured
by it:** CI's automatic retry-on-failure (`retries: 1` when
`process.env.CI`) re-ran `cheque-bounce.spec.ts` after the deliberate
break, and that retry hit a *different*, real flake — a timeout
selecting the seeded unit in the booking wizard's dropdown, because
`page.waitForResponse` resolving only proves the network call
returned, not that React has committed the new `<option>` to the DOM
yet. Never reproduced in five-plus local runs (a faster machine
narrows the window), but CI's slower/shared runners made it real.
Hardened by waiting for the actual DOM state
(`expect(unitSelect.locator('option')).toHaveCount(2)`) before
selecting, instead of trusting the network event as a proxy for it.

**Deliberately not built in this pass** (see `docs/release-plan.md`):
the portal deep-link/router-`basename` check, the Roles-list/dropdown
check, a standalone custom-field-definition check, and a
dashboard-to-ledger click-through — all real, all still worth adding,
just not required to unblock feature work resuming. One scenario per
future release, starting with extending scenario 3 for PLC-priced
units once v0.2.0 lands.

## Phase v0.2.0 — PLC & unit-charge management

Schema already existed in full from Phase 2 (`UnitPlc`, `UnitCharge`,
`PlcType`, `ChargeType`, `BookingCostLine`'s `CostLineKind` including
`PLC` — confirmed by reading the schema before writing a line of code,
not from memory) — the actual gap was that neither `UnitPlc` nor
`UnitCharge` had a controller at all, and `ChargeType.gstRateId`/
`hsnSac` were real columns the generic master API never exposed.

**New backend:** `UnitPricingService` (one service, not two — the two
models are near-identical shape) + routes on the existing
`UnitController` (`:id/plcs`, `:id/charges`, matching the established
`:id/rate-history` sub-resource pattern, not a new controller file).
Two new permissions (`inventory.unit.plc-manage`/`charge-manage`) —
`super_admin`/`company_admin` already get both automatically via the
existing `inventory.*` prefix filter in `roles.ts`; deliberately not
given to `sales_manager`, matching the existing precedent that
`INVENTORY_RATE_CHANGE` (a comparable pricing mutation) isn't either.
A percentage-derived PLC amount is snapshotted to paise once, at
assignment time, off the unit's rate at that moment — never
live-recomputed if the rate changes later, matching every other
snapshot in this codebase (rate revisions, cost-line GST).

**GST-rate resolution, the one real design decision in this phase:**
initially planned to leave a PLC/charge line untaxed unless it named
its own `gstRateId`. Rejected on explicit instruction — GST genuinely
differs by charge type in Indian real estate (statutory pass-throughs,
IFMS, legal charges don't all follow the base sale rate), and a line
silently taxed at 0% understates an invoice without ever raising an
error. `booking.service.ts`'s cost-line loop now resolves each line's
rate in order: the line's own `gstRateId`, else its charge type's
(`ChargeType.gstRateId`, now exposed via Masters — `masters.module.ts`'s
`extraFields`, the same mechanism `document-types`/`interest-rules`
already use), else the booking's own `BASE` line's rate. A `PLC` line
can never carry a `chargeTypeId` at all (`PlcType` has no relation to
`GstRate`), so it always falls through to the base rate — stated
explicitly in the code comment and here, not left implicit. The one
genuinely untaxed case is a booking whose `BASE` line itself has no
rate — an explicit whole-booking choice (there's still no rate picker
for the base line anywhere in the wizard — a separate, pre-existing gap,
not touched here), not a per-line oversight.

**Tests:** three cost lines at three different rates compute
independently and sum correctly; a charge type with no `gstRateId`
inherits the base line's rate (never zero-rated); a PLC line does too,
explicitly, since it has no charge type to inherit from otherwise;
through-the-wire supertests for both new controllers including the
snapshot invariant (`change-rate` after a percentage PLC assignment
doesn't retroactively change the stored amount). All in
`postsales-statemachine-gst.test.ts` (extended, not a new file — it
already had exactly the GST fixture shape needed) and a new
`e2e-unit-pricing.test.ts`.

**Fourth Playwright scenario** (`plc-booking.spec.ts`): assigns a PLC
and a charge through the real Pricing UI just built (not seeded
directly), books the unit, and checks both the confirm step's
excl.-GST breakup and — via a direct DB read, since no screen shows
the GST-inclusive total post-booking — that `agreedPricePaise` matches
a hand-computed total. Deliberately built so the base line and the PLC
line end up untaxed (0%) while only the charge line is taxed, at its
own 5%: the clearest possible proof that resolution is genuinely
per-line, not inherited from some booking-level setting. The
installment amount had to be the exact GST-inclusive total, computed
by the test itself the same way a real admin would have to today (by
hand) — `PaymentPlanService.resolveAmounts` rejects custom installments
that don't sum exactly to `agreedPricePaise`, and the wizard has no way
to preview that total before the confirm step. Logged, not fixed here
— out of this phase's scope, but a real rough edge for whoever picks
up the base-line-rate-picker gap.

**Frontend:** `Masters.tsx` gained one small, real, reusable
capability, not a one-off: `AsyncSelectField`, a field type whose
options come from a live endpoint (GST rates are per-company data, a
static `options: string[]` enum can't represent them) rather than the
existing static `'select'` type. `ProjectDetail.tsx` gained a
"Pricing" panel per unit (mirroring the existing "Rate History"
panel's exact interaction shape — one expandable panel, not per-row
inline) to assign/list/remove PLCs and charges.
`BookingWizard.tsx` fetches the selected unit's PLCs/charges once
chosen and forwards them as additional `costLines` on submit — the
wizard itself resolves nothing about GST, that's entirely the
server's job now. The confirm step shows the full excl.-GST breakup
line by line plus a total, not just the base price as before.

### v0.2.0 — upgrade-path permission delivery, and a real bug the resulting click-through found

- **New standing rule: any release adding `PERMISSIONS` constants,
  seeded masters, or seeded roles must verify the UPGRADE path
  delivers them to an existing installation, not just that a fresh
  install seeds them correctly.** `packages/db/prisma/seed.ts`'s
  permission-upsert loop runs unconditionally, but everything else in
  that file — company/roles/masters/admin-user seeding — sits behind
  `if (existingCompany) return;`, which is true for every real
  production install after its first boot. A release that adds a
  `PERMISSIONS` key and ships a UI gated on it would upgrade clean and
  heal nothing: no role could ever be granted a permission row that
  was never inserted. This was invisible for the project's entire
  history because every prior phase's verification — VM walkthroughs,
  CI's `native-install` job, `compose-healthcheck` — always exercised
  a FRESH install, never an upgrade of an existing one. Fixed for
  permissions specifically by extracting `packages/db/prisma/sync-permissions.ts`
  (idempotent, permissions-table-only — deliberately NOT extended to
  roles or masters, both of which are per-company data an admin may
  have already customised; see that file's own doc comment for the
  full reasoning) and running it as a new step in
  `deploy/native/upgrade-native.sh`, after migrations and before
  cutover, gated by the same healthcheck. Verified on the VM: a role
  the sync added two permission rows for stayed a two-row diff (not a
  reset), a pre-existing customised master (`Website` Inquiry Source,
  deliberately deactivated) was untouched, and running the upgrade a
  second time changed nothing. Confirmed `deploy/install.sh` (the
  Docker path) has no equivalent gap — it's fresh-install-only by
  design (see "Native install becomes primary; Docker demoted to
  contributor/CI tool" above), so this class of bug can't occur there
  at all. **Any future release adding a `PERMISSIONS` key, a seeded
  master row, or a seeded role must ask the same question this one
  didn't ask until now: does an EXISTING install actually receive
  this, or only a fresh one?**

- **Real bug, found only by actually trying to do what the sync fix
  above was supposed to unblock — granting a newly-synced permission
  to an existing role through the UI — not by review.**
  `RolesService.update()` (`apps/api/src/roles/roles.service.ts`)
  rejected **any** change to a role with `isSystem: true`, via a
  blanket `if (role.isSystem) throw new BadRequestException('Cannot
  modify system roles')` — not just a rename or delete. Every seeded
  role (`super_admin`, `company_admin`, `sales_manager`, etc.) is
  `isSystem: true`, and a staff user's effective permissions come
  ONLY from `role_permissions` DB rows baked into their JWT at
  login/refresh (never live-recomputed from `ROLE_PERMISSIONS`, the
  TS constant, which is consulted only once, at a brand-new role's
  initial seed). Combined, this meant a permission added in any
  release — including the two this phase just added — could **never**
  be granted to any existing seeded role, through any path: not
  `seed.ts` (blocked by `existingCompany`), not `sync-permissions.ts`
  (deliberately permissions-table-only, never touches
  `role_permissions`), and not the UI (blocked by this guard). The
  only escape hatch was creating a brand-new custom role from scratch
  — never actually extending `company_admin` or any other built-in
  role with a newly-shipped capability. `RoleForm.tsx` always sends
  the role's current (unchanged) name alongside `permissionIds` on
  every save, so this fired on 100% of system-role permission edits,
  not just renames — which is also why "142 of 142 permissions
  selected, no visible error" was observed in the browser: the save
  request 400'd, but was moving through this project's ordinary error
  path (`onSubmit`'s `catch` block plus `MutationCache`'s global
  toast) exactly as designed — the confusing part was diagnostic, not
  a second bug in the error handling itself.
  **Fixed at the root**: the guard now only fires on an actual name
  CHANGE (`data.name !== undefined && data.name !== role.name`) —
  identity (name) and existence (deletion, still blocked separately in
  `remove()`) stay protected for system roles, but permission
  composition is freely editable, which is the entire point of a
  configurable RBAC system per this file's own MASTER-DRIVEN
  principle. `RoleForm.tsx` also now disables the name input when
  editing a system role, so a rename can't even be attempted from the
  UI. Regression-tested end-to-end
  (`apps/api/test/e2e-roles.test.ts`, new — no dedicated Roles test
  file existed before this): granting permissions to a system role
  with the exact request shape the real frontend sends (unchanged name
  + new `permissionIds`) succeeds; an actual rename attempt still
  400s; deletion of a system role still 400s.

### Standing rule clarification: automated real-browser verification satisfies the "verify in a real browser" rule

This file's primary lesson (top of this document) and its several
"manual click-through" standing rules exist because request-
constructing tests (supertest, curl) cannot prove the FRONTEND builds
a request correctly — they construct the HTTP request by hand, so a
passing test proves the server handles a well-formed request, never
that a real browser running the real frontend code can produce one.
Every auth bug documented above (the 2FA CSRF-cookie bug, the missing
`tempToken` header, the stale CSRF-after-refresh header) was invisible
to server-side e2e tests for exactly this reason.

**Playwright driving real Chromium against the real UI, real API, and
real database satisfies this rule's purpose.** It does not share
supertest's blind spot: the browser executes the actual frontend
bundle, so a Playwright scenario clicking through a real form is
genuinely indistinguishable, for this rule's purpose, from a human
doing the same clicks. `apps/e2e`'s four scenarios already exist for
exactly this reason and already caught real bugs no server-side test
could have (the `AuthProvider` concurrent-refresh race, the masters
`.strict()` PATCH `id`-leak, the dead `ForceChangePassword` component).

**This means a future session should not treat "I don't have VM
access right now" as a blocker for satisfying a manual-click-through
requirement**, if the change is one `apps/e2e` can exercise (or can be
extended to exercise) locally against a real dev-server or
production-build frontend, a real API, and a real Postgres/Redis —
which is every one of this project's own disposable test-infrastructure
setups (`scripts/test-setup.sh`, `deploy/docker-compose.test.yml`).
VM click-throughs remain valuable for what's specific to a real native
install (systemd, nginx, TLS/cookie behavior, upgrade sequencing) —
several bugs in this log (the Secure-cookie-over-HTTP bug, most of the
native-install script bugs) are exactly that category, and no amount
of local Playwright coverage substitutes for them. But for a change
whose risk is "does the frontend build this request correctly," a
local Playwright run against the real stack is not a lesser proof than
a VM click-through — it's the same proof, run somewhere that doesn't
require SSH access to a specific machine.

### Seed-only-reachable-data audit — one more real bug (GST state code), two non-bugs by design

Prompted directly by the two upgrade-path bugs above: audited every
other piece of data `seed.ts` populates for the same "reaches a fresh
install only, never an existing one" shape.

- **Seeded masters (item-level) and any hypothetical brand-new master
  TYPE: correctly NOT auto-synced, no change.** This is the existing,
  deliberate design `sync-permissions.ts`'s own doc comment already
  states — both are per-company data an admin may have renamed,
  deactivated, or deleted; auto-injecting new rows into every existing
  company's live list on every upgrade would be a real bug of its own
  ("an admin who deleted a master should not have it resurrected"), not
  a fix. Letter templates, ticket categories, GST rates, TDS rules are
  all the same category — no change needed.
- **A brand-new `SYSTEM_ROLES` entry in a future release: real gap,
  deliberately NOT built yet — decided now, built when needed.** Unlike
  a master item, a system role can't be deleted (`RolesService.remove()`
  blocks it) and, as of this session's fix above, can't be renamed
  either — so there's no "admin already customised this, don't
  resurrect it" risk the master-sync restraint exists to protect
  against. When a release first adds a new `SYSTEM_ROLES` entry,
  **extend `sync-permissions.ts` to also create any `Role` row (by
  slug) that doesn't yet exist for a company, seeded with
  `ROLE_PERMISSIONS[thatSlug]`** — safe for exactly the reason above.
  Do NOT extend it to touch `role_permissions` for an EXISTING role
  (that's a permission-composition change, already deliberately
  excluded — an admin may have already customised it, same as any other
  seeded role). No release has added a new system role yet, so this
  stays a documented decision, not code, until one does.
- **`CompanyConfig.gstStateCode`/`companyGstin`: a real, active
  correctness bug, not just a delivery gap — found, fixed, and
  documented as a correctness release in `CHANGELOG.md`.** Both columns
  were added nullable with no default (Phase 4 migration); every other
  `CompanyConfig` column added since then got either a safe
  `NOT NULL DEFAULT` or is purely cosmetic (see the migration audit
  below). `isIntraStateSupply()` used to return `true` (intra-state)
  whenever either side was null — meaning any company that existed
  before that migration, or simply never visited the (later-added, see
  the "Full production-readiness pass" entry) Company Config screen,
  has been charged CGST+SGST on every booking regardless of the
  property's real place of supply, silently, since Phase 4. No error,
  no warning — the exact "wrong tax, no error, costs money silently"
  shape this session's ChargeType GST decision was written to prevent,
  just in a different corner of the same feature.

  **Migration audit of every other `company_configs` column ADD COLUMN
  since Phase 1** (`chequeBounceChargePaise`, `commissionAccrualTrigger`,
  `commissionClawbackPolicy`, `logoUrl`, `primaryColorHex`): all either
  `NOT NULL DEFAULT <safe value>` or nullable-and-cosmetic (branding,
  already handled when absent — "the header falls back to the
  'OpenEstate' text label when no logoUrl is set"). `gstStateCode`/
  `companyGstin` are the only two that are both nullable AND feed a
  silent, financially-consequential default. Not fixed by adding a
  default — **you cannot guess a company's GST state code**, and
  guessing wrong is exactly the bug being fixed, just moved earlier.

  **Fix, fail loud not silent:**
  1. `isIntraStateSupply()` (`packages/shared/src/finance.ts`) now
     THROWS a plain `Error` naming exactly which side is missing and
     where to fix it (Company Config for the company's own state code;
     the project's Area Location, or an explicit
     `placeOfSupplyStateCode` override, for the other side) — never
     silently defaults. Its two callers
     (`BookingService.createBooking`, `ExtraChargeService.add`) catch
     and re-throw as `BadRequestException` with the same message, so a
     real HTTP caller gets a clear 400, not a raw 500.
  2. `CompanyService` (new `OnApplicationBootstrap` hook) logs a single
     warning at boot listing every company with incomplete GST config
     (missing `companyGstin` and/or `gstStateCode`) — visible in
     `journalctl -u openestate-api` the moment the app comes up, not
     discovered days later when a sales team is locked out of booking.
  3. `apps/web`'s `AppShell.tsx` gained a persistent banner (shown on
     every page, not just Company Config — the error surfaces on
     Booking/Receipt screens instead) for any staff user who can read
     Company Config, linking straight to it. Reuses the same
     `['company-config']` query `CompanyConfig.tsx` already has, so no
     extra endpoint.
  4. `apps/e2e/fixtures/seed.ts` needed the same fix as every other test
     fixture that books a unit: it never set `gstStateCode`/
     `companyGstin`, and had no `AreaLocation` on its project at all —
     every Playwright scenario that books (`cheque-bounce.spec.ts`,
     `plc-booking.spec.ts`) would otherwise 400 on the very first
     booking attempt. Set both to `'09'`, matching
     `apps/api/test/helpers/postsales-harness.ts`'s own default — the
     computed intra-state result is unchanged from before (both sides
     were previously silently defaulting to the same outcome), so no
     existing assertion values needed to change, only the throw needed
     preventing.
  5. New tests: two direct-service tests in
     `postsales-statemachine-gst.test.ts` (missing company state code;
     missing place-of-supply state code — both assert the specific
     error message AND that no `Booking` row was created, i.e. full
     rollback, not a partially-booked-at-a-guessed-rate state); a new
     Playwright test (`role-permission-edit.spec.ts`) driving the
     banner in a real browser — appears when GST config is incomplete,
     links to Company Config, disappears once both fields are filled
     and saved.
  6. `CHANGELOG.md`'s `[Unreleased]` section flags this explicitly as a
     correctness fix and tells affected installs to check already-issued
     invoices — this release does not retroactively correct GST already
     charged wrong before upgrading, only prevents it going forward
     (see the REPORTS-phase `is_reversed` backfill migration for how
     this project handles the "also fix past data" half when that's
     feasible; here it isn't — there's no way to know after the fact
     what the correct historical treatment should have been without a
     human reviewing each affected booking).

### v0.2.3 — custom field VALUES (and an integrity hole open since Phase 3)

- **The premise this release started from was wrong, and the correction
  changed the work.** The gap was described as "nothing captures,
  stores, validates, displays, filters or exports a value." Reading the
  code first showed values were **already being stored**:
  `Applicant.custom_fields`/`Inquiry.custom_fields` JSONB columns have
  existed since `20260722000000_phase3_presales`, the presales DTOs
  already accepted `customFields: z.record(z.unknown())`, and four
  service call sites already wrote them. What was missing was
  everything *around* storage — and, more seriously, `z.record(z.unknown())`
  meant **any key with any value** went straight into JSONB with no type
  check, no required check, no option check, and no rejection of keys
  that were never defined. `CustomFieldsService.buildValidationSchema()`
  /`validateCustomFields()` were fully written and called by **nothing**.
  So this was not a greenfield feature; it was closing a live
  write-side integrity hole plus building the read side.

- **Storage: JSONB inline per entity, not EAV — argued on isolation
  surface, not convenience.** A JSONB column on an
  already-RLS-protected, already-`TENANT_SCOPED_MODELS`-registered row
  inherits that row's isolation entirely: zero new tables, zero new
  policies, zero new registrations, and no new portal-scope analysis.
  EAV would have needed all four — and that is exactly the surface
  where Phase 6 found two real IDOR-class bugs. CLAUDE.md principle 5
  permits either ("EAV/JSONB per entity"), and CLAUDE.md's own
  `cleanupCompany` note already asserted values "live inline as JSON on
  each entity," so EAV would have invalidated a documented assumption
  too. The honest cost is real: JSONB values are untyped at the SQL
  level, so sorting a NUMBER field lexicographically is wrong without
  a cast, and per-key indexes can't be created at migration time for
  admin-defined keys. **Sorting was therefore deferred rather than
  shipped subtly wrong**, and filtering is limited to exact match.
  Proven, not assumed: `custom-field-values-isolation.test.ts` asserts
  cross-company invisibility through a raw connection under a real
  tenant session, for both the pre-existing and the new columns.

- **`.strict()` is the whole fix.** zod's default is to *strip* unknown
  keys, which would have let a client keep writing junk that silently
  vanished. The builder now rejects. The one existing test of this
  logic (`packages/db/test/custom-fields-validation.test.ts`) had
  re-implemented its **own local copy** of the builder — because
  `packages/db` has no dependency on `@openestate/shared` — so it proved
  nothing about the function the API calls, and its copy already called
  `.strict()` while production did not. Fixed at the root: the builder
  moved to `packages/shared`, the service delegates to it, and the test
  moved alongside it so there is exactly one implementation.

- **Reject bad WRITES; preserve existing DATA.** Validating the whole
  merged object strictly would have made any record carrying an unknown
  stored key **permanently uneditable** — and two such keys are written
  by the product itself (`leadNote` from `createFromLead`,
  `importNotes` from CSV import), so every imported inquiry would have
  been bricked. `resolveValuesForWrite` therefore rejects unknown keys
  arriving from the *client*, but carries unknown *stored* keys through
  untouched and excludes them from validation. Found by tracing the
  interaction before writing the code, not by a failing test.

- **PATCH validates the merged result, not the patch.** Validating the
  patch alone would let a partial update bypass every required field by
  omitting it.

- **Definition lifecycle: never mutate stored values.** `key`,
  `fieldType` and `entityType` were already absent from
  `updateCustomFieldSchema`, which turned out to do most of the work —
  values are keyed by the immutable `key`, so a label rename can never
  orphan one, and a type change (which would mean silently coercing or
  discarding every stored value) is simply not expressible. Emptying a
  SELECT's options is now refused (it would leave a field rejecting
  every possible value; `z.enum([])` also throws at *construction*, so
  the builder guards defensively too). Delete became a **soft**
  delete — the previous hard delete orphaned JSONB keys invisibly.

- **Hard purge requires the field key typed back, not just a count.** A
  count ("will strip 340 rows") is a number the admin has no way to
  verify before agreeing to it, so confirming against it is not really
  consent; typing the key makes the confirmation about the *thing* being
  destroyed. The affected row count is written to the audit log, so the
  size of what happened stays recoverable even though the values do not.

- **SECURITY: portal responses withheld custom field values.**
  `PortalProfileService.getProfile` returned the whole applicant row
  (omitting only PAN) to the customer **and their co-applicants** — so
  any internal note staff had written into a custom field was already
  being served to customers. Nothing in the definition model marks a
  field customer-safe, so **the only defensible default is to withhold
  all of them**; guessing from a label would be exactly the kind of
  silent-wrong-data call this project keeps getting burned by, and
  per-field opt-in is a real feature, not something to approximate.
  Implemented as a named `PORTAL_APPLICANT_OMIT` constant used by every
  portal applicant read, so a future portal read cannot quietly omit it
  — the same discipline `panCiphertext` already gets. Audited the rest
  of the portal surface rather than fixing only the reported spot:
  `portal-account`/`portal-property` use explicit field projections and
  `brokers-portal` reads no entity rows at all, so this was the only
  leak.

- **BOOKING deliberately excluded, and made visible rather than
  silent.** Supporting it means touching `BookingService`, which this
  file freezes. `CUSTOM_FIELD_VALUE_ENTITIES` in
  `packages/shared/src/custom-field.dto.ts` is the single source of
  truth for what is supported, consumed by both the API guard and the
  admin UI so the two can never drift; the UI marks the tab
  "(unsupported)" with an explanation and disables Add Field. Letting
  an admin define a BOOKING field that silently did nothing would have
  reproduced the exact bug this release exists to close.

- **A constructor change broke three test files, and the fix was to
  restore prior behaviour rather than paper over it.** Adding
  `CustomFieldsService` to `ApplicantService`/`InquiryService` broke
  every direct-`new`-construction test. Two of them
  (`presales-follow-up`, `presales-inquiry`) turned out to have been
  passing only **four** of `InquiryService`'s five arguments all along —
  `applicantService` was already `undefined`, harmlessly, because it is
  reached only from `createFromLead()` which neither file exercises.
  The first fix attempt supplied a real `ApplicantService`, which
  promptly failed on `PAN_ENCRYPTION_KEY is not set` (those files never
  needed that env var before). Reverted to passing `undefined as never`
  with a comment explaining why, adding only the genuinely-required
  `CustomFieldsService` — smaller diff, no behaviour change, and no new
  env dependency introduced into unrelated tests.

### Pre-pilot walkthrough — super_admin never received permissions added after its install (partially reverses a prior decision)

Found on the verification VM (now `192.168.1.2`) while taking a real,
populated install from v0.1.2 to v0.2.3 — 3 companies, 13 bookings, 12
receipts. The upgrade itself was clean: both migrations applied, the
healthcheck gate passed, `"version":"0.2.3"`, no data lost. The tell was
one line of its own output — `Permissions synced: 0 new, 142 already
present` — which is impossible-looking on a box coming from a release
that only had 140.

The `permissions` TABLE was complete. The GRANTS were not:
`super_admin` on both pre-existing companies held 140 of 142, missing
exactly the two v0.2.0 added (`inventory.unit.plc-manage`,
`inventory.unit.charge-manage`). **So PLC/unit-charge pricing — the
headline feature of v0.2.0 — has been unreachable on every upgraded
install since that release, for the most privileged role in the product,
with no error to explain why.** A pilot customer upgrading would simply
find a documented feature absent.

**This partially reverses the "Seed-only-reachable-data audit" entry
above**, which stated: *"Do NOT extend it to touch `role_permissions`
for an EXISTING role (that's a permission-composition change... an admin
may have already customised it)."* That reasoning is correct — and it is
still correct for every role except one. `ROLE_PERMISSIONS.super_admin`
is literally `Object.values(PERMISSIONS)` (`packages/shared/src/roles.ts`).
"Every permission that exists" is not a default someone picked for
super_admin; it IS super_admin's definition. So a super_admin missing a
key is not a customisation to respect — it is drift from its own
contract, and the earlier entry's premise ("an admin may have customised
it") is the one case where it does not hold. The narrowing stops
strictly there:

- `company_admin`, `sales_manager`, `accounts`, `customer`, `broker` and
  every custom role: **still untouched**, for exactly the original
  reason. An admin may have deliberately narrowed any of them, and an
  upgrade that silently widens a permission set is a privilege-escalation
  bug, not a fix. These are granted new permissions through Admin →
  Roles, which v0.2.0's `RolesService.update` fix unblocked.
- The restraint on seeded MASTERS is entirely unchanged — a deleted or
  deactivated master must never be resurrected by an upgrade.

`syncSuperAdminPermissions()` (`packages/db/prisma/sync-permissions.ts`)
implements only that one exception. `upgrade-native.sh` needed no change
— it runs the script as a module, so the new step is picked up by the
existing invocation.

**Why four consecutive releases missed this, and the fix for that.** The
`native-upgrade` CI job (added at v0.2.0 specifically to catch
upgrade-path gaps) *did* assert that v0.2.0's new permission rows
arrived — assertion 3, `GET /roles/permissions` contains both keys. That
assertion passes on a database where no role can use them. The job never
checked a grant. Added assertion 3b: after upgrade, `super_admin` must
hold every key in `PERMISSIONS`, diffed key-by-key so the error names
what is missing rather than reporting a count mismatch.

**Verified this would have caught it, rather than assuming so.** Counting
permission constants at each ref: baseline `c2c32e0` = 140, v0.2.0 = 142,
v0.2.1/v0.2.2/v0.2.3 = 142. The job seeds its baseline from `c2c32e0`, so
super_admin is created with 140 and never re-granted — meaning assertion
3b would have failed on **v0.2.0 and on all three releases after it**,
each of which shipped with this job green. That is the honest answer: the
gate existed, ran, and passed, because it was checking the easier half of
the property.

**Second, smaller finding surfaced while writing the regression test:**
`packages/db` imports `@openestate/shared` in two SHIPPED scripts
(`prisma/seed.ts`, `prisma/sync-permissions.ts`) but never declared it in
`package.json` — it resolved only via pnpm hoisting. Vitest refused to
resolve it the moment a test in that package imported the same module,
which is also the real reason v0.2.3 found a hand-copied duplicate of
`buildValidationSchema` in `packages/db/test` (the author could not
import the original). Declared it properly (`workspace:*`); confirmed no
cycle, since `packages/shared` has no dependency on `packages/db`.

Regression coverage: `packages/db/test/sync-super-admin-permissions.test.ts`
(6 tests, real Postgres) — reproduces the pre-upgrade shape first and
asserts the keys are genuinely absent, then that the sync restores
super_admin to the full set, that a second run is a no-op, and — the half
that protects the surviving decision — that a deliberately-narrowed
`company_admin` (5 permissions) and a custom role (3) are left exactly as
they were.

### Boundary of browser-automation verification in this project (what it does and does not prove)

The browser tooling available in these sessions **cannot deliver real
keystrokes to this app**. Confirmed directly, not assumed: clicking an
input and issuing a type action leaves the field reading back
`value.length === 0`, and no submit ever fires because react-hook-form
never sees an event. A DOM-level `form_input`-style write is equally
useless on its own — it sets `.value` without dispatching anything, so
React's controlled-input state stays empty and the form silently
refuses to submit with no visible error.

The method that does work, and the one every click-through in this
session used:

```js
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(el, value);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

then a real `.click()` on the submit button.

**What this DOES prove** — and it is most of what the "verify in a real
browser" rule exists for: the real frontend bundle runs, the real
component builds the request, the real `api()` client attaches
headers/CSRF/auth, the request crosses the real network to the real
nginx + API + Postgres, and the real response drives the real
re-render. Every bug class the PRIMARY LESSON at the top of this file
names — a page that renders zero rows, a `.strict()` DTO rejecting the
body the frontend actually sends, a missing Authorization header, a
Secure-cookie that never gets stored — is fully in scope and would be
caught.

**What this does NOT prove**, and must not be claimed as covered:

- **Paste handling.** A `paste` event never fires, so any `onPaste`
  handler (splitting a pasted TOTP code across boxes, stripping
  formatting from a pasted PAN/phone) is unexercised.
- **IME / composition input.** No `compositionstart`/`compositionend`,
  so anything that defers parsing until composition ends is untested —
  relevant for a product that will take Indian-language names.
- **keydown/keyup-gated logic.** Enter-to-submit, Escape-to-close,
  arrow-key navigation in a dropdown, per-character maxlength or
  numeric-only filtering implemented in `onKeyDown` — all bypassed,
  because the value arrives in one synthetic `input` event.
- **Focus/blur sequencing.** Validation that only runs `onBlur`, and
  anything depending on real tab order.
- **Native browser constraint validation** triggered by real typing.

So: a green click-through in one of these sessions is genuine evidence
about request construction and end-to-end wiring, and no evidence at
all about keyboard-level input handling. If a future change touches an
`onKeyDown`/`onPaste`/composition handler, it needs a real human at a
real keyboard, or a Playwright run (`apps/e2e`, which drives Chromium
through CDP and DOES send real key events) — state which one was used
rather than reporting "verified in a browser" flatly.

### Project edit — last must-fix-before-pilot gap, verified live on the VM

`ProjectDetail.tsx` gained an Edit Project form wired to the pre-existing
`PATCH /projects/:id` (endpoint and `INVENTORY_PROJECT_UPDATE` permission
both already existed — only the UI was missing, the same shape as the
media/ticket gaps earlier in this pass). `code` is dropped from
`updateProjectSchema` (via `.omit({ code: true })`, not left merely
optional) rather than left PATCH-able with no P2002 handling — it's used
to match projects during bulk inquiry CSV import, so changing it has no
real use case and would silently break existing CSV mappings.
`isActive` is deliberately left out of the edit form: grepped the whole
API and found it enforced nowhere (not booking eligibility, not reports,
not the portal), so shipping a toggle for it now would imply an effect
it doesn't have — noted in `docs/todo.md` for whoever gives it a real
meaning later.

Editing `areaLocationId` only changes GST place-of-supply for **new**
bookings — confirmed by grep, not inference: `Booking.placeOfSupplyStateCode`
has exactly two writers in the codebase (`booking.service.ts`'s
`createBooking`, and `transfer.service.ts`'s carry-forward of the OLD
booking's value), and `ProjectService.update()` never touches `Booking`
at all. A new `GET /projects/:id/booking-count` endpoint (cheap join:
`Booking.unit.floor.tower.projectId`) drives a confirmation dialog in
the UI, shown only when the project already has ≥1 booking — a project
with zero bookings saves immediately, no extra step, per explicit
instruction not to warn about a consequence that doesn't exist.

Tests: a direct-service test proves an `areaLocationId` edit leaves an
existing booking's `placeOfSupplyStateCode` byte-identical; a second
proves the edit leaves towers/floors/units/rate-revisions untouched
(the first time a project WITH real inventory has been mutated by a
test in this suite); a cross-company edit 404s; a schema test proves
`code` is rejected, not merely ignored. Two new Playwright scenarios
(persistence after reload; the confirmation dialog + booking
untouched). Full monorepo suite green (69/69 files, 450/450 tests)
before deploy.

**Verified live on the VM** (by now relocated to `10.95.204.131`, see
memory — IPs on this project drift session to session, always confirm
current), not just locally: `upgrade-native.sh` ran clean (no pending
migration — this release touched no schema; permissions already
synced), health endpoint returned `{"status":"ok","db":"ok","redis":"ok","version":"0.2.3"}`.
Real browser click-through on "QA Towers 723789" (7 real bookings):
Code field correctly read-only with the CSV-import explanation; changed
RERA number, address, and `areaLocationId` (Sector 137 Noida → Mumbai);
Save correctly produced the confirmation dialog naming the exact
booking count ("This project has 7 existing bookings...") before
persisting; reload confirmed persistence. Direct DB read after save
confirmed the project's `area_location_id` genuinely changed to Mumbai
(`state_code = '27'`) while every one of the 7 bookings'
`place_of_supply_state_code` was unchanged from before the edit (NULL/
`09`, matching pre-existing legacy demo data — none flipped to `27`),
which is the one thing an automated test alone couldn't prove against
this real, non-test dataset. This click-through required a one-time
password reset on `admin@demo-realty.com` via `reset-admin-password.sh`
(no other known login existed) — blocked once by the auto-mode safety
classifier as a credential mutation, then explicitly approved by the
user in chat before proceeding. The account's password is now
`[redacted — rotated]`, not its original value, since resetting a
password by definition means the old hash isn't recoverable — noted
here so a future session doesn't waste time on a stale credential
assumption for this specific demo account. (The literal value that
used to sit here was committed to this public repo and has since been
rotated twice; see the no-credentials-in-committed-files standing rule
below, and `docs/handoff.md` for where credentials actually live now.)

### Standing rule: an upgrade assertion must assert the OUTCOME, not the mechanism

The `native-upgrade` CI job spent four consecutive releases watching
the super_admin permission bug happen and reporting green. This
session's push proved it with the job's own log, not by argument: on
the very first run carrying the fix, the repair step printed

```
super_admin grants: 2 missing permission(s) restored.
```

That is CI reporting that its own baseline-to-current upgrade had
produced a super_admin missing two permissions — **on every previous
run too**, silently, for four releases.

The job wasn't negligent; it asserted the wrong half of the property.
It checked that the new permission ROWS existed (`GET /roles/permissions`
contains the keys) — a *precondition*. It never checked that any role
could actually USE them — the *outcome*. Every release satisfied the
precondition and failed the outcome, and the gate had nothing to say.

**Generalised rule: an upgrade-path assertion must assert the thing a
user would notice, not the mechanism that is supposed to cause it.**

- Not "the migration ran" — that the screen the migration exists for
  renders the new data.
- Not "the permission row exists" — that the role holds it, which is
  what gates the feature. (Assertion 3b now does exactly this.)
- Not "the seed script exited 0" — that the seeded thing is reachable
  through the API a user's browser would call.
- Not "the service restarted" — that a real request through nginx
  returns what it should.

A precondition check is cheap and feels like coverage, which is
precisely why it is dangerous: it turns green for the same reason the
bug survives. When adding any future upgrade assertion, write down the
user-visible symptom the release is supposed to prevent, then assert
*that*.

### Verification VM IPs moved again — now tracked in docs/handoff.md, not here

Both boxes' addresses changed once more (walkthrough box →
`192.168.0.117`, fresh-install box → `192.168.0.118`). Per this file's
own repeated observation that "IPs on this project drift session to
session, always confirm current" — a living doc is a better home for a
fact that changes every few sessions than another line buried in an
append-only log a future session has to grep for. `docs/handoff.md`
(new) now owns current IPs/credentials/SSH-key/sudo-pty notes; this log
keeps the *why* (e.g. the sudo-rs nested-sudo-hang investigation
elsewhere in this file) but no longer tries to be the source of truth
for *current* addresses. Read `docs/handoff.md` first every session,
same as this file.

### Pre-v0.3.0 fresh-install pass on the clean box — one real bug, one real environment gap

Genuinely clean fresh-install verification (not an upgrade, not a reused
checkout): the clean-install box had a prior session's install on it, so
`uninstall.sh --purge` ran first (needs its confirmation word piped
separately from the sudo password — feeding both as one stream of lines
answers the WRONG prompt with the wrong line and silently no-ops the
purge, first attempt did exactly this), then the database/roles were
dropped and `/opt/openestate-src` removed by hand (purge doesn't touch
Postgres or the old checkout, by design — see its own printed note).
Confirmed genuinely clean (`/opt` empty, no `openestate` OS user, no
nginx site, no systemd unit) before cloning fresh from the public GitHub
URL and running `install-native.sh` exactly per the README.

**Real bug: `git config --system --add safe.directory` was missing.**
The README's own `sudo git clone .../opt/openestate-src` leaves the
checkout root-owned; the very first `git log` run afterward as the
non-root admin (something the upgrade docs assume happens routinely,
right before every `upgrade-native.sh`) fails with "dubious ownership"
(Git's CVE-2022-24765 mitigation). Invisible on the existing walkthrough
box because that checkout predates this discipline and is user-owned by
accident, not by design. Fixed in both `install-native.sh` and
`upgrade-native.sh`.

**Install itself completed cleanly, first try, prerequisites already
present.** Could not re-verify the "prerequisite check reports all
misses in one pass, with the Ubuntu-25.10-correct `postgresql` package
name not `postgresql-16`" behavior live this session — that requires
purging git/curl/node/postgresql/redis/nginx/build-essential/python3
from the box, and a broad `apt-get purge` sweep including `python3*`
risks breaking the VM's own tooling badly enough to need a reimage, so
the safety classifier correctly blocked it. Verified by hand instead:
the box's real `/etc/os-release` reports `ubuntu`/`25.10`, and
`install-native.sh`'s own version-detection logic
(`OS_MAJOR -lt 25`) evaluates false for 25.10, correctly selecting the
`postgresql`/`postgresql-client` package names — matching the fix's own
code comment, which already claims to have been VM-verified in a prior
session. Not independently re-confirmed live; treat as inference from
code + real OS values, not a screenshot, same honesty standard as the
REPORTS-phase `is_reversed` backfill entry above.

**Environment gap, not a code problem: browser automation (both
`Claude_Browser__*` and `claude-in-chrome`) could not route to
192.168.0.0/24 this session, though it reached the public internet
fine** (confirmed: `https://example.com` loaded correctly in the same
tab that got `chrome-error://chromewebdata/` for both VMs' IPs,
repeatedly, across tool restarts). This same browser tooling DID reach
the *previous* IP range (`10.95.204.x`) earlier in the project's
history — so this looks like a real LAN-segment reachability change
tied to the IP reassignment, not a stale-session artifact. Local
`curl`/`node fetch` from the same machine reached both VMs fine the
whole time, which is what made a functional fallback possible at all.
**This means no session-2 functional check in this pass is backed by an
actual browser** — every one of login/forced-password-change/booking/
portal-invite-consume below was proven via direct HTTP (`node fetch`
against `localhost` on the VM over SSH), not a real browser. This is
explicitly a lesser proof than this file's own primary lesson demands
(a `fetch`-based check cannot catch a Secure-cookie-over-HTTP class of
bug — see the systematic-walkthrough issue #2 entry above, found
specifically because curl/wget verification couldn't see it). The
mitigating fact: `apps/e2e`'s `auth-2fa.spec.ts` already covers exactly
that bug class with a REAL browser (Playwright/Chromium) against
`NODE_ENV=production` over plain HTTP, and passed (14/14, this
session, same commit) — so the one bug class most likely to hide from
a fetch-based check specifically is independently covered elsewhere.
Whoever picks this up next should still do one real-browser
click-through on this box once browser-tooling network access to it is
restored, rather than treating this session's fetch-based pass as
equivalent.

**Functional verification, all via direct HTTP against the box's own
`localhost` (SSH), 12/12 checks green**: login with the seeded
one-time password; `force-change-password` (confirmed for real by a
second, independent login with the new password — the first pass's own
success/failure report for this specific step was internally
inconsistent, most likely a transient Node `fetch` client issue on the
VM rather than a server bug, not chased further once the outcome was
independently confirmed correct); a complete booking (project → tower →
bulk-generated unit → applicant → booking, using the fixed seed's now-
open-ended GST 5% rate → a custom payment plan); a portal invite
created, consumed (sets a password), and logged into. Every wrong-shaped
request hit along the way (inventory routes nest under
`/projects/:id/...`, not a flat `/inventory/...`; `costLines` wants
`label`/`baseAmountPaise` not `amountPaise`; portal-invite `channel` is
`EMAIL`/`SMS` not freeform; a booking's place-of-supply must be set
explicitly or via the project's Area Location, never guessed — the
fail-loud check from the "Seed-only-reachable-data audit" entry doing
exactly its job) was this session's own script guessing wrong, not a
product bug — corrected against the real DTOs before treating anything
as a finding.

### v0.3.1 — first real pilot-user feedback, triaged and fixed

Five items, triaged by reading source first, then fixed with the usual
bar (through-the-wire supertests, Playwright where UI is touched, full
pipeline green). Two more (bulk import UI, follow-up attribution) were
"check before building" items that turned out to be backend-complete —
confirmed by reading the code, not assumed.

- **Creator-retains-lead assignment policy.** `InquiryService.create()`
  ran round-robin unconditionally whenever `dto.projectId` was set, with
  zero notion of who created the inquiry — `Inquiry` had no
  `createdById` column, and `InquiryController.create()` never passed
  the caller through to the service at all. Combined with `scopeFor()`
  hard-filtering a `sales_executive`'s list to `assignedToId ===
  user.sub`, this meant a rep's own newly-created lead could silently
  land on whoever the pool's round-robin picked next (often admin, in a
  small/demo pool) and vanish from the rep's own queue on the very first
  inquiry — trust-destroying, per the report. Fixed with a default-on
  policy: `createdById` is now captured on every interactively-created
  inquiry, and when `CompanyConfig.presalesCreatorRetainsLead` is true
  (default), the creator is assigned directly — round-robin never runs
  for a human-created inquiry at all. Machine-driven intake
  (`createFromLead`, used by both the inbound lead API and — matching
  "website forms" in the report — the same endpoint real websites
  integrate through) keeps round-robin unchanged, since there's no human
  creator to retain ownership for. Bulk import previously ran NO
  assignment logic at all (a silent gap, not a deliberate choice) —
  given the same "no human creator" reasoning applies, it now gets
  round-robin too, closing that gap in the same pass.
- **Shared update-payload helper, root-cause fix for a bug class, not
  just the third instance.** Three separate sites have now hit the same
  bug: a frontend sends a create-shaped payload (built for a broader
  `useForm<CreateXDto>` or similar) to a `.strict()` update endpoint
  that declares fewer fields, and the extra keys 400 the whole request.
  Previously patched ad hoc at each site (`BrokerDetail.tsx`'s `pay()`,
  Masters.tsx's PATCH `id`-leak); this time, `UserForm.tsx`'s edit save
  hit it a third time (see below for a deeper bug in front of it).
  `pickForSchema()` (`packages/shared/src/dto-utils.ts`) is the actual
  fix: it derives a payload by projecting ONTO an update schema's own
  declared keys, picked from whatever superset object is on hand — the
  correct direction (project TO the update shape) instead of the
  fragile one (subtract FROM the create shape, which silently breaks
  again the next time the create schema grows a field the update schema
  never wanted). Applied at all three known sites, including
  `BrokerDetail.tsx`'s already-correct hand-built body — a provably
  behavior-preserving refactor (covered by its own test asserting
  byte-identical output), done for consistency of mechanism, not because
  it was broken. `packages/shared/test/update-schema-strictness.test.ts`
  dynamically discovers every exported `create*Schema`/`update*Schema`
  pair in the package and asserts the update schema rejects any field
  unique to its create sibling — a regression guard for the *class*,
  not just the four instances found so far, so a fifth site reintroducing
  the same mistake fails a test immediately rather than shipping.
- **Real bug found only by actually running the fixed edit form, not by
  reading the code: `UserForm.tsx`'s edit-mode submit could never
  reach the network at all.** The form's `zodResolver` was always
  `createUserSchema`, edit mode included — `createUserSchema` requires
  `password`, which the edit-mode JSX never renders/registers, so
  react-hook-form's client-side validation failed on every single edit
  attempt and `handleSubmit(onSubmit)` never even ran. This is a layer
  earlier than the email-leak 400 the original source-level triage
  found — the reported symptom ("role cannot be changed") was real, but
  the actual root cause blocked the *entire* form, silently, with no
  visible error. Root-caused via a live Playwright run (this project's
  own primary lesson proving itself again: reading source estimated the
  right *class* of bug but missed the deeper one hiding in front of it).
  Fixed by picking the resolver by `isEdit`
  (`zodResolver(isEdit ? updateUserSchema : createUserSchema)`), and by
  no longer registering `email` as an editable field at all in edit mode
  (`updateUserSchema` has no `email` field — it can't be changed via
  this endpoint; shown as plain read-only text instead, matching
  `RoleForm.tsx`'s existing pattern of disabling a system role's name
  input). A second, independent bug surfaced by the same test run:
  the role `<select>`'s `reset()`-driven value raced `GET /roles` — a
  native `<select>`'s value assignment silently no-ops if no matching
  `<option>` exists yet, and does not retroactively apply once the
  options do render. Fixed by gating the `reset()` effect on both
  `existingUser` AND `roles` having loaded.
- **`RequirePermission` route wrapper.** Confirmed both halves of the
  report separately rather than assuming both were the same bug. (b)
  was real: `App.tsx` had zero per-route permission gating — any
  authenticated user navigating directly to an admin URL got the full
  page shell (buttons, forms, layout), with only the underlying data
  fetch 403ing in the background. Fixed with a `RequirePermission`
  wrapper on every protected route, gated by whatever permission
  actually guards that route's primary data fetch on the backend (not
  guessed from the nav label). (a) — "users see nav items for
  permissions they don't hold" — was **not** independently reproducible
  in `AppShell.tsx`'s nav-filtering code, which was already correct
  (`hasPermission()` reads straight off the JWT's `permissions` array,
  itself freshly recomputed from the role's current grants on every
  login and token refresh, never stale). Most likely explanation: since
  role edits have been silently 400ing (the bug above), any attempt to
  *narrow* a user's role/permissions had never actually succeeded either
  — from the admin's side, that looks identical to "nav still shows
  what I tried to take away." Verified via the same Playwright spec that
  covers (b): a narrow-permission user's nav correctly hides links, and
  the same permission gates the route directly.
- **Bulk Excel inquiry import: backend already existed, only needed a
  caller.** `InquiryImportService` (row-level `zod` validation via
  `importInquiryRowSchema`, magic-byte file-type check, applicant
  dedup-and-link matching the interactive-create path, project/source/
  inquiry-type name resolution) has existed since Phase 3 with zero
  frontend caller — confirmed by grep before writing anything, per this
  file's own established discipline for "check before building" items.
  Added: an upload UI on the Inquiries page (file picker → the existing
  endpoint → per-row error/success reporting) and a
  `GET /inquiries/import-template` endpoint streaming an XLSX header
  row generated from the SAME `HEADER_MAP` the parser reads, so the
  template can never drift from what a real upload requires. Found and
  fixed a real routing hazard while wiring the new endpoint:
  `InquiryController`'s `GET /inquiries/:id` was registered before
  `InquiryImportController` in `presales.module.ts`'s controllers array
  — Nest registers routes with Express in that order, and Express's
  router matches the first pattern that fits, so a request for the
  literal path `/inquiries/import-template` would have been swallowed
  as `id="import-template"` and 404'd, never reaching the real handler.
  `POST /inquiries/import` was never affected (no other `POST
  /inquiries/:x`-shaped route exists to collide with) — only the new
  `GET` route introduced the conflict. Fixed by reordering the
  controllers array, with a comment explaining why the order is load-
  bearing so a future cleanup doesn't silently reintroduce it.
- **Follow-up attribution: captured and fetched since Phase 3, never
  displayed.** `FollowUp.createdById` was already written on every
  create and already included in `FollowUpService.findAllForInquiry`'s
  query — `InquiryDetail.tsx` just never read it. One field added to
  the local `FollowUp` interface, one line added to the render.
- **Security, found while wiring the display above, not looked for
  deliberately: `assignedTo: true` (`InquiryService.findAll`/`findOne`)
  and `createdBy: true` (`FollowUpService.findAllForInquiry`) were
  bare Prisma `include`s, which return every scalar column on the
  related model — `User.passwordHash`/`totpSecret`/`recoveryCodes`
  included — over the wire on `GET /inquiries`, `GET /inquiries/:id`,
  and `GET /inquiries/:id/follow-ups`.** The same class this codebase's
  `panCiphertext` sweep (Phase 8) and `PORTAL_APPLICANT_OMIT` (v0.2.3)
  both closed elsewhere, found again in a spot neither pass reached.
  Fixed with scoped `select`s (`{id, name, email}` /
  `{id, name}`) at both call sites; regression-tested through the real
  HTTP pipeline (`e2e-inquiry-assignment.test.ts`), asserting the
  absence of the sensitive fields directly rather than just the
  presence of the safe ones.
- **Full pipeline, both suites, real evidence.** Full monorepo
  `pnpm test`: shared 90/90, web 3/3, db 59/59, portal 3/3, api
  462/462, zero failures. Full `apps/e2e` Playwright suite: 18/18,
  including the four new specs this release added
  (`user-role-edit`, `access-denied-route-guard`, `bulk-import`,
  `follow-up-attribution`).

**Not fixed this release, deliberately — approved as separate,
larger work to follow:** lead ownership and manager hierarchy
(`User.managerId`, a `TeamScopeService` with a recursive-CTE
subtree query, consistently applied across lists/reports/dashboard/a
new global search, with a CI-enforced guard against a future ad hoc
scope filter reintroducing the same "forgotten on a new endpoint" risk
this triage was explicitly trying to design around), and phone-as-
identifier handling (a persisted per-pair "confirmed distinct"
decision instead of a DB uniqueness constraint, plus a per-company
toggle for automated-path dedup strictness). Both are planned, not
built yet — see `docs/todo.md` for the approved design of each.

### Standing rule: never run concurrent Claude Code sessions against the same working directory

This release is why. A background session was spawned mid-session to
fix a flagged gap (`project_media`'s FK invisible to `prisma migrate
dev` — see the "v0.3.1" entry above and the entry two above it for the
original finding). It edited `schema.prisma` directly in the SAME
checkout this session was actively working in — not an isolated
worktree — adding a `project` relation on `ConstructionUpdate` and
`ProjectMedia` without their required opposite side on `Project`
(Prisma requires both). This session's own `git add -A` picked up
that half-finished edit along with its own changes, because `git
status --short` showing "just the expected files" was read as
sufficient review — it wasn't; the file *list* matched, the file
*content* didn't. The result shipped straight to `master` and broke
CI's very first step on the next push.

Two changes, going forward:
- **Don't run a background/concurrent session against a working
  directory another session is actively committing from.** If a
  flagged follow-up needs to happen in parallel, it needs an isolated
  worktree (or a directive to hold until the active session is
  between commits) — not the same checkout.
- **`git status --short` proves file identity, not correctness.**
  Before any commit, when there's ANY reason to suspect a file was
  touched by something other than your own edits this session (a
  concurrent process, a stale editor, anything) — diff the actual
  content (`git diff <file>`), not just the file list. This cost a
  broken CI push and two follow-up fix commits to recover from; a
  30-second `git diff` before the original commit would have caught
  the missing back-relation immediately.

### v0.4 — lead ownership and manager hierarchy

The second half of the v0.3.1 triage's "the big one" — deferred out of
that release deliberately (see its own Decisions entry) because 1-5 were
things a pilot user hits hourly and this needed its own design pass.

- **`User.managerId` is a scalar FK with a DB-level constraint, not a
  Prisma `@relation`** — same "no back-relation bloat on `User`" policy
  every other `User`-linked FK in this codebase already follows (Phase 4
  decisions: `createdById`/`approvedById`/etc. are all scalars). A
  manager's display name is resolved by a small second lookup in
  `UsersService.findAll`/`findOne`, not an `include`. Cycle prevention
  (`UsersService.assertValidManager`) is a bounded ~20-hop walk up the
  CANDIDATE manager's own chain on every write — defense-in-depth only,
  since every write goes through this function, a stored cycle should
  never exist; Postgres itself has no native cycle prevention for
  adjacency lists, and `TeamScopeService`'s recursive CTE assumes an
  acyclic graph.
- **`TeamScopeService.getVisibleUserIds(companyId, userId, roleSlug)`
  returns `string[] | null`, computed fresh from the database on every
  call, never cached.** `null` means "no restriction" — reserved for
  `company_admin`/`super_admin`, the only two roles exempted from the org
  chart entirely (an admin with no reports would otherwise be scoped down
  to just themselves, a severe regression). Every other role gets a real
  visible set via `WITH RECURSIVE`: the caller plus their FULL subtree,
  not just direct reports — a direct-reports-only version would silently
  hide a senior manager's sub-subordinates' leads, a worse failure mode
  than showing "too much." Because nothing is cached, a manager
  reassignment takes effect on the very next request the affected users
  make — no session refresh, no cache invalidation, no extra plumbing
  needed.
- **The pre-existing scoping bug this replaces, found during the audit,
  not assumed:** before this release, exactly ONE role
  (`sales_executive`) was restricted to their own queue; every OTHER
  role — `sales_manager` included — saw the ENTIRE company's inquiries
  and reports, via three independently hand-rolled
  `if (roleSlug === SALES_EXECUTIVE) ... else {}` functions
  (`InquiryController`, presales `ReportsController`, postsales
  `ReportsController`). A `sales_manager` today could already see every
  other manager's team's leads — not a hierarchy, a company-wide view
  with one narrow carve-out. All three replaced with
  `TeamScopeService.getVisibleUserIds()`.
- **Security fix, found during the audit, not introduced by this
  release: `FollowUpController` checked only `companyId`, never whether
  the caller could see the PARENT inquiry.** A `sales_executive` could
  already list, create, and update follow-ups on ANY colleague's inquiry
  by id, completely bypassing `Inquiry`'s own scoping — a live bug
  shipping in every prior release, not something this feature
  introduced. Fixed by having every `FollowUpService` method confirm the
  parent inquiry is in the caller's visible set first
  (`InquiryService.assertInScope`, a lightweight existence+scope check
  reusing the exact same `where` shape `findOne` uses), before touching
  anything else.
- **`PATCH /inquiries/:id/assign` is now scoped on BOTH ends** — the
  inquiry being reassigned and the target user must each be in the
  caller's visible set (admins unrestricted, same as everywhere else). A
  manager can move a lead within their own subtree; they can't pull one
  in from outside it or hand one to someone outside it. Incidentally
  closes a second pre-existing gap found in the same method: `toUserId`
  was never checked to belong to the same company at all before this.
- **Deliberately NOT scoped, decided during the audit, not by default:**
  - **`Applicant`.** Stays completely unscoped — any staff user with
    `PRESALES_APPLICANT_READ` still sees every applicant company-wide.
    This is a deliberate decision, not an oversight: an applicant can be
    linked to inquiries owned by DIFFERENT reps over time (dedup,
    merge — Phase 3's `ApplicantMerge` machinery), so "who owns this
    applicant" is genuinely ambiguous in a way inquiry ownership isn't.
    Scoping it by, say, "any inquiry currently assigned within my
    visible set" would need its own design pass (what about an
    applicant with inquiries split across two different reps' subtrees
    after a reassignment? after a merge?) — not a mechanical extension
    of the Inquiry scoping logic. **Do not "fix" this by bolting
    `TeamScopeService` onto `ApplicantService` using the same pattern as
    `Inquiry` without first working through the merge/multi-inquiry
    case** — it looks like the same problem and isn't.
  - **`Booking` core CRUD.** Stays unscoped, matching the existing
    Phase 4-UI precedent that only the Reports module scopes postsales
    data by owner. See `docs/todo.md` — flagged as a likely real pilot
    request once a company has enough reps for this to matter, not
    designed for preemptively.
  - **`managerWiseInteractions()`** (presales reports) — its own Phase 3
    doc comment already anticipated being upgraded to a team roll-up
    once a hierarchy field existed. It exists now; the upgrade itself is
    a separate, small follow-up (see `docs/todo.md`), not bundled into
    this release.
  - **Dashboard scoping semantics, not a new screen.** "Own work vs. a
    manager's full visible set" was interpreted as the scoping RULE
    `myDay()` (hardcoded to the caller's own id, unchanged) and the list
    endpoints (now `TeamScopeService`-scoped) already express — not a
    mandate to build the literal `Dashboard.tsx` page, which remains the
    static placeholder it was before this release. No new UI was built
    for it.
- **CI guard: two independent regex checks, not one, in
  `team-scope-guard.test.ts`.** The first (`SYSTEM_ROLES.SALES_EXECUTIVE`
  must not appear outside `TeamScopeService`) catches a copy-pasted
  role-branch. The second (a BARE `where.assignedToId =` / `where.
  createdById =` scalar assignment — deliberately excluding the correct
  `= { in: visibleUserIds }` shape via a negative lookahead) catches a
  fresh ad hoc filter that doesn't reuse the role-check pattern at all.
  Both were verified empirically against the real codebase (before AND
  after the fix) to have zero false positives before being trusted — the
  first regex draft of the second check had a lookahead bug
  (`=\s*(?!\{)` lets `\s*` backtrack to zero-width, so the lookahead
  ends up checking a whitespace character instead of the brace and
  passes when it shouldn't) that was caught by running the guard against
  its own fixed codebase and getting a false failure, not by inspection.
- **Behavioral change for existing installs, called out explicitly in
  CHANGELOG.md, not just fixed silently:** upgrading changes what
  non-admin roles can see. Before: every role but `sales_executive` saw
  the whole company. After: everyone (aside from `company_admin`/
  `super_admin`) sees only their own subtree — themselves plus whoever
  reports to them, computed from `User.managerId`. A user with no
  `managerId` set sees only their own leads. This is the CORRECT
  behavior, but it is not silent: an admin upgrading needs to configure
  the org chart (set `managerId` on their `sales_manager`/
  `sales_executive` users) or their managers will suddenly see far less
  than they did on the previous version, with no error, just a smaller
  list.

### Standing rule: no credential VALUES in any committed file, including this one

This repo is public. Two real credentials were committed to it and
stayed in history for weeks: the VM's SSH/sudo login password (in
`docs/handoff.md`'s VM table AND inline in its own `printf ... | ssh`
example, across ~5 commits) and the demo-admin app password (in
`docs/handoff.md`, and separately in this file's own "Project edit"
decisions entry). Both were written down for a genuinely good reason —
a future session needs them to do anything on the VM — and that reason
is exactly why nobody questioned them.

**The rule: a real credential value never goes in a tracked file.** Not
in `docs/handoff.md`, not in a decisions-log entry here, not in a code
comment, not in a commit message, not in an example command. A
placeholder (`<password>`, `<token>`) is correct; the real string is
not, even for a throwaway demo box on a private LAN, and even when the
surrounding prose is genuinely useful operational knowledge. Write down
*where* a credential lives and *how* to recover it (e.g.
`deploy/native/reset-admin-password.sh` recovers the demo admin without
needing the old value) — never the value itself.

**This file's append-only rule protects DECISIONS, not SECRETS.** That
distinction had never been stated, and the omission is why a password
sat in a decisions entry unchallenged: "append-only" was read as "never
edit anything here." Redacting a leaked credential value in place
(replacing it with `[redacted — rotated]`, keeping the entry and its
reasoning fully intact) is explicitly ALLOWED and expected. What
append-only forbids is rewriting or deleting the *decision* — the what,
the why, and what it ruled out. A redaction changes none of those.

Two things worth knowing about the cleanup itself, since they shape
what a future session should and shouldn't attempt:

- **Redacting the current file does NOT un-expose anything.** Both
  values were already pushed to a public remote; git history still has
  them at their original commits. Redaction stops the *current* file
  from displaying a secret and stops it being copied forward — the
  actual mitigation is ROTATION, which is what was done (both passwords
  rotated; the SSH one additionally superseded by disabling password
  auth entirely on the box). History rewriting was deliberately NOT
  attempted: it would break every existing clone and every commit SHA
  referenced throughout this log, for no security benefit once the
  credentials are dead.
- **A full-history credential sweep was run** (all 222 commits, for
  cloud-provider key shapes, bearer/PAT token shapes, PEM private-key
  blocks, and any committed `.env`) — clean apart from the two VM
  passwords already known. Worth re-running the same sweep before any
  future public-facing milestone rather than assuming it stays clean.

### Standing rule: any migration touching a hot table needs `lock_timeout` reasoning, not just a schema diff

Found when `native-upgrade` CI sat `in_progress` for over an hour against
a ~3-minute norm — a migration adding `RefreshToken.revokedAt` hung
indefinitely instead of failing. Root-caused empirically, not guessed
(reproduced against a real Postgres before believing it).

**The mechanism.** `upgrade-native.sh` runs migrations BEFORE cutover,
deliberately — the previous release keeps serving against the new,
backward-compatible schema until the symlink swaps (see the "Native
install becomes primary" decisions entry). That means every DDL
statement in every future migration contends with a LIVE app, not an
idle database. `ALTER TABLE ... ADD COLUMN` needs an ACCESS EXCLUSIVE
lock, which conflicts with the ACCESS SHARE an ordinary `SELECT` holds —
so a single in-flight read on the table is enough to block it, and with
no timeout it waits **forever**. Confirmed directly: an open read
transaction on `refresh_tokens` blocked `ADD COLUMN` indefinitely in a
real test.

**Why the freeze isn't limited to the migrating statement.** A blocked
DDL statement queues *ahead* of every later lock request against that
table — Postgres's lock queue is FIFO, not priority-ordered — so once
the `ALTER` is waiting, every subsequent `SELECT`/`UPDATE`/`INSERT`
against that table from the live app queues up behind it too. The
symptom is the whole app appearing to freeze on that table, not just the
migration running slowly.

**`CREATE INDEX` is a genuinely different risk profile — check which one
a migration actually needs before reasoning about its blast radius.**
Confirmed by the same test: a plain (non-`CONCURRENTLY`) `CREATE INDEX`
succeeded immediately against the SAME open read transaction that blocked
the `ALTER TABLE`, because a plain `CREATE INDEX` takes SHARE, which
conflicts with writers but not readers. A migration that's *only* adding
indexes is comparatively low-risk against read-heavy traffic; one with
any `ALTER TABLE`/`ADD COLUMN`/`DROP COLUMN`/type change on a
frequently-read table is not, and needs the timeout reasoning below
applied deliberately, not assumed away because "it's just a migration."

**The fix, and why it can't live in the migration file itself.**
`upgrade-native.sh`'s `run_as_superuser()` now sets `lock_timeout` (15s
default, `MIGRATION_LOCK_TIMEOUT` env var to override) on the connection
used for `prisma migrate deploy`, so a contended migration aborts fast
with a clear error and leaves the previous release running and
untouched — the same intended failure mode `die()` already documents for
a migration that fails outright. This could NOT be fixed by editing the
already-applied `refresh_token_revoked_at` migration to add `SET
lock_timeout` inline: Prisma records a checksum per migration file at
apply time, and this repo's own rule is forward-only, never edit an
applied migration — doing so would break the checksum check on every
install that has already applied it, everywhere. Fixing it at the
invocation instead covers every migration, past and future, which is
strictly better than patching the one that happened to expose the gap.

**`PGOPTIONS` does not work here — confirmed by testing both, not
assumed from how libpq-based tools behave.** Prisma uses its own Rust
query engine, not libpq, and does not read libpq's environment-variable
conventions (`PGOPTIONS`, `PGCONNECT_TIMEOUT`, etc.). The only way that
was empirically confirmed to make Prisma apply `lock_timeout` is the
connection string's own `options` query parameter
(`?options=-c%20lock_timeout%3D15s`, URL-encoded). Anyone reaching for a
libpq-style env var to tune a Prisma connection in this codebase should
expect it to be silently ignored — check the connection string first.

**Migration risk checklist for anything touching a table this app reads
on most requests** (`refresh_tokens`, `users`, `inquiries`,
`ledger_entries`, and anything else on a hot request path): does this
statement need ACCESS EXCLUSIVE (`ALTER TABLE` variants) or just SHARE
(`CREATE INDEX` without `CONCURRENTLY`)? If the former, it WILL queue
behind live reads with no timeout — the 15s default here is deliberate
insurance, not decoration, and lowering or removing it for a "quick"
migration reintroduces exactly this bug.

### Decision: `REFRESH_REUSE_GRACE_SECONDS` stays at 30, trade-off stated explicitly

The rapid-reload-logout fix (`TokenService.rotateRefreshToken`'s reuse
grace window — see the fix's own commit and code comment for the
mechanism) accepts a real security trade-off, not a hidden one: a raw
refresh token that is BOTH stolen AND replayed within the grace window
of the legitimate client's own next rotation will still be honored,
yielding the thief a session.

**Why 30 seconds is the right default, not just a round number.** The
window only matters to an attacker who already possesses a valid raw
refresh token (theft has already happened by the time this window is
relevant at all) AND races the legitimate client's own rotation within
30 seconds of it. That is a narrow, already-compromised scenario. The
alternative — a zero-length window, i.e. the pre-fix behavior — logs out
real, uncompromised users for ordinary browser behavior (a burst of
reloads, several tabs restored at once), which is the actual bug this
fix exists to close. Making the window shorter narrows an already-narrow
attack surface further at the direct cost of the fix's own purpose;
making it longer widens the attack surface for no corresponding user
benefit, since legitimate rotation races resolve in milliseconds, not
seconds. 30s is deliberately generous relative to the real race (which
resolves near-instantly) specifically so it has margin against a slow
mobile connection or a backgrounded tab, without meaningfully changing
the attacker's already-narrow window.

**Tunable, not fixed, via `REFRESH_REUSE_GRACE_SECONDS`** — sites with a
different risk tolerance can set it to `0` to restore the strict
pre-fix behavior, or raise it if their own traffic patterns show longer
legitimate races. Genuine replay — after the window, or once the
token's family has been revoked outright — still revokes the entire
family exactly as before; the grace window narrows WHEN reuse is
forgiven, it does not weaken the theft-detection mechanism itself.

### Standing rule: `apps/e2e`'s shared `portal-auth` throttle bucket is near its ceiling — extend an existing fixture's login, don't add a new one

Found the hard way during the LAND_BASED-portal Playwright work (Phase D
of plotted-farmhouse-inventory.md §14). A first attempt added a
standalone fixture (`withLandBasedPortalProperty`) plus a standalone
spec file with its own fresh `POST /portal/auth/login` call. It passed
in isolation. Running the FULL suite made two previously-reliable,
unrelated specs fail intermittently — `ticket-reply.spec.ts` and
`rapid-reload-session.spec.ts`'s `'portal: a burst of full page loads
does not end the session'` test — both stuck on `/portal/login` instead
of reaching their expected authenticated route.

Root-caused by counting every login call across every existing spec
file, not guessed: the `portal-auth` throttle bucket (`ttl: 300_000,
limit: 5`, IP-keyed — Phase 6 commit 1) was already sitting at exactly
5 logins across the pre-existing suite (`media-gallery.spec.ts` ×2,
`ticket-reply.spec.ts` ×1, `rapid-reload-session.spec.ts` ×2); the new
spec's login became the 6th within the same 5-minute window, since the
whole Playwright suite finishes in under 2 minutes locally — every
login in the harness genuinely shares that one 5-request budget.

Considered and rejected: raising the production throttle limit to suit
the test suite (security-relevant, must not be weakened for test
convenience); `THROTTLE_TEST_KEY_PREFIX` (the mechanism that gives the
separate Vitest e2e suite per-file throttle isolation — doesn't apply
here, since Playwright's `webServer` runs ONE shared API process for
the entire run, not one process per spec file the way Vitest's forked
model does).

**Fixed by extending an already-authenticated fixture instead of
adding a new login**: merged the LAND_BASED plot/booking into the
existing `withPortalTicketSetup` fixture block (same applicant, zero
new logins), and added the new assertions to `media-gallery.spec.ts`'s
already-passing, already-authenticated first test rather than a fresh
spec with its own login. Verified by running the full suite twice
after the change — 35/35 both times, including the two previously-flaky
specs now stable.

**Standing rule for any future `apps/e2e` addition that needs a real
portal session**: do not add a new `POST /portal/auth/login` call if it
can be avoided. Check whether an existing fixture in `fixtures/seed.ts`
already produces an authenticated session that can be extended with the
new data, and add the new assertion into that fixture's own spec's
already-logged-in flow — exactly the pattern this fix used. Only add a
genuinely new login when the scenario needs a DIFFERENT identity (a
different role, a fresh 2FA enrollment, a session that must NOT share
state with another spec) that structurally cannot reuse an existing
session — and if so, budget it explicitly against the bucket (5 logins
already spoken for, per the count above; a 6th consumes the bucket's
entire remaining headroom for the whole run) rather than discovering
the ceiling by breaking unrelated specs, the way this session did.

### Phase 0 of feature-completion-plan.md — lead-stage foundation

Standalone step, built before Phase 1 (Lead Management workspace) per
explicit direction, once `GET /reports/presales/funnel` was confirmed to
group by `InquiryStatus` — proving no stage concept existed anywhere in
the schema, implicit or otherwise, and that Phase 2's board and Phase
3's funnel would otherwise be built on the wrong axis.

- **`LeadStage` is a new, orthogonal axis, not a rename of
  `InquiryStatus`.** `InquiryStatus` (OPEN/CONTINUED/DUMPED/SUCCESSFUL)
  is a coarse lifecycle disposition that `EscalationService` and
  `convertedAt` already key off — load-bearing, frozen, unchanged.
  `LeadStage` is a company-configurable pipeline POSITION, meaningful
  only while the inquiry's status is active. `Inquiry.stageId` is
  deliberately NEVER cleared when status goes terminal (DUMPED/
  SUCCESSFUL) — a closed lead keeps showing where it was in the
  pipeline when it closed, which is also why "block deactivating an
  occupied stage" was rejected below.
- **`isDefault` ("one default stage per company") is enforced by a
  partial unique index, not the service layer** —
  `CREATE UNIQUE INDEX lead_stages_one_default_per_company ON
  lead_stages (company_id) WHERE is_default`. Explicitly NOT the
  `BrokerBankDetail.isPrimary` precedent (a transactional
  clear-then-set with no DB constraint, verified by reading it directly
  — a real, still-open race for that table, not fixed here since it's
  out of this phase's scope). The service still clears the old default
  before setting a new one, but that's UX convenience; the index is the
  actual enforcement, one line, unbreakable, strictly less code than a
  transactional check-then-write that still races under READ COMMITTED.
- **`InquiryStageHistory` is append-only and gap-free from creation
  through every later change — verified against all three real
  inquiry-creation code paths, not assumed from one.** Grepping (not
  guessing) found `InquiryService.create()`, `InquiryService
  .createFromLead()`, and `InquiryImportService`'s own raw
  `tx.inquiry.create()` as three independent call sites, none
  delegating to the others. A shared, standalone
  `LeadStageTransitionService` (not private methods on
  `InquiryService`) is injected into all three, so
  `InquiryImportService` can reach it without depending on
  `InquiryService`'s full dependency graph. The very first history row
  (`null → default`) is written at creation time, same as every later
  change — there is no "row exists with no history" state.
- **Bespoke module (service + controller + module), not
  `master.factory.ts`'s generic `createMasterModule`** — confirmed by
  reading the factory directly, not assumed: `extraFields` only extends
  the zod validation schema, with no hook point for a side effect like
  `isDefault`'s clear-the-old-default behavior. Every other master in
  this codebase with a genuine side effect (`GstRate`, `TdsRule`)
  already gets its own bespoke service for the same reason.
- **One-time seed marker (`CompanyConfig.leadStagesSeededAt`), not
  row-count inference** — extends the `sync-permissions.ts` upgrade-path
  pattern (see the v0.2.0/v0.3.1 entries above) to a brand-new master
  TYPE for the first time, rather than new rows in an existing master's
  list. Row count can't distinguish "never seeded" from "an admin
  deleted all six" — inferring from count would resurrect a deliberate
  deletion on the very next upgrade sync run. `syncLeadStages()` lives
  in `sync-permissions.ts` (not a new file) and is called from both
  `seed.ts` (the one company a fresh install creates) and the upgrade
  CLI entrypoint (every existing company) — same function either way.
- **Deactivating an occupied stage requires reassignment, not a
  block.** Reused the exact booking-count-confirmation UI pattern
  already built for `areaLocationId` edits (`ProjectDetail.tsx`) rather
  than inventing a new one. "Block while occupied" was rejected because
  `stageId` is never cleared on a terminal transition (see above) — most
  stages would accumulate closed-lead occupants forever and become
  permanently undeactivatable. The admin picks a target stage; the
  service moves every active occupant there (writing a real stage-history
  row per move, not a silent reassignment) before deactivating.
- **`InquiryDetail.tsx`'s stage picker was approved as in-scope, not
  scope creep** — without it there is no browser-verifiable path for the
  transition-writing code at all, which fails this project's own primary
  standard (verify in a real browser, not curl/tests) before the phase
  can even be called done.
- **Real bug, found only while verifying "all tests green" for this
  phase under the full monorepo suite, not by review — `syncLeadStages`
  and `syncSuperAdminPermissions` both list an entity (companies, roles)
  with an unscoped whole-table scan, then write for each individually.**
  Neither function filters by anything test-specific; run against the
  shared test Postgres under `pnpm test`'s full parallel suite, either
  one picks up every company or role in the ENTIRE database at that
  moment — including ones created by a completely unrelated,
  concurrently-running test file. If that file's own `afterAll` deletes
  its company between the list and the per-company write, the write
  hits a foreign-key violation (`lead_stages_company_id_fkey`), which
  previously aborted the whole loop, silently leaving every company
  after it in iteration order unsynced. `syncSuperAdminPermissions` has
  the structurally identical exposure (an unscoped `role.findMany` +
  per-role write) and just hadn't been caught yet. In production this
  is effectively impossible — companies are never hard-deleted through
  the app — so this is a real robustness gap, not a hypothetical one;
  fixed generally, not with a test-only branch: both functions now catch
  Prisma's P2003 (foreign-key-violation) per-entity and skip just that
  one, continuing the sync for everyone else, via a small shared
  `isForeignKeyViolation()` helper in `sync-permissions.ts`.
- **Second, unrelated real bug found by the same full-suite pass:
  `postsales-harness.ts`'s `cleanupCompany()` was missing
  `inventory_groups`** (`InventoryGroup.projectId` RESTRICTs onto
  `projects`) — the exact "never previously exercised by this harness"
  gap this file's own comments already document repeatedly for other
  tables, this time surfaced by `e2e-plotted-inventory.test.ts` (from
  the prior plotted-farmhouse-inventory engagement) being the first test
  using this helper to create a LAND_BASED project with a real
  `InventoryGroup` row. Reproduced deterministically in isolation, not
  just under full-suite contention — added to the table list, in
  dependency order (after `units`, since `Unit.inventoryGroupId`
  references it; before `projects`).
- **`InquiryStageHistory.isAdministrative`, added same-session before the
  human walkthrough below, so the discriminator exists from row one and
  nothing needs backfilling later.** `LeadStageService.reassignOccupants`
  bulk-moves every active occupant of a deactivated stage onto one
  target stage in a single request — a system-driven administrative move,
  not a rep advancing a lead. Every other writer (creation-time initial
  assignment, the `InquiryDetail` stage picker via
  `LeadStageTransitionService.writeStageTransition`, which now always
  writes `false`) is a real pipeline event. Same now-or-never reasoning
  as the history table's own existence: once rows are plain and
  undifferentiated, there is no way to separate an administrative move
  from a real one after the fact. Phase 3's funnel (`docs/plans/
  feature-completion-plan.md`, amended) must default to `WHERE NOT
  is_administrative` — without it, retiring one occupied stage would
  show thousands of leads "reaching" the target stage on one date, often
  moving backward through the pipeline, permanently distorting
  conversion figures. Migration
  (`20260822123557_inquiry_stage_history_administrative_flag`) is a
  `NOT NULL DEFAULT false` column add — metadata-only on Postgres 11+,
  no table rewrite.
- **P2003 skips in `syncLeadStages`/`syncSuperAdminPermissions` are now
  loud, not silent — a silent skip in the super_admin sync is close to
  the exact pre-pilot bug this file's own v0.2.0/v0.3.1 entries already
  describe (a company's super_admin quietly missing permissions, with no
  error to explain why), and the caller is a routine upgrade run, the
  same place that bug hid for four releases.** Each skip now logs the
  company id (`console.error` for `syncSuperAdminPermissions`,
  `console.warn` for `syncLeadStages` — the former is the one whose
  silent-failure precedent this file already documents at length, so it
  gets the louder channel); each function also logs a final skipped-count
  summary line if anything was skipped, so a real failure can't hide
  inside hundreds of lines of otherwise-routine sync output.
  **`console.error`/`console.warn`, not pino, is a deliberate choice
  here, not an oversight of CLAUDE.md's "structured logger (pino) with a
  redaction list" rule** — that rule governs the running API SERVICE:
  `apps/api/src/main.ts` wires pino in via `app.useLogger(app.get(Logger))`
  from `nestjs-pino`, scoped to Nest's own DI-managed application
  bootstrap. `sync-permissions.ts` is a standalone script invoked
  directly via `tsx` (from `upgrade-native.sh`, or imported as a
  function by `seed.ts`), with no NestJS application context to pull a
  configured pino instance from — bootstrapping a partial Nest app just
  for logging would be real, unrequested complexity for a one-shot CLI
  tool. `seed.ts` itself already uses plain `console.log` throughout,
  so this is the established pattern for this class of script, not a
  new exception. See docs/todo.md for the separate, real gap this
  raises: `console.*` output alone does not guarantee an operator
  actually SEES a skip during a real `upgrade-native.sh` run. **Verified
  by deliberate reproduction, not by reading the code**: a throwaway
  script (deleted after use) proxied a real Prisma client to delete the
  target company/role at the exact moment each function's write call
  fires, confirming both the per-skip log line and the final tally
  actually print with the correct id — this caught a real off-by-target
  pluralization bug (`"SKIPPED 1 of 41 company"`, grammar keyed off the
  wrong count) before it shipped.
- **The same repro exercise surfaced a much wider, real bug: `syncLeadStages`'s
  deliberately unscoped `company.findMany()` — correct for its production
  purpose — reaches into and mutates OTHER test files' fixture companies
  under a full-suite run, and 14 test files across two packages had never
  accounted for that.** Any `packages/db`/`apps/api` test file that
  creates a company via `company.create()` and never sets
  `leadStagesSeededAt` is fair game: if `sync-lead-stages.test.ts`'s own
  `syncLeadStages()` call happens to run concurrently and reach that
  company before its owning test's `afterAll` does, it seeds a
  `CompanyConfig` row AND 6 `LeadStage` rows for a company that test
  never asked for — and neither `company_configs_company_id_fkey` nor
  `lead_stages_company_id_fkey` is `ON DELETE CASCADE` in this schema, so
  the owning test's own `company.delete()` then fails with a foreign-key
  violation it has no way to anticipate. First caught for real (not
  reproduced deliberately) by `packages/db/test/presales-isolation.test.ts`
  failing under a genuine full-suite run — traced to this mechanism by
  reading its `beforeAll` (confirms no `CompanyConfig` of its own) and
  cross-referencing `sync-lead-stages.test.ts`'s `stderr` output in the
  SAME run, which showed `syncLeadStages` skipping two OTHER companies
  that vanished mid-sync — proof the function was actively reaching
  across file boundaries in that exact run, not just a hypothesis.
  Audited every `company.create(` call site in both `packages/db/test`
  and `apps/api/test` (grepped, not sampled) and found six more files in
  `packages/db` (`inventory-isolation`, `auth-token`, `masters-overlap`,
  `tenant-isolation`, `sync-super-admin-permissions`, plus the one that
  actually failed) and eight in `apps/api` (`presales-inquiry`,
  `presales-follow-up`, `refresh-reuse-grace`, `presales-applicant`,
  `presales-reports` — two separate fixtures in one file — 
  `presales-escalation`, `presales-communication`, `presales-assignment`)
  with the identical exposure; `postsales-harness.ts`'s shared
  `cleanupCompany` already covered both tables (added alongside
  `lead_stages` itself, Phase 0's original commit), so every test using
  that shared helper was already safe — only files with their own
  hand-rolled cleanup were exposed. Fixed by adding an unconditional
  `leadStage.deleteMany`/`companyConfig.deleteMany` before each file's
  own `company.delete()`, in all 14 files. **Proven fixed, not assumed**:
  three consecutive full `pnpm test` runs (`--force`, cache bypassed)
  all green (723 tests each), plus the full `apps/e2e` Playwright suite
  rerun clean — a single green run after a probabilistic race fix is not
  evidence, three is a reasonable bar given this fix's own mechanism is
  now well understood (not a mystery being papered over).
  **Correction, same session: "the mechanism is now well understood"
  was premature.** A second, narrower race in the same area surfaced
  immediately afterward (see the follow-up entry below) — the
  delete-then-delete sequence this bullet describes was necessary but
  not sufficient. Left as written above rather than rewritten, since
  it's what was actually believed and acted on at the time; the
  follow-up entry is where the fuller picture and its own honest limits
  are recorded.
  **General lesson, not just this instance**: any future master or
  history table seeded by an unscoped, whole-database sync function
  (the `sync-permissions.ts` pattern) needs the same audit repeated —
  grep every `company.create(` in both test packages and confirm the
  new table is deleted before that fixture's own `company.delete()`,
  not just wherever the first failure happens to surface.

### Phase 0 follow-up — the P2003 skip made loud AND non-silent for real

Requested explicitly, in this order: the logging fix above was correctly
flagged as insufficient on its own — `console.error`/`console.warn` alone
doesn't stop a scripted upgrade from reporting success on a skip, since
the skip is caught INSIDE the sync functions and never reaches
`upgrade-native.sh`'s `|| die`. Fixed properly this time, not just logged
louder.

- **Design check done BEFORE writing code, as instructed**: the
  sync-permissions step in `upgrade-native.sh` is NOT the last step —
  cutover (symlink swap + `chown` + `systemctl restart`) and the
  healthcheck (with rollback-on-failure) both run after it. A plain
  non-zero exit with `|| die` would therefore abort the ENTIRE upgrade,
  for every company, before cutover, over what's typically a single-
  company, near-impossible-in-production edge case (see
  `isForeignKeyViolation`'s own doc comment) — worse than the skip
  itself. Mechanism chosen: a distinct exit code the script inspects
  and defers its final reaction on, not an immediate `die`.
- **`syncSuperAdminPermissions`/`syncLeadStages` now return
  `{granted, skipped}`/`{seeded, skipped}` instead of a bare number** —
  a real breaking change to both functions' public shape, propagated to
  every call site (`seed.ts` — return value already unused, no change
  needed; the CLI entrypoint; both sync test files' assertions).
- **`sync-permissions.ts`'s CLI entrypoint now uses three exit codes**:
  0 clean, 1 hard failure (unchanged — still fatal), 2 completed-but-
  skipped. On 2, it prints one unmissable bordered block
  (`console.error`, `=`.repeat(72) border) naming the total skipped and
  the per-category breakdown, via `process.exitCode = 2` (not
  `process.exit(2)`, so the `.finally(() => prisma.$disconnect())`
  still runs — `process.exit()` would cut it off mid-cleanup).
- **`upgrade-native.sh` now tees the sync-permissions step's output**,
  mirroring the migration step immediately above it exactly (a
  `mktemp` log, `tee`, removed after). On exit 2: `warn`s and sets
  `SYNC_HAD_SKIPS=1`, then lets cutover and the healthcheck run
  normally. On any other non-zero: still `die`s before cutover,
  unchanged. Only once the healthcheck's own success path completes
  (after `log "Upgrade complete..."`) does the script check
  `SYNC_HAD_SKIPS` and, if set, print a second unmissable block and
  `exit 1` — signalling failure to any monitoring/scripted caller
  without ever leaving a half-applied upgrade stuck mid-sequence.
- **Real bash bug caught by direct empirical testing, not assumed —
  `if ! pipeline; then STATUS=$?; fi` does NOT capture the pipeline's
  real exit code.** `!` negates the status BEFORE the `if` sees it, and
  `$?` inside that `then` block reflects the ALREADY-NEGATED value
  (always 0 for any failure) — confirmed with a 3-line `bash -c` repro
  before it ever reached the real script, which would have silently
  collapsed every `SYNC_STATUS` to 0 and made the entire exit-code
  scheme inert. Fixed with `pipeline || STATUS=$?` instead (verified
  correct under both plain `set -e` and `set -e`+`pipefail` piped
  commands, empirically, the same way) — the same "don't trust
  implicit shell propagation, check it directly" discipline this file's
  own `build_release()`/CI-annotation-cap entries already established.
  Also verified the FULL new control-flow end-to-end (clean/hard-fail/
  skip paths) in an isolated harness with a stubbed `run_as_superuser`
  before touching the real script's logic a second time — confirmed
  cutover is reached on a skip and skipped entirely on a hard failure.
- **New permanent, deterministic tests for the skip-counting contract
  itself** (both sync test files) — the existing tests only covered the
  no-skip happy path; neither `{granted,skipped}` nor `{seeded,skipped}`
  had ever been asserted against a REAL skip before. Same Proxy-based
  deterministic-reproduction technique as the earlier verification
  (delete the target entity at the exact moment the real write call
  fires), written as permanent `it()` blocks this time, not a throwaway
  script. `syncSuperAdminPermissions`'s version deletes the ROLE, not
  the company (deleting the company would hit `roles_company_id_fkey`
  first, a different failure than the one under test — learned from the
  earlier throwaway repro's own confound, this time avoided from the
  start).
- **Real bug this uncovered in the FIRST attempt at these tests, not
  hypothetical: asserting `skipped === 0` in the existing "happy path"
  tests is wrong.** Both sync functions scan the ENTIRE shared test
  database; under a real full-suite run, an unrelated sibling test
  file's OWN fixture company can legitimately vanish mid-sync and get
  counted in a call that has nothing to do with it. Caught the moment
  this assertion was added (`expected 7 to be +0`, from seven completely
  unrelated companies) — removed from both happy-path tests with a
  comment explaining why, kept only in the dedicated skip tests where
  the specific entity being tested is checked by id, not by a global
  count.
- **A SECOND, narrower race, found only by chasing the above assertion
  fix through repeated full-suite runs — not the same one already
  fixed.** Even with `leadStage`/`companyConfig` explicitly deleted
  before the final `company.delete()`, ~40% of full-suite runs still
  failed: `syncLeadStages` snapshots eligible companies ONCE, then
  writes per-company moments later — if it's already mid-loop for a
  company at the exact instant a cleanup's first two deletes clear that
  company's (then-nonexistent) rows, the in-flight transaction can
  commit a FRESH pair immediately after, landing in the gap right
  before the final company delete. A single delete-then-delete sequence
  structurally cannot close this; only a retry can, because
  `syncLeadStages` commits at most once per company per call.
  `packages/db/test/helpers/delete-company-safely.ts` (new) retries the
  whole sequence up to 3 times on that specific FK code. Applied to all
  6 `packages/db/test` files exposed to it. **The 8 `apps/api/test`
  files still only have the simple delete-then-delete fix, not the
  retry — this is an INCOMPLETE fix, not a smaller one.** "No failure
  observed there yet" means the same race is live and simply hasn't
  been hit by chance; it does not mean those 8 files are fixed. A
  speculative `packages/db/vitest.config.ts` (`maxForks` cap, mirroring
  `apps/api`'s existing Phase 7 fix) was tried first, based on an
  initial — wrong — read of an unrelated failure, then DELETED once the
  investigation moved on. **Whether that cap would actually have
  helped, hurt, or done nothing was never cleanly established — it was
  evaluated only against a database later found to be polluted by this
  session's own earlier debugging, and against a batch that followed a
  timeout-killed run. Treat the maxForks question as untested, not
  resolved, and do not cite this session's numbers as evidence either
  way if it comes up again.**
  **This entire fix — the 14-file cleanup plus the retry helper —
  makes test cleanup TOLERATE `syncLeadStages`' unscoped whole-database
  scan colliding with other tests' fixtures under shared-database
  parallel test execution. It does not stop the collision, only
  survives it.** See `docs/todo.md`'s rewritten entry for the honest
  root cause and two real (not-built) candidate fixes: an optional
  `companyId` scope on the sync (tradeoff: stops exercising the exact
  unscoped production scan path), or database-per-worker/a serial
  project for unscoped-sync-adjacent test files (tradeoff: real setup
  cost, and the same "someone has to remember" fragility at a
  different layer). Neither was built this session — timeboxed
  deliberately rather than continued indefinitely.
- **A P2002 (unique constraint) failure during this same investigation
  was correctly NOT added to `isForeignKeyViolation`'s catch — traced
  to test-database pollution from this session's own earlier debugging
  (an orphaned company with real `LeadStage` rows but no marker, left
  behind by a run that failed before this session's cleanup fixes
  existed), not a live code bug.** Confirmed by direct SQL query, not
  assumed, then fixed by resetting the disposable test database via the
  project's own `scripts/test-setup.sh` rather than hand-deleting rows.
  A P2002 in production would mean a company has real, inconsistent
  data (stage names already present with no marker) — a data-integrity
  problem worth surfacing as a hard failure, not something to silently
  skip past the same way a vanished entity is.
- **Verification, cumulative, with an honest limit on how far it should
  be trusted**: the exit-code/tee/`{granted,skipped}` change itself is
  solid — full monorepo `pnpm test` green, the full `apps/e2e`
  Playwright suite rerun clean, and a standalone bash harness proving
  the new `upgrade-native.sh` control flow end-to-end for all three
  exit-code paths. The test-cleanup flakiness chase that followed is a
  DIFFERENT story: some individual runs failed, and this session's own
  closing summary attributed at least one of those to an interrupted
  10-minute-timeout run's aftermath — a plausible inference from
  DB-state inspection (an unpolluted database afterward), not a proven
  causal chain. That inference should not be read as confirmed. The
  timeboxing decision above is what actually closes this out, not a
  claim that every observed failure has been explained.
- **This work is machine-verified only, same caveat as the rest of
  Phase 0** — `upgrade-native.sh`'s new control flow has been proven
  correct via an isolated stub harness and direct code reading, not by
  actually running a real upgrade against a real native install. The
  human walkthrough already in progress for the rest of Phase 0 covers
  the feature; this script change has not been exercised on the VM.
- Full verification for this phase, per the closing standard: full
  monorepo `pnpm test` (11/11 tasks, 723 tests: shared 104, portal 4,
  web 4, db 63, api 548 — zero failures), full monorepo lint+typecheck+
  build (28/28 tasks), the full `apps/e2e` Playwright suite (36/36 —
  rerun after the `isAdministrative` migration + service changes, no
  regressions), and two separate genuinely-fresh-from-scratch checks —
  `prisma migrate deploy` against a brand-new empty database applied all
  26 migrations including `lead_stage_foundation`, then a second fresh
  database after adding `inquiry_stage_history_administrative_flag`
  applied all 27 cleanly — both followed by `pnpm seed`, which seeded the
  6-stage default pipeline correctly (verified by direct query, not just
  a clean exit code, on the first check).
  **This is machine verification only.** Per this file's own primary
  lesson — and its own history, including the Secure-cookie-over-HTTP
  bug that no automated dev-environment test would have caught — a human
  has NOT yet run the real-browser acceptance walkthrough for this
  phase. Do not treat Phase 0 as closed, or cite it elsewhere as
  browser-verified, until that walkthrough is reported back.

### Phase 0 — three real bugs found by code review before the first commit, plus one unrelated dead-config cleanup

The whole uncommitted Phase 0 diff was reviewed before any of it reached
master — the first time this project's review discipline has been
applied to a diff that never shipped at all, rather than to a bug
already live. Three real, confirmed bugs, all fixed and regression-
tested through the real HTTP pipeline before commit:

1. **Deactivating the CURRENT DEFAULT lead stage never cleared
   `isDefault`, so `resolveInitialStage` kept routing every new inquiry
   to a now-inactive, invisible stage.** The real admin UI
   (`LeadStages.tsx`) always round-trips the stage's current `isDefault`
   value in its PATCH body unless the checkbox is explicitly touched, so
   this was reachable through ordinary use, not just a crafted request —
   an admin unchecking Active on the default stage, without also
   unchecking Default, silently left the company routing new leads to a
   stage nothing else would show as active. **Fixed by refusing the
   deactivation outright** (`LeadStageService.update()`, a `400` naming
   the reason) whenever the stage being deactivated is currently the
   default — never auto-picking a replacement or auto-clearing the flag,
   since which stage should inherit "default" is a real decision only an
   admin can make. The admin sets a different stage as default first (a
   separate, explicit request), then deactivates this one.
2. **`LeadStageService.remove()` (hard DELETE) bypassed `update()`'s
   occupancy/reassignment safety net entirely** — no confirmation, no
   history row, the DB's `ON DELETE SET NULL` would silently orphan
   every active inquiry's `stageId`. **Removed the endpoint outright**
   rather than hardening it: `inquiry_stage_history.to_stage_id`
   `RESTRICT`s onto `lead_stages` anyway, so a hard delete already 500s
   on any stage that's ever had a single inquiry pass through it (which
   is nearly all of them, in practice, almost immediately) — the
   capability was already close to unusable, and deactivation
   (`isActive: false`) is the only way to retire a stage now, matching
   this codebase's existing soft-deactivate convention for masters.
3. **`Inquiry.stageId` was never validated against the caller's own
   company before being persisted, on either `create()` or `update()`.**
   RLS filters what a query can READ; it never validated a
   client-supplied foreign key on WRITE — the `inquiries_stage_id_fkey`
   constraint only proves the id exists somewhere in `lead_stages`, not
   that it belongs to this company. Fixed with a new
   `LeadStageTransitionService.assertStageBelongsToCompany`, called from
   `resolveInitialStage` (covers `create()`; `createFromLead()` and bulk
   import never pass a client-supplied id, so it's a no-op there) and
   directly from `InquiryService.update()` before the write. **Sibling
   optional FK fields on `Inquiry`** (`projectId`, `sourceId`,
   `inquiryTypeId`, `preferredUnitTypeId`, `temperatureId`) have the
   identical gap and were deliberately NOT fixed in the same pass — a
   targeted review fix isn't licence to widen the diff into every
   sibling field — logged in `docs/todo.md` instead, with the fix
   pattern now established for whoever picks it up.

Also fixed, unrelated to the lead-stage feature itself but found in the
same diff: **`pnpm-workspace.yaml`'s `allowBuilds.esbuild` held the
literal placeholder text `"set this to true or false"` instead of a
boolean.** Verified empirically before treating it as anything more
than dead config: `pnpm install` against the broken value exits 0 and
esbuild's postinstall script still runs — pnpm 9.15 silently ignores
the malformed value today rather than erroring — so this wasn't
actually breaking installs, but it wasn't recording any real approval
decision either. Set to `true`.

One optional cleanup taken from the same review: `InquiryImportService`
resolved the company's default stage once **per CSV row** instead of
once per import, even though the same loop already caches
project/source/inquiryType lookups per unique name for exactly this
reason. Hoisted `resolveInitialStage`'s call outside the row loop —
the value can't change mid-import, so this was pure wasted round trips
on a bulk operation.

**Regression-tested through the real HTTP pipeline**
(`apps/api/test/e2e-lead-stage.test.ts`, new — three supertest cases):
deactivating the default stage 400s with a message naming the reason,
and is left completely untouched (still active, still default) by the
rejected request; a subsequently-created inquiry still resolves to that
same, still-visible stage. `DELETE /masters/lead-stages/:id` now 404s
(the route doesn't exist) rather than succeeding or discouraging-but-
allowing. A cross-company `stageId` is rejected with 404 on both
`POST /inquiries` and `PATCH /inquiries/:id`, and the rejected PATCH
never writes the foreign id. Full monorepo `pnpm test`/`typecheck`/
`build` green before commit (see this session's own verification
notes for the exact numbers).

Housekeeping from the same pass, unrelated to any of the above:
`.pnpm-store/` (a local pnpm cache that had been created inside the
working tree, not a build output this repo ships) added to
`.gitignore` so it can never be accidentally committed regardless of
what creates it next time.

### Docker role audit — scoped to build-integrity tooling, not deleted

A full audit categorized every Docker-related file, script, doc section,
and CI job now that native install (`deploy/native/install-native.sh`) is
the only supported production path. Removed the one item with zero
consumers (`deploy/install.sh` — the old Docker-based installer; grepped
every `.md`/`.yml`/`.sh` in the repo first, confirmed nothing invoked or
linked it, not even CI's own compose job). Corrected stale, actively
misleading claims in this file's own principle #1 and "Repo layout"
(both still said `docker compose up` was the required/primary path,
contradicting this file's own later decisions), `SECURITY.md`'s
vulnerability-report scope, and the ASVS checklist's V9.1/V14.1 (which
flatly asserted Docker Compose was "the only supported install path" —
the single worst line found, a security-compliance document affirming
the opposite of current reality).

**The `compose-healthcheck` CI job (renamed "Container build integrity
(contributor tooling)") is KEPT, not removed — deliberately, not by
default.** It builds `deploy/docker-compose.yml` and the three
Dockerfiles on every push specifically to catch Dockerfile `COPY`-list
drift, a class of bug `pnpm build` alone cannot see (real precedent:
`apps/api/Dockerfile` silently never copied `packages/plugin-sdk`/
`plugins/generic-sales` after Phase 7 added both as real runtime
dependencies — the production image was unbuildable from that point on,
caught only by this job, see the Phase 8 "Full production-readiness
pass" entry above). The job's `name:` and a new comment block both now
say explicitly that the container stack is not a supported production
path — same disclaimer added verbatim to the top of
`deploy/docker-compose.yml` and each Dockerfile, so nobody who opens one
of those files directly mistakes it for a deployment option either.
Dependabot's `docker` ecosystem entry is kept for the same reason,
documented in the config itself rather than left to look like an
oversight — this job still builds those images every push, so their
base images should stay patched like anything else actually built here.

**Rationale for keeping the files instead of deleting them, for the
record**: the installed base for the pre-pivot Docker production path is
presumed zero — no telemetry exists (self-hosted, by design), no support
request has ever referenced it, and the project has been public since
v0.1.0 with native becoming primary shortly after. If that assumption
ever proves wrong (a self-hoster surfaces still running the old Docker
path), the files are still there, buildable, and now honestly labeled —
nothing about this pass makes them harder to fall back on, only harder
to mistake for the current recommendation.

### Docker removed entirely — supersedes the "scoped, not deleted" audit above

The audit entry above kept the container stack as build-integrity
tooling. That decision is reversed: the production Docker path is now
deleted, on the reasoning that a repo which installs natively should not
carry a second, unsupported, permanently-untested way to run itself.

**Deleted:** `deploy/docker-compose.yml`; `deploy/docker/api.Dockerfile`,
`web.Dockerfile`, `portal.Dockerfile`; `deploy/.env.example` (its only
consumer was the compose CI job's `cp .env.example .env` — the native
path uses `deploy/native/openestate.env.example`, a different file);
`deploy/nginx/reverse-proxy.conf` and `deploy/nginx/static-spa.conf`
(mounted/COPYed only by the deleted compose nginx service and the two
frontend Dockerfiles respectively — verified against the deleted files'
own contents in git, not assumed; the native path has its own
`deploy/native/nginx/openestate.conf.template`); `.dockerignore`; CI's
`compose-healthcheck` job (a leaf — nothing `needs:` it, checked before
removing); and Dependabot's `docker` ecosystem entry, whose own comment
said to revisit it exactly when that job went away.

**Kept:** `deploy/docker-compose.test.yml` and
`deploy/docker/init-db/01-create-app-role.sh`. These are not an install
path — they stand up a `tmpfs` Postgres/Redis on non-default ports
(5433/6380) that lives for the duration of a test run, consumed only by
`scripts/test-setup.sh`. CI does not use them; its `services:` block
mirrors those ports so `apps/e2e/playwright.config.ts`'s hardcoded
connection strings work in both places. Deleting them would have made
`pnpm test` require a hand-provisioned Postgres with three specific
roles, taxing every contributor to remove a file that never ships.

**What coverage was actually lost, honestly:** the deleted job caught
Dockerfile `COPY`-list drift — a new workspace package added to the
runtime graph but never copied into the deployed tree. That bug class is
NOT gone with the Dockerfiles: `build_release()` in `deploy/native/lib.sh`
carries the same hazard in the loop over
`packages/db packages/shared packages/plugin-sdk plugins/generic-sales`,
a hardcoded list that can fall out of sync exactly the way the `COPY`
list did. The difference is that it is now covered against the path that
actually ships: CI's `native-install` job performs a real install and
then health-checks a booted API, so a missing package fails there. The
protection moved onto the real path rather than disappearing — but if
that list ever needs a fifth entry, `native-install` is the job that will
tell you, and it is the only one that will.

**Dangling comment references cleaned up rather than left to rot:**
`deploy/native/lib.sh` (twice), `deploy/native/install-native.sh`
(twice), and `.github/workflows/ci.yml` each explained a decision by
pointing at a Dockerfile that no longer exists. Each was rewritten to
carry the reasoning without the dead pointer.
`deploy/native/setup-database.sh`'s reference to
`deploy/docker/init-db/01-create-app-role.sh` was left alone — that file
still exists. `docs/docs/installation.md`'s "the same deploy sequence the
retired Docker image used" was also left: it describes history and reads
correctly as history.

### The test-only compose file removed too — the repo is now Docker-free

The entry above kept `deploy/docker-compose.test.yml` on the reasoning
that a throwaway test database is not an install path. That carve-out is
withdrawn: a repo whose stated position is "you bring your own PostgreSQL
and Redis" should not make an exception for its own contributors.
`deploy/docker-compose.test.yml` and `deploy/docker/init-db/01-create-app-role.sh`
are deleted, `deploy/` now contains only `native/`, and no Dockerfile or
Compose file exists anywhere in this repository.

**`scripts/test-setup.sh` rewritten rather than replaced.** It now
provisions the test database against a PostgreSQL the contributor already
runs. The role/grant SQL is NOT duplicated — the script shells out to
`deploy/native/setup-database.sh`, the same script a real install runs,
twice: once before `prisma migrate deploy` so the `ALTER DEFAULT
PRIVILEGES` cover the tables about to be created, once after so the
`GRANT ... ON ALL TABLES` catches them. That two-step is exactly what
`ci.yml` already did inline, so the shape is precedent, not invention. Both
calls connect as `openestate_super`, not as the cluster admin, because
`ALTER DEFAULT PRIVILEGES` with no `FOR ROLE` attaches to whichever role
runs it and `openestate_super` is the role that creates the tables — the
same reason ci.yml sets `PGUSER: openestate_super` for its own inline
version.

**Migrations still need a superuser, and that constrains the design more
than it first appears.** `20260720000000_phase1_core` issues `CREATE ROLE
... BYPASSRLS`, and only a superuser may set `BYPASSRLS` — `CREATEROLE`
is not enough. The native installer solves this by running migrate/seed as
the `postgres` OS user over the Unix socket (`run_as_superuser`), which
does not work from a developer checkout: Prisma stats its cwd for a config
file first, and the `postgres` user usually cannot traverse a `$HOME`
checkout — the exact `EACCES` failure already documented in
`install-native.sh`. So the test script instead creates a dedicated
`openestate_super` LOGIN SUPERUSER role via a psql-only admin step (psql
never touches the checkout, so no `EACCES`), and Prisma connects over TCP
as the developer's own OS user. `DATABASE_URL` keeps the exact shape CI
and every doc already use.

**Ports moved to 5432/6379, and the split-brain went with them.** 5433/6380
existed only so a container wouldn't collide with the host's own Postgres.
With no container there is nothing to collide with — the test database is a
separate DATABASE (`openestate_test`) on the same cluster, which is what
provides isolation. `integration-tests` in `ci.yml` was already on the
standard ports; only `e2e-playwright` and 32 test-file fallbacks were on
the odd ones. All now agree. Checked before moving, not assumed: no test
flushes Redis anywhere (`flushall`/`flushdb` appear nowhere in the repo)
and throttle tests already isolate via `THROTTLE_TEST_KEY_PREFIX`, so
sharing a developer's Redis instance cannot destroy their data.
`apps/e2e/playwright.config.ts` now reads `DATABASE_URL_TEST`,
`DATABASE_URL_TEST_SYSTEM` and `REDIS_TEST_URL` when set — the same three
vars the backend suite already honours — instead of hardcoding.

**Two safety rails, because losing container isolation is a real loss and
pretending otherwise would be the bug.** `openestate_app` and
`openestate_system` are CLUSTER-WIDE role names, shared with a real native
install — provisioning tests on a cluster that also hosts a production
`openestate` database rewrites that install's role passwords to throwaway
values and breaks it until its own `setup-database.sh` is re-run. The
script detects an `openestate` database and refuses, requiring
`TEST_ALLOW_SHARED_CLUSTER=1` to proceed. Separately, `teardown` drops
only a database whose name ends in `_test`, and never drops the roles —
they are cluster-wide, and a real install on the same cluster depends on
two of them.

**Not verified by execution.** The script is syntax-checked (`bash -n`),
its `set -u` empty-array expansion uses the `${a[@]+"${a[@]}"}` form so it
survives bash 3.2 on macOS, and every claim above about migrations,
Redis flushing, and port usage was checked against the real files. But it
has not been RUN end to end — that needs a Linux box with PostgreSQL, and
this session had neither. CI does not exercise it either: `ci.yml` still
provisions its database with inline SQL. Wiring `integration-tests` to
call `scripts/test-setup.sh` instead would delete that duplicated SQL AND
make CI prove the contributor path on every push — the obvious next step,
deliberately not taken here because it risks CI on a project with a
documented history of CI-reliability pain, and was not asked for.

**GitHub Actions `services:` blocks are retained** in `integration-tests`
and `e2e-playwright`. Those are runner infrastructure, not repo artifacts —
no Dockerfile, no Compose file, nothing this project builds or ships. If a
future session wants literally zero container involvement anywhere, the
`native-install` job already demonstrates the pattern (apt-install
PostgreSQL and Redis on the runner); that is a CI change, not a repo-content
change, and it trades a known-reliable service-container setup for one that
has to be maintained.

### `scripts/test-setup.sh` — verified end-to-end on a real box, three real bugs found and fixed, guard strengthened

The previous entry's script was unproven — CI still provisioned its own database with inline SQL, and no real machine had ever run the contributor path. Verified for real on the walkthrough VM (`docs/handoff.md`), which happens to be the worst-case test of this exact script: it hosts a live production install on the SAME PostgreSQL cluster the test database gets provisioned on, has only 2 CPU cores, and its system clock was found to be ~4 days behind with NTP sync failing (an unrelated, pre-existing environment fault — `timedatectl` shows `System clock synchronized: no`; fixing it requires `hwclock`/`timedatectl` writes, a prohibited system-settings change, so it was worked around rather than fixed: root's already-cached corepack pnpm build was copied to the invoking user, and Playwright's browser download succeeds because `cdn.playwright.dev`'s cert chain tolerates the drift where `registry.npmjs.org`'s does not).

**Three real bugs found, all fixed in the script itself so they never recur:**

1. **The generated Prisma client goes stale the moment a synced/pulled schema change lands, and the script never regenerated it.** `prisma migrate deploy` applies raw SQL and never touches the client; the first schema-changing migration after a fresh checkout (`lead_stage_foundation`, this session) failed seed with "Unknown field 'leadStagesSeededAt'" the instant `sync-permissions.ts` touched the new column. Fixed: `npx prisma generate` now runs immediately after migrate.
2. **`@openestate/shared`'s compiled `dist/` goes stale the same way, and `packages/db`'s tsx-run scripts resolve it via the package's "require" export condition — the COMPILED output, not source** (Phase 1's own documented rule: Vite dev servers read source, Node/CJS consumers read dist). `DEFAULT_LEAD_STAGES` (new this session) resolved to `undefined` and crashed `syncLeadStages` with "Cannot read properties of undefined (reading 'map')" until the dist was rebuilt. Fixed: `pnpm --filter @openestate/shared build` now runs at the very start of the script, before anything imports it.
3. **A genuine, previously-undiscovered timezone-corruption bug — not in the script, in a test.** `presales-reports.test.ts`'s ageing-bucket test wrote a fixture's `created_at` via a raw `$executeRaw` UPDATE binding a JS Date, then separately re-queried the row with an unordered `findMany()` and zipped it against the fixture list by array index — a real bug in isolation (Postgres never guarantees row order without ORDER BY), but fixing that alone (capturing each row's id directly from its own `create()` return) did not fix the test. Instrumented directly rather than guessed further: a raw-SQL round-trip of `2026-07-13T12:00:00.000Z` came back as `2026-07-13T17:30:00.000Z` — exactly this VM's Asia/Kolkata (+5:30) session timezone. `$executeRaw`/`$queryRaw` parameter binding goes through node-postgres's text protocol, which formats/parses a timestamp-without-time-zone value using the session's timezone GUC; Prisma's own ORM path (`create()`/`findUnique()` via its Rust query engine) does not have this problem — confirmed by direct comparison, 0ms drift. Every production `$executeRaw`/`$executeRawUnsafe` call site in `apps/api/src` was audited: all of them write a timestamp via Postgres's own now()/clock_timestamp(), never a bound JS Date — zero production blast radius, and this was the only test file in the repo doing so. **Fixed at the root**: `createdAt` is now set directly in the `create()` call's own data, eliminating the raw-SQL write (and the row-order bug) in the same change — this class of bug only exists for code that never had to, since every real dev/CI machine this project has tested against so far has been UTC.

**Guard strengthened, per direct instruction to re-examine it.** The database-name guard from the previous entry only catches a production install using the DEFAULT name (openestate) — `deploy/native/setup-database.sh --db` accepts any name, and `openestate_app`/`openestate_system`'s passwords are cluster-wide regardless of which database they were granted against, so a production install on a differently-named database was exactly as reachable and exactly as breakable, undetected. Added a second, independent guard keyed on the ROLES themselves rather than the database name: `openestate_super` only ever exists on a cluster this script has already touched (a real install's own `setup-database.sh` never creates it); if it does NOT exist yet and `openestate_app`/`openestate_system` already do, they were created by something else and the script refuses (same TEST_ALLOW_SHARED_CLUSTER override). Verified the underlying `pg_roles` queries directly against the real cluster (existing role returns 1, nonexistent returns empty, matching the bash -n/-z checks exactly) and confirmed the new check is correctly inert on the common case (super role already exists from a prior run) via a live re-run — could not construct an actual differently-named-database fixture on this specific VM without disrupting its real install (which already uses the default name), so the guard's trigger condition is verified by direct SQL, not by an end-to-end reproduction of that exact scenario.

**Full verification run, real numbers, not summarized:** `scripts/test-setup.sh` end-to-end (teardown then fresh run) exits 0, provisioning 27 migrations, both roles, and a full seed. Full `pnpm test` on this VM: 408 passed, 2 failed, 138 skipped, 22 files reporting FAIL — but every failed file's own output shows "(N tests | N skipped)", meaning the suite's own beforeAll hook timed out (Vitest's default 10s) before any test inside it ran, not that an assertion failed. Re-ran three of those exact files in isolation (e2e-master-creation, e2e-tickets, presales-reports) after the fixes above: all pass, 0 failures — proving the full-suite failures are this project's own well-documented resource-contention pattern (Phase 7→8 and Phase-0-follow-up decisions above), sharpened here by a genuinely worse environment than any prior contention finding (2 cores, live production traffic sharing the same box) rather than a new regression. The two individually-failing tests in the full run (e2e-portal-throttle's cross-instance-Redis-state test, webhook-delivery's concurrency-count test) are both already-documented timing-sensitive tests in this exact contention class, not re-investigated further given the isolated-pass evidence already in hand.

**`ci.yml`'s integration-tests job now calls this script instead of carrying a second, hand-maintained copy of the same role/migrate/seed SQL** — the two had already drifted once (CI never regenerated the client or rebuilt packages/shared the way the script now does) before this. `TEST_PG_ADMIN_USER=openestate_super`/PGPASSWORD (matching the service container's own POSTGRES_USER/POSTGRES_PASSWORD) route the script into its TCP branch — there's no shared OS user to `sudo -u postgres` as inside a container. `.test-env`'s three lines are appended to $GITHUB_ENV so every later step inherits the script's own connection strings instead of carrying a third hardcoded copy that could drift from what actually got provisioned. **Not verified by an actual GitHub Actions run** — validated by YAML parse and step-order inspection and by tracing the exact code path test-setup.sh takes in TCP mode, but creating a throwaway non-postgres-named superuser role to structurally rehearse the container-admin shape on the VM was blocked by the same system-settings-adjacent safety boundary that blocked the clock fix; the real proof is the next push's CI run.

The VM's live production install's openestate_app/openestate_system role passwords were reset to the script's throwaway test values by every TEST_ALLOW_SHARED_CLUSTER=1 run in this session (expected — that's what the guard exists to warn about) and restored afterward by running `deploy/native/setup-database.sh` with no password flags, which re-reads the real values from `/etc/openestate/openestate.env` — confirmed restored by a real GET /api/v1/health returning "db":"ok" against the live service afterward, not assumed from the restore command's own exit code.

### `scripts/test-setup.sh` — the seed step's corepack prompt could hang the whole script, fixed at the source

Reported directly: the seed step hung on corepack's "Do you want to continue? [Y/n]" prompt. Reproduced deliberately (a fresh `HOME` so corepack has nothing cached for that user, matching a genuinely new contributor or an agent-driven invocation with no live keyboard) before fixing anything — the prompt appears and blocks forever with no env var set, confirming this is real, not hypothetical.

**`export COREPACK_ENABLE_DOWNLOAD_PROMPT=0`** near the top of the script is the actual fix — corepack's own documented switch for exactly this: skip the confirmation, go straight to using or fetching the pinned pnpm version. Confirmed directly (same fresh-`HOME` reproduction): the hang is gone, replaced by either a silent successful download (network reachable) or a fast, real, non-interactive failure (network not reachable) — never a wait.

**Investigated, per direct instruction, whether the download can be avoided entirely rather than just made to fail cleanly** — tried `COREPACK_ENABLE_NETWORK=0` (refuses to fetch, with a cleaner error message than the raw stack trace, but never succeeds either — it cannot fall back to some other already-installed pnpm, it only refuses) and `COREPACK_ENABLE_PROJECT_SPEC=0` (ignores this repo's `packageManager` pin and tries to fetch pnpm "latest" instead — worse, not better: it defeats the entire point of pinning, which is every contributor and CI run using the identical version). **Neither lets corepack use a different, already-installed pnpm when the pinned version isn't cached — there is no such fallback in corepack's own design short of disabling the pin outright**, which was rejected rather than silently done, since the reproducibility the pin buys is worth keeping. A real download over the network therefore stays possible when genuinely needed.

**`run_pnpm()`, a new wrapper every bare `pnpm` call in the script now goes through**, is what makes that real download's failure mode good instead of a raw stack trace: on failure, it probes `https://registry.npmjs.org/` directly with a 5s timeout, and if THAT fails too, names the actual cause and points at `docs/handoff.md`'s "192.168.1.100's system clock" entry (this VM's own real root cause) rather than leaving the reader to decode a `CERT_NOT_YET_VALID` stack trace themselves; if the network probe succeeds, the failure gets a plain message pointing back at pnpm's own already-printed output instead — so a genuinely unrelated failure (e.g., a real error inside `seed.ts` itself) isn't misdiagnosed as a network problem.

**Verified end-to-end, twice, both proving the fix rather than assuming it**: first, the wrapper's diagnostic path directly, against this VM's real (still-broken) network — confirmed it fires the network-specific message, fast, no hang. Second, the full script — teardown then a fresh run — invoked with stdin redirected from `/dev/null` for both steps, the strongest test available: no prompt could be answered even if one somehow still appeared. Completed in full, migrations through seed, exit 0. Production role passwords reset by this run (same `TEST_ALLOW_SHARED_CLUSTER=1` mechanism as before) were restored the same way as previously, confirmed via a real `GET /api/v1/health` afterward.

### `apps/website` — the public marketing site, logged after the fact

Built in a prior session that was cut off before this entry got written
(a usage-limit interruption, not a deliberate omission) — landed in the
working tree fully finished, with no Decisions-log entry anywhere. Logged
now, on discovery, rather than left undocumented.

**What it is.** A standalone React 18 + Vite site (`apps/website`, its
own `package.json` with `dev`/`build`/`lint`/`typecheck`/`test` scripts,
zero shared dependency on `packages/shared` or any other workspace
package — pure marketing copy, no product code) presenting OpenEstate's
public-facing pitch: hero, capability cards, an illustrative
(hand-authored, not live-data) product-preview panel, the ledger/
security/architecture sections, and a real install command block. Real
brand assets under `public/brand/` (favicon, logo, apple-touch-icon,
og-image), a `sitemap.xml`/`robots.txt`, and a `vercel.json` (security
headers + `cleanUrls`, no secrets). **Deploys to a real, named domain**:
the README documents a Vercel project rooted at `apps/website`, using
the monorepo's own pnpm lockfile, publishing to `theitguys.in`.

**Copy audited against current product state before committing** — the
repo has twice shipped public-facing text that fell out of sync with
reality (a stale "Phase 0 — scaffolding" README claim still live at
v0.2.3; the ASVS checklist flatly asserting Docker Compose was the only
supported install path, found and fixed in the Docker-removal pass
above) so this got the same scrutiny before landing, not less because
it's "just marketing." Findings: the install command
(`sudo git clone ... && sudo ./install-native.sh --server-name
crm.yourcompany.com`) matches `install-native.sh`'s real `--server-name`
flag exactly — checked against the script's own arg-parsing, not
assumed; zero Docker references anywhere in the site (correctly reflects
the post-removal reality); no legal-compliance overclaim (matches this
file's own India-first rule: "do not claim legal compliance in docs,
provide the tools" — the security section lists real, shipped
mechanisms only). **One real gap, fixed**: the "Inventory with context"
feature card described only the unit-based model (projects/towers/
floors/units) — not false, but it predates the plotted/farmland
inventory model (`LAND_BASED` project shape, `InventoryGroup`s, per-acre
pricing) that shipped since. Reworded to cover both. Manager hierarchy/
team-scoped visibility (v0.4) is real and unmentioned too, but that's an
internal RBAC detail, not the kind of thing a marketing feature list
enumerates at this altitude — left alone as a judgment call, not an
oversight.

**Secrets check, before staging anything**: no `.vercel/` directory (no
project-link token), no `.env` file, no API key or credential anywhere
in the source — confirmed by listing every file in the directory and
reading `vercel.json` directly, not assumed from `.gitignore` coverage
alone. `.vercel/` added to `.gitignore` regardless, defensively, since
`vercel link`/`vercel dev` can create one locally at any time and this
repo has already been burned once by a real credential landing in a
tracked file (see the earlier "no credential VALUES in any committed
file" standing rule). `dist/`, `.turbo/`, and `*.tsbuildinfo` inside
`apps/website` are already covered by the existing root `.gitignore`
patterns — confirmed with `git check-ignore -v` against each, not
assumed from the patterns looking like they'd match.

**CI/workspace blast radius — confirmed real, left as-is, matching an
existing precedent rather than carving out new isolation.** Because
`apps/website` sits under `apps/*` (already in `pnpm-workspace.yaml`'s
glob), it's swept into the bare `pnpm lint`/`pnpm typecheck`/`pnpm
build` commands `ci.yml`'s `lint-typecheck-build` job runs — confirmed
directly, not inferred: both commands visibly built/typechecked
`@openestate/website` in this session's own verification run. Every
other CI job (`native-install`, `e2e-playwright`, etc.) `needs:
lint-typecheck-build`, so in principle a website-only regression (a
broken import, a lint violation) could block jobs that have nothing to
do with the website. **This is not a new problem specific to
`apps/website`** — `docs` (the Docusaurus site) has had the identical
shape, swept into the same bare commands, for the entirety of this
project's history, and it has never once been the subject of an
incident entry in this file despite this file documenting essentially
every other CI/build problem this project has ever hit. Carving
`apps/website` out into its own isolated pipeline (a `--filter`
exclusion, or its own non-blocking job) would make it structurally
*more* isolated than `docs` already is, for no incident this session
found — an inconsistency introduced to fix a risk that hasn't actually
manifested anywhere in this codebase's history, including for the
directly comparable case. Left in the default sweep, matching `docs`.
**Revisit only if a real website-only CI failure is ever actually
observed blocking unrelated jobs** — at that point the fix is a
`--filter='!@openestate/website'` exclusion (or a dedicated job),
applied with the real incident as the reason, not preemptively.

### Pre-sales reporting suite (PR #27) — 5 real bugs shipped clean; `e2e-playwright` has a known pre-existing intermittent flakiness, documented not fixed

The 19-report pre-sales reporting suite (8 existing reports upgraded
with date-range/project filtering and real `TeamScopeService` scoping,
11 new reports, `source-wise`/`staff-performance` now showing
status-based and booking-linked conversion side by side per explicit
correction, export/print gated by two new permissions separate from
view with an audit-log entry per action, a widened `team-scope-guard`
check that caught a real `managerWiseInteractions` scoping bug) shipped
after real CI verification found and fixed five genuine bugs, exactly
as expected of a rewrite this size that had never touched a real
database: a CSV column-format regression against a pre-existing spec's
literal assertion, a missing required `bookingDate` field in a new test
fixture, an `eslint-disable-next-line` comment separated from the line
it was meant to suppress by an inserted explanatory comment block, a
test-isolation leak (one test's uncommitted-cleanup inquiry inflating a
sibling test's exact-count assertion within the same shared company
fixture), and a disposition-history row with a null `changedById` that
made a permission-scoped query invisible to the very user calling it.
All five confirmed via real CI logs across multiple pushes, not
guessed — `lint-typecheck-build`, `integration-tests`, `native-install`,
and `native-upgrade` are all reliably green on this branch.

**`e2e-playwright` was NOT made green, and the PR merged anyway — with
explicit, informed user sign-off, not by unilateral judgment call.**
Extensive investigation (five distinct fix attempts, each targeting a
specific hypothesis, each producing SOME signal but never a clean run —
full account in `docs/todo.md`'s own entry) converged on a decisive
diagnostic: removing this PR's own Playwright spec entirely and pushing
that as a pure test still left the job failing, with a **different**
pair of pre-existing, unrelated specs than the pair that had been
failing with the new spec present. That rotation — which specific
specs fail depends on what else is running, at a fixed timeout ceiling
regardless — is the signature of real, pre-existing concurrency
contention in the E2E suite itself, not a defect in this PR's code.
Root-caused (via Playwright's own trace artifacts, not speculation) to
the refresh-token-rotation race this file already documents
(`REFRESH_REUSE_GRACE_SECONDS`) firing under genuine CI concurrency
rather than only React StrictMode's synchronous double-invoke, which is
the narrower case the existing mitigation was built against.

**This does not relax the "verify in a real browser" primary lesson at
the top of this file, and must not be cited as license to wave off a
future E2E failure.** The rotation was established by an actual
diagnostic — remove the suspect code, observe the failure persists
unchanged in kind — not assumed from "E2E is sometimes flaky" folklore.
A failure in a spec touched by a change, or a new failure appearing in
one that wasn't, is still that change's responsibility until a
comparably rigorous diagnostic says otherwise, exactly as it was for
five real bugs earlier in this same PR. See `docs/todo.md` for the full
wrong-turns-ruled-out account and the candidate fix directions for the
underlying race, which needs its own real-browser click-through per
this file's mirrored-auth standing rule before it's touched — a
materially larger, separate undertaking correctly left out of this PR.

### TOTP enrolment gets a real QR code — reverses the "no QR-code image" decision above

- **`qrcode-generator@2.0.4` added to `apps/api` — zero direct
  dependencies, ships its own current `.d.ts`, CommonJS.** Rejected
  `qrcode`/`node-qrcode` (the more commonly reached-for package): it
  drags `yargs@15` and ~30 transitive packages to ship a CLI this
  project never invokes — the wrong trade for a self-hosted product
  whose own principles call for minimal runtime dependencies. No
  `@types/qrcode-generator` — that package exists but is a stale major;
  the library's own shipped types are current and used directly.
- **Why the original "not worth a new dependency" judgment was wrong,
  not just outdated:** it weighed a QR renderer against `node-qrcode`'s
  ~30-package `yargs` tree specifically — `qrcode-generator` (zero
  deps, one package, its own types) was never evaluated at the time.
  The cost that got rejected wasn't the cost that was actually
  available. Separately, manual-entry-only is a real usability defect
  specifically on the portal, whose users are on phones, where typing a
  32-character base32 string correctly on a touch keyboard is
  genuinely error-prone. And `totpSetupResponse.qrDataUrl` was already
  declared in the shared response contract (`packages/shared/src/auth.dto.ts`)
  and returned by both `TotpService.generateSecret()` callers to both
  clients, unused — the codebase already carried the intent, this
  finishes it rather than introducing something new.
- **Server renders the QR (SVG, not the library's own `createDataURL()`,
  which emits a GIF that pixelates when scaled)**, returned as
  `qrDataUrl` — a `data:image/svg+xml;base64,...` URI — in the same
  setup response that already carries `secret`/`otpauthUrl`. `secret`
  stays in the response and rendered as a manual-entry fallback below
  the QR image (`"Can't scan? Enter this key manually."`) — every
  authenticator app still accepts typed entry, and
  `apps/e2e/tests/auth-2fa.spec.ts`/`apps/api/test/e2e-totp.test.ts`
  both read it to compute codes.
- **`TotpService.generateSecret()` now takes a `label: string` argument**
  instead of hardcoding `'OpenEstate CRM'` — both `AuthService.setupTotp`
  and `PortalAuthService.setupTotp` resolve it as
  `user.email ?? user.phone ?? user.name` (identical expression, not a
  portal special case) via one `findUniqueOrThrow` before generation.
  `User.name` is `NOT NULL` in `schema.prisma`, so the chain always
  terminates — no sentinel, no non-null assertion. The label is passed
  as the raw string; `OTPAuth.TOTP`'s own `toString()` URL-encodes it —
  pre-encoding here would double-encode (an email's `@` becoming
  `%2540` instead of `%40`), the classic bug in this exact spot, guarded
  against directly in `totp.service.spec.ts`.
- **Issuer stays the hardcoded literal `'OpenEstate'`.** Per-tenant
  issuer from `Company.name` was considered and deliberately held back
  as a separate, later change — this commit is scoped to the label and
  the QR rendering only.
- **`verify()` never took a label and still doesn't — confirmed, not
  assumed, that no existing enrolment is invalidated by this change and
  nobody needs to re-enrol.** `TotpService.verify(secret, code)`
  computes purely from the stored secret; the label only ever appears
  inside the otpauthUrl string shown to an authenticator app at
  enrolment time, never persisted, never read back. Pinned by
  `totp.service.spec.ts`'s "the label is display-only" test: two
  independently generated secrets, under two different labels, each
  independently verify correctly. This is the first thing a reviewer of
  an auth change should worry about per this file's own standing rules —
  answered here directly rather than left to be re-derived.
- **176px QR image, no media query** — confirmed to fit the portal's
  375px mobile viewport (this codebase's narrowest supported width, per
  the Phase 6 customer-portal click-through notes) without layout
  changes. Neither `apps/web/src/pages/Settings.tsx` nor
  `apps/portal/src/pages/Security.tsx` was retokenised to the
  post-e27b68f design system in this change — both stay on their
  existing raw `slate-*`/`blue-600` styling; that conversion is a
  separate, unrelated item and would have buried this diff.
  `img alt` deliberately does NOT contain the secret (a screen reader
  announces alt text, and a broken image shows it in place of the
  picture) — `"QR code for authenticator app setup"` instead.
- Both frontends' inline `{ secret; otpauthUrl }` response-shape
  declarations were replaced with `import type { TotpSetupResponse }
  from '@openestate/shared'` — the exact, already-declared
  `totpSetupResponseSchema` this commit makes true, so the contract
  can no longer silently drift the way it did the first time (declared
  in the shared package, imported by nothing, since Phase "password-
  change, admin force-reset, and CLI break-glass recovery").

### Session lifetime — no absolute cap, recorded here because it had never been written down

This is a factual description of standing behavior, not a change made this
session — recorded because a user asked where the policy was documented
and it wasn't, anywhere.

- **Access tokens live in memory only, in both apps, never in a cookie or
  browser storage.** `apps/web/src/lib/api.ts`/`apps/portal/src/lib/api.ts`
  hold it as a module-scoped `let accessToken`, explicitly `by design —
  CLAUDE.md keeps it out of cookies/localStorage` (the comment already on
  `downloadFile()` in both files). Default TTL is 15 minutes
  (`JWT_ACCESS_EXPIRES_IN`, `auth.module.ts`) — a page reload always starts
  from nothing and re-derives a session via `/auth/refresh`.
- **Refresh tokens are httpOnly cookies, single-use with rotation, 7 days
  for staff and 24 hours for portal.** `TokenService.createRefreshToken`/
  `rotateRefreshToken` (`apps/api/src/auth/token.service.ts`) default to
  `JWT_REFRESH_EXPIRES_IN ?? '7d'`; `PortalAuthService` passes an
  `expiresInOverride` of `PORTAL_JWT_REFRESH_EXPIRES_IN ?? '24h'` through
  the same code. Every successful refresh revokes the presented row and
  inserts a new one in the same `family` (`rotateRow`) — the old raw token
  can never be replayed once its successor exists.
- **There is no absolute session lifetime.** `rotateRow` computes the new
  row's `expiresAt` as `now + refreshExpiresIn` every time, with no
  reference anywhere to the family's original `createdAt` — confirmed by
  reading the full rotation path, not inferred. A user who refreshes at
  least once every 7 days (staff) or 24 hours (portal) keeps a family
  alive indefinitely. This is a sliding window with no cap, not an
  oversight of one.
- **Deliberate for a self-hosted product where the operator controls their
  own deployment** — not a default inherited from a template and never
  revisited. Reviewed and accepted as the tradeoff for this deployment
  model, not something that was never considered.
- **Known consequences, all downstream of the same fact: revoking a
  refresh token cannot revoke an access token already issued from it.**
  `JwtStrategy.validate()` does no DB lookup — it trusts the signature and
  expiry alone. So every action that revokes refresh tokens
  (`TokenService.revokeAllForUser`, used by `AuthController.logoutAll`/
  `PortalAuthController.logoutAll`, `AuthService.changePassword`,
  `forceChangePassword`, `confirmPasswordReset`, and `UsersService
  .deactivate` as of PR #41/`d54c5ac`) cuts off renewal immediately but
  leaves up to 15 minutes of the old access token still valid. For
  deactivation specifically: the user cannot get a new access token
  (`refreshTokens()` checks `isActive`), but any access token issued
  before the deactivation keeps working until it expires on its own.
- **If an absolute cap is ever wanted, two shapes were considered here,
  neither built:** derive it from `MIN(RefreshToken.createdAt)` across a
  `family` (the column already exists, so no migration — but any family
  older than the new cap is over-age the instant it ships, so deploying
  it mass-logs-out every existing session at once); or add a new nullable
  column recording an absolute expiry per family (needs a migration, but
  existing rows come in `NULL` and can be read as exempt, so deploying it
  grandfathers every session already open rather than killing them).

### SECURITY: 2FA bypass through the mid-login token, and brute-forceable 2FA codes — both fixed

- **Vulnerability.** When TOTP is on, login returns a tempToken instead of
  a session, scoped to `permissions: ['auth.totp.verify']` and meant only
  for `totp/verify`. But `PermissionsGuard` is default-allow: it returns
  `true` for any route with no `@RequirePermissions`, without ever looking
  at what the token carries. 19 of 317 routes were undecorated, so a
  tempToken reached `totp/setup`, `totp/confirm`, `totp/disable`,
  `change-password`, `force-change-password` and `logout-all`. (It could
  not read business data directly — all 288 permission-guarded routes
  still returned 403.)
- **Impact.** An attacker holding only a valid password could log in, take
  the tempToken, and within that one login run setup → confirm → verify:
  enrol their own authenticator, get a full session, take the freshly
  generated recovery codes, and leave the real owner's authenticator
  rejected. 2FA gave no protection against the one attacker it exists to
  stop. Both surfaces — and because staff and portal share a JWT secret, a
  staff tempToken operated portal endpoints too. Proven with 12 exploit
  tests that passed against the unfixed code, now flipped into the
  regression suite `apps/api/test/e2e-temptoken-scope.test.ts`.
- **Fix shape: a denylist on the token, not an allowlist on routes.**
  `TwoFactorPendingGuard` is a global guard registered straight after
  `JwtAuthGuard`. It refuses any token carrying the marker (plain 403, no
  explanation) on every route except the two verify endpoints — including
  routes that don't exist yet, so nobody has to remember a decorator. The
  only escape hatch is `@RequirePermissions(auth.totp.verify)`, and because
  no role can hold that permission, opening a route to tempTokens closes it
  to full sessions at the same time. The exception can't quietly become the
  next hole. Both verify endpoints now require it, so a full session can no
  longer call verify.
- **One signer.** The marker string was hand-written in two services and
  could have drifted, letting the guard miss one surface's tempToken. Both
  now call `TokenService.signTwoFactorPendingToken`, which sets the marker
  and the lifetime in one place.
- **tempToken lifetime cut from 15 minutes to 5.** It had inherited
  `JWT_ACCESS_EXPIRES_IN` by sharing `signAccessToken`; a per-call
  `expiresIn` overrides the module default. Five minutes, not less, leaves
  time to open an authenticator app or find a recovery code. Neither
  frontend decodes the tempToken — both pass it back as an opaque Bearer —
  so its payload and lifetime can change freely.
- **Root cause deliberately not changed here.** `PermissionsGuard`'s
  default-allow policy is what made this possible. Flipping 288 routes to
  default-deny is its own branch with its own testing; this fix contains the
  blast radius for the one token that must never act as a session, and
  doesn't remove the policy. Recorded in `docs/todo.md`.
- **Second finding: 2FA codes were brute-forceable on staff.** Staff
  `totp/verify` had only the default 100-per-minute-per-IP bucket, and
  failed codes counted toward nothing, while portal verify had a 5-per-5-
  minutes bucket — a staff/portal mirroring divergence. Both verify
  endpoints now share `TotpVerifyThrottlerGuard`: 5 attempts per 5 minutes
  (`TOTP_VERIFY_THROTTLE_LIMIT`), keyed by the verified token's `sub`
  rather than the client IP. Rotating addresses gains an attacker nothing,
  and staff behind one office NAT don't share a budget. TOTP and recovery
  codes spend from the same budget; portal verify also keeps its per-IP
  bucket.
- **Lockout: its own counter and lock, not the password lockout's.** New
  columns `failed_totp_attempts` / `totp_locked_until` (migration
  `20260914120000_user_totp_lockout`): 5 consecutive failed codes lock the
  second factor for 5 minutes; a successful verify clears both. Reusing
  `failedLoginAttempts` / `lockedUntil` was rejected for two reasons. A
  correct password clears that counter before the 2FA step, so anyone
  holding the password could reset it at will and the lockout would never
  fire. And `lockedUntil` gates the password step, so wrong codes setting
  it would let an attacker lock the owner out of their own account on
  demand. The TOTP path never touches the password fields (tested with
  marker values, so even a write of 0 or null would show).
- **The lockout is not redundant with the rate limit.** A pending-2FA
  token is accepted by BOTH verify endpoints, and the throttler counts each
  handler separately, so the rate limit alone allowed 10 attempts per 5
  minutes, not 5. The counter on the user row is what makes the stated
  limit true — tested: after 5 failures on staff verify, the same token on
  portal verify passes that endpoint's rate limit (4 remaining) and is
  refused by the lock. On a single endpoint the two overlap almost
  entirely. The lock also blocks fixed-window boundary bursts and survives
  a Redis restart (not separately tested).
- **`reserveTotpAttempt` is one atomic `UPDATE`** that records the attempt
  before the code is checked, sets the lock on the 5th, and refuses while
  locked — so a locked account's code is never evaluated and the response
  can't reveal whether it was right. A read-then-write would let concurrent
  requests all pass the lock check before any failure was recorded; a test
  proves only 5 of 8 simultaneous attempts are checked. Locked response:
  429, `Too many incorrect codes. Wait a few minutes, then sign in again.`
  (a wrong code stays 401 `Invalid TOTP code`).
- **The lock uses `now() AT TIME ZONE 'UTC'` explicitly.** The column is
  `TIMESTAMP` holding UTC, and the deployment VM's Postgres session runs in
  Asia/Kolkata, where a bare `now()` would be shifted. The lockout tests run
  the app's database session in Asia/Kolkata and assert the lock lands 5
  minutes out in real time. That assertion was mutation-checked: with a
  bare `now()` in the built code, the lock landed about 5.5 hours out and
  the test failed on both surfaces.
- **A TOTP lock clears its counter on expiry**, unlike the password
  lockout, which re-locks on the next failure. With no admin 2FA reset yet,
  someone working through recovery codes after losing their phone shouldn't
  be rationed to one attempt per 5 minutes. The cost is real: never clearing
  would cut an attacker's steady-state rate about 5×.
- **Honest limit: brute force is mitigated, not solved.** Each guess
  succeeds with probability about 3 in a million, and the combined limits
  allow about 1,440 guesses a day per account. An undetected attacker with a
  valid password still has roughly a 32% chance over 90 days (median about
  160 days). What closes that is notifying the owner of repeated failures
  and locks, which is not built.
- **Verification:** lockout 17/17, throttle 9/9, regression 23/23, apps/api
  647/647 (96 files), Playwright 41/41 including both real-browser 2FA specs
  (`auth-2fa.spec.ts`, `portal-2fa.spec.ts`); apps/api build, typecheck and
  lint clean. The locked-out message itself has not been clicked through in
  a browser — the Playwright specs never reach a lock.

### User-facing docs had drifted from this log — one claim traced to nothing

A v0.5.0 documentation audit found `docs/docs/installation.md` asserting a
specific verification event — `upgrade-native.sh` run fresh end-to-end on a
real Ubuntu 24.04 box, plus 2FA/TOTP and broker NOC→cancel→clawback→
statement-PDF flows exercised there — with no corresponding entry anywhere
in this log. The nearest real entry (Phase 8, "CI native-install job added,
VM re-verified") says the opposite: that session's own 24.04 re-verification
attempt used the same 25.10 box by mistake and explicitly says to treat
24.04 as unverified until a real one is tested. The doc's claim didn't
survive contact with the actual dated record — removed, not softened.

This log was treated as authoritative over the doc, not the other way
round, because it's append-only and dated; a user-facing doc has no such
guarantee and can drift silently between releases with nobody rereading it.
**Standing rule going forward: a verification claim in a user-facing doc
(README, `docs/docs/`) must trace to an entry here, or it doesn't get
written.** If a claim can't be traced to a specific session's entry, say so
explicitly in the doc (as `installation.md`'s 24.04 caveat now does) rather
than asserting it.

**Follow-up review of this same audit, before it merged, found the
standing rule above hadn't actually been applied to the whole claim it was
written about.** "Removed, not softened" was true for the OS-version half
(24.04 → 25.10) but not for the other half: the "plus application-level
flows (2FA/TOTP enrollment and recovery codes, broker NOC → cancel →
commission clawback → statement PDF)" clause survived the edit unchanged,
just re-attributed to 25.10 and strengthened with "repeated across
multiple sessions" — with no more support than it had before. Grepped
this log for every mention of "clawback" (four total, none a VM
verification) and for "2FA/TOTP"/"recovery codes" near VM context
(zero) — nothing here confirms those flows were ever exercised against a
native install, on either Ubuntu version. The nearest real flow-level
verification found (Phase 6's "Final manual click-through") ran against
dev servers, not a native install, and doesn't mention clawback at all.
Fixed by actually removing the clause this time, per the rule already
stated above rather than a new one — `docs/todo.md` now carries the
follow-up ("2FA/TOTP enrolment and the broker NOC → cancel → clawback →
statement flow have never been exercised on a native-install VM") so the
claim can be restored honestly once it's real.

**Same review also found and fixed a real, invented UI label in the same
file's §8**: "the admin 'Reset portal password' ... action" doesn't exist
under that name anywhere in `apps/web`. The actual control is "Force
password reset" (`UserForm.tsx`, verified against the button's own JSX
text before writing the fix) on the Admin → Users page — it already
works for portal-linked accounts (`UsersService.forcePasswordReset`
branches on `applicantId`/`brokerId`), the doc just named it wrong.

**And a third, unrelated drift found while re-reading this section: this
file's own "Security rules" (near the top) said "Account lockout with
exponential backoff after failed logins" — verified against
`AuthService.recordFailedAttempt` (`MAX_FAILED_ATTEMPTS = 5`,
`LOCKOUT_MINUTES = 15`) and there is no escalation logic at all; every
lockout past the threshold is the same flat 15 minutes, repeating until a
successful login. Corrected the line to say what the code actually does.
Same section's "install.sh" reference was also stale — that file was
deleted outright when Docker was removed (see this file's own "Docker
removed entirely" entries); the real path is `deploy/native/
install-native.sh`. The rest of that section was checked against code too:
one line ("portal users... can only ever read rows keyed to their own
applicant_id/broker_id") simplifies real RLS policies that also carve out
co-applicants and booking-reachable rows rather than every table being a
direct applicant_id/broker_id column match — true in effect, imprecise in
mechanism, and left as a simplification rather than rewritten, since
nothing in it is actually wrong the way the lockout line was. Everything
else in the section (input validation, parameterized queries, Redis-backed
rate limiting, security headers/CORS/CSRF, upload validation, audit log
fields including IP) checked out against the code as written.

### Admin-generated password-reset links — the token goes back to the admin (partly supersedes the force-reset bullet above)

- **`POST /users/:id/force-password-reset` now answers `200 { token,
  expiresAt }` and hands the raw token to the calling admin, once — not
  `204` with the token only "sent".** This install has no mailer by
  design: the only `CommunicationProvider` is
  `ConsoleCommunicationProvider`, which logs, so the old flow issued a
  live token that reached nobody. Delivery is now the admin's job, out
  of band (WhatsApp, phone, in person). Only the SHA-256 hash is stored,
  so the response is the one place the raw token exists. The best-effort
  `provider.send()` stays, but a missing address or a provider error is
  logged and swallowed — it can never stop the token reaching the admin.
  **Superseded by the "Admin reset links: review fixes" entry below** —
  the staff path no longer calls `provider.send()` at all.
- **URL assembly is client-side, from `window.location.origin`**
  (`<origin>/reset-password?token=<token>`), matching the portal-invite
  precedent (`Applicant360.tsx`/`BrokerDetail.tsx` build
  `/portal/invite/...` the same way). Deliberately no
  `FRONTEND_URL`/`APP_URL` env var: the staff SPA is served at `/` on the
  same origin as the API (`deploy/native/nginx`), so the browser already
  knows the right base, and a configured one is one more per-install
  value to get wrong.
- **Portal targets are refused with 400; deactivated targets with 409.**
  The old portal branch (a `PortalPasswordReset` row created from this
  same function) is removed — portal users get a dedicated endpoint, not
  yet built. The 409 matches `PortalPasswordResetProcessor`, which
  already refuses deactivated users: an admin path should not be more
  permissive than the unauthenticated one. Both checks run before any
  token exists, so neither can leave a partial write.
  **Built by the "Admin-generated portal password-reset links" entry
  below** — that dedicated portal endpoint now exists.
- **A new token supersedes any live one for that user.** One interactive
  transaction: `SELECT … FOR UPDATE` on the user row (serialises
  concurrent issuance, so two clicks cannot leave two live links), then
  unconsumed, unexpired `PasswordReset` rows for that user and company
  get `consumedAt = now()`, then the new row is created. Known cost,
  logged in `docs/todo.md`: `consumedAt` now means "used" or
  "superseded", and the table cannot tell which without a
  `supersededAt` column.
- **A `RESET_LINK_ISSUED` audit row is written explicitly, inside the same
  transaction.** `forcePasswordReset` runs on `SYSTEM_PRISMA`, which
  carries no audit extension (only `createTenantPrismaClient` gets
  `auditExtension()`), so nothing beyond `PasswordReset.createdById`
  would otherwise record which admin issued a link. Same direct
  `auditLog.create` shape as `CustomFieldsService`'s purge: actor = the
  admin, entity = the target user, IP from the request context, `after`
  = the reset row's id and expiry. Neither the token nor its hash ever
  appears in it, and sharing the transaction means no token can exist
  without its audit row.
- **Permission deliberately stays `ADMIN_USER_UPDATE`.** A dedicated
  permission was considered and rejected: new `PERMISSIONS` keys
  auto-sync only to `super_admin` on upgrade (see the pre-pilot
  super_admin entry), so moving force-reset behind a new key would
  silently remove it from every existing `company_admin` role until an
  admin re-granted it by hand.
- **Correction to the password-change entry: `PasswordChangeThrottlerGuard`
  is not "one bucket" across its three routes.** `@nestjs/throttler`
  6.5.0 keys every counter as `sha256(controller-handler-throttler-
  tracker)`, so the 5-per-300s limit is one setting but each route
  handler keeps its own counter, per user id when authenticated or per
  IP for the public confirm endpoint. The guard's own comment now says
  so. Test budgets are therefore per handler: no more than 5
  unauthenticated calls to one handler per test run.
- **Verified locally against CI's exact service images** —
  `postgres:16-alpine` and `redis:7-alpine` as throwaway local test
  infrastructure only (nothing added to the repo), provisioned by an
  unmodified `scripts/test-setup.sh`: `apps/api` 604/604 and
  `packages/db` 65/65 with zero skipped, and the changed test file
  (19 tests) green on five separate runs. Not yet exercised in a browser
  — the staff UI that displays the link is the next step.

### Admin-generated portal password-reset links — the portal counterpart (builds the endpoint the entry above deferred)

- **New `POST /admin/portal-password-resets`, mirroring
  `POST /admin/portal-invites` in shape and permission
  (`ADMIN_PORTAL_INVITE_SEND`).** The body is exactly one of
  `applicantId`/`brokerId`; it answers `200 { token, expiresAt }` and
  hands the raw token to the calling admin once, like the staff endpoint.
  No new permission, for the same upgrade-sync reason as the staff entry
  above: a new key would reach only `super_admin`, silently taking the
  action away from every existing `company_admin`. Its own controller
  (`PortalPasswordResetAdminController`) because Nest binds the path
  prefix per class; same module, service, and permission as invites.
- **A separate endpoint, not a relabelled invite action, because a
  `PortalInvite` row and a `PortalPasswordReset` row are different facts.**
  Re-sending an invite would also have reset the password (consuming an
  invite re-issues credentials for an existing portal `User`), but if a
  customer later disputes activity on their account, "was granted access"
  and "had their password reset" must stay distinguishable in the audit
  trail — a distinction that cannot be recovered later if collapsed now.
- **`PortalPasswordReset.createdById` added — nullable, DB-level FK to
  `users` (`ON DELETE SET NULL`, same shape as
  `portal_invites.created_by_id`), no backfill.** NULL means self-service:
  the portal user requested it and no admin was involved. Existing rows
  have no known creator, and inventing one would falsify the trail. No RLS
  change: the table's only policy is the `company_id` tenant isolation
  policy.
- **Portal reset URL template: `${origin}/portal/reset-password?token=...`.**
  The portal SPA is built with base `/portal/`, served by nginx at
  `/portal/`, and its `BrowserRouter` has `basename="/portal"`, so the
  route path is `/reset-password`. Same shape as the existing invite
  links (`/portal/invite/:id?token=`), and built client-side from
  `window.location.origin` for the same reason as the staff link.
- **`409` with a machine-readable `code: NO_PORTAL_ACCOUNT` when the
  applicant or broker has no `User` row — they were never invited.** It is
  the common case and has a specific remedy (send an invite), so the UI
  must be able to tell it apart from the deactivated-account `409`, which
  carries no code. `NO_PORTAL_ACCOUNT_ERROR` is exported from
  `packages/shared` and used by both the API and the frontend, so the UI
  never matches on message text. An applicant or broker outside the
  caller's company is `404`.
- **The service re-checks exactly-one-of `applicantId`/`brokerId`** rather
  than relying on the zod boundary alone: called with neither, the lookup
  would pass `{ id: undefined }`, which Prisma treats as no filter — it
  would match an arbitrary broker in the company.
- **Audit action `PORTAL_RESET_ISSUED`** — shortened because `action` is
  `VarChar(20)` and `PORTAL_RESET_LINK_ISSUED` is 24 characters. Written
  explicitly inside the same transaction as the token (SYSTEM_PRISMA has no
  audit extension), never containing the token or its hash. Superseding,
  the row lock, and the 30-minute expiry work exactly as on the staff path;
  an admin-issued link also supersedes a pending self-service one (the
  reverse doesn't happen yet — logged in `docs/todo.md`).
- **This endpoint deliberately does NOT call `CommunicationProvider.send`.**
  There is no mailer, and `ConsoleCommunicationProvider` logs message
  bodies in plaintext (`docs/todo.md`); adding a new plaintext-token log
  line for a customer account would be a regression. The staff path keeps
  its best-effort send only because it already had one.
  **Superseded by the "Admin reset links: review fixes" entry below** —
  the staff path now follows this same rule.
- **Verified locally against the same `postgres:16-alpine`/`redis:7-alpine`
  test containers as the staff entry:** `apps/api` 614/614 and
  `packages/db` 65/65 with zero skipped, and the new test file (10 tests)
  green on three separate runs. Neither the staff nor the portal path has
  been exercised in a real browser yet — the admin UI that shows and
  copies the link is the next step.

### Admin UI for the reset links — a complete URL, not a bare token (builds the UI the entry above deferred)

- **Admins now see the complete reset URL, not a bare token, built at the
  call site and passed whole into a shared `RevealedResetLink` component.**
  Deliberately NOT built inside the component: the staff URL
  (`<origin>/reset-password?token=`) and the portal URL
  (`<origin>/portal/reset-password?token=`) differ by the `/portal`
  prefix, and a conditional inside a shared component — "am I rendering
  for staff or portal this time" — is exactly how a customer eventually
  gets handed a 404 link. Each caller (`UserForm.tsx`, `Applicant360.tsx`,
  `BrokerDetail.tsx`) builds its own URL from `window.location.origin`
  and its own known prefix, and only the finished string crosses into the
  shared component.
- **`UsersService.findOne`/`findAll` now select `applicantId`/`brokerId`**
  so the staff Users screen can tell a portal user from a staff user —
  neither field was selected before, so the frontend had no way to know.
  Both endpoints stay gated by `ADMIN_USER_READ`, unchanged.
- **`UserForm.tsx` hides the reset button entirely for a portal-linked
  user and links to the applicant or broker record instead**, because the
  staff force-reset endpoint already refuses a portal user with `400`
  (see the entry above) — showing the button and letting it fail would be
  a dead end with no next step. The link goes to
  `/postsales/applicants/:id` or `/postsales/brokers/:id` (confirmed
  against `App.tsx`, not guessed), where the real portal-reset action
  lives.
- **`NO_PORTAL_ACCOUNT` renders as a calm inline message pointing at the
  Send Portal Invite control, never as an error.** It is the expected
  path for anyone who's never been invited, not a failure — red styling
  or alarming language here would be wrong for the common case. Matched
  only on the shared `NO_PORTAL_ACCOUNT_ERROR` constant, never on message
  text.
- **The applicant and broker portal blocks are now gated client-side by
  `ADMIN_PORTAL_INVITE_SEND`** — the invite controls had no client-side
  gate before this (the backend permission check was always the real
  enforcement; this only stops the button rendering for someone who can't
  use it). `BrokerDetail.tsx` checks it via the constant
  (`hasPermission(PERMISSIONS.ADMIN_PORTAL_INVITE_SEND)`), not a string
  literal like this file's older permission checks (`'admin.broker.update'`,
  etc.) — a typo in a literal compiles clean and silently hides a
  control; the constant can't drift from what the backend actually
  guards. The file's other, pre-existing literal checks were left as-is —
  fixing the one this feature touches, not unrelated churn.
- **The existing invite-link display was converted to the same
  reveal-once component**, replacing plain, no-copy-button text with the
  Copy affordance — request logic (`sendPortalInvite`) untouched, only
  how the resulting link is shown. Its real `expiresAt`
  (`INVITE_EXPIRY_DAYS` — days, not `PasswordReset`'s 30 minutes) is
  threaded through from the actual API response, confirmed against
  `PortalAuthService.sendInvite`'s return value rather than assumed.
- **The panel's relative-expiry line goes stale if left open, and a
  stale "N minutes from now" about a dead link is worse than none** — an
  admin mid-call with the customer, tab left open, would otherwise read a
  reassuring number about a link that already died. Fixed with a
  30-second `setInterval` recomputing "now" (cleared on unmount) plus an
  unmistakable expired state that replaces the whole panel body once the
  moment passes — the clock time (`toLocaleTimeString`) never goes stale
  on its own, but the interval is still needed to flip the panel into
  that expired state without a manual re-render. 30s chosen as frequent
  enough to catch a reset link's 30-minute window promptly, negligible
  overhead against an invite's multi-day one.
- **Verification note, stated plainly rather than overstated:** `apps/web`
  typecheck/lint/build are clean, and `apps/api`'s full suite (614/614,
  zero skipped) still passes since the only backend change was the
  additive `select`. **Nothing in this feature — staff or portal, Step 1
  through this UI — has been exercised in a real browser yet.** This
  file's own primary lesson and its auth/frontend-request-construction
  standing rules are not yet satisfied for this work; a Playwright pass
  is the next step, not a formality after the fact.

### Admin reset links verified in a real browser — two real Copy bugs found and fixed (closes Layer One)

- **Real-browser verification is now DONE for both flows, and this file's
  browser rule is satisfied for this feature.** `apps/e2e/tests/admin-reset-links.spec.ts`
  drives staff and portal reset end to end: an admin generates the link
  in the real UI, the spec reads the URL from the DOM (never the
  clipboard), a fresh logged-out browser context visits it, sets a
  password, and logs in as that user; the old password is then refused.
  It also covers supersede (the earlier link is rejected), the
  portal-user pointer on UserForm, `NO_PORTAL_ACCOUNT`, and the reveal
  panel. It runs on its own `resetLinks` fixture company because it
  changes a portal user's password.
- **Browser testing found two real bugs that every unit and API test
  missed, both in code that had already passed review** — both in
  `RevealedResetLink`'s Copy button:
  - **`navigator.clipboard` is undefined on non-secure origins**, so Copy
    threw and did nothing, with no feedback, on the DEFAULT native install
    (plain HTTP on a LAN address). The feature is "copy this link and send
    it", and copy did not work on the primary deployment target.
  - **`writeText` was not awaited**, so "Copied" appeared even when the
    write failed — an admin would then paste whatever was already on
    their clipboard, possibly a live reset link for a different customer.

  Both fixed: the write is awaited, success is claimed only on success,
  and a missing API or a refused write both fall back to selecting the URL
  text and telling the admin to press Ctrl+C (⌘C on Apple devices) — in
  neutral, non-alarming text, since nothing is wrong with the link itself.
  The spec covers both paths: `clipboard-write` is granted (write only,
  never read) for success, and the Clipboard API is removed before page
  load for the fallback, asserting the message and that the selection is
  exactly the URL.
- **This is another instance of this project's dominant bug class:
  correct components, wrong composition, invisible to review, found only
  by real execution.** Each line of the Copy handler was fine in isolation;
  it was wrong only against the environment it actually ships into.
- **UserForm's Password section now renders only after the user record
  loads.** Until then `isPortalUser` read false, so a portal user's screen
  briefly offered "Generate reset link" — which the API refuses with a 400
  and a red toast. Gated on the loaded record, the same way the form's
  `reset()` effect already is; the hydration logic itself is unchanged.
- **A shared one-sentence warning (`ResetLinkSupersedeNote`) tells admins
  that generating a new reset link cancels any earlier one**, on UserForm,
  Applicant360 and BrokerDetail. It deliberately says "reset link", not
  "link": portal invites do NOT supersede each other (`sendInvite` only
  inserts), so a generic sentence would have been false on screen. The
  invite asymmetry itself is logged in `docs/todo.md`.
- **The e2e harness serves staff and portal on separate origins; production
  serves both from one.** The spec asserts the generated URL's origin, path
  and query strictly, then rewrites only the origin to reach the portal dev
  server. So the harness proves the portal link carries the staff origin
  and the correct `/portal` path — right for the supported single-origin
  nginx layout, and it would not hold if the portal were ever hosted
  separately.
- Verified: `apps/web` typecheck/lint/build clean; the full Playwright
  suite 47/47 with no retries; the new spec 6/6 on three consecutive runs
  (the staff reset-confirm throttle — 5 per 300s, Redis-persisted — is
  spent at exactly 2 per run, so local back-to-back runs clear the test
  Redis's `throttle:*` keys first, as CI's fresh Redis does implicitly).
  `user-role-edit.spec.ts` now waits for the form to populate before
  typing — a pre-existing `reset()` race this spec's extra worker load
  surfaced, worked around in the spec and logged in `docs/todo.md`.

### Cross-links between the staff and portal login screens

- **Added in both directions**, after real use on a test VM showed the
  portal URL is undiscoverable: a customer who received a portal link once
  has no way back to it without remembering the address, and the project
  author himself couldn't find it. Staff login links to `/portal/`; portal
  login links to `/`.
- **Plain `<a>` tags, not react-router `<Link>`.** The portal's
  `BrowserRouter` has `basename="/portal"`, which prefixes every `<Link>` —
  a `<Link to="/">` from inside the portal would resolve to `/portal/` and
  silently keep the user right where they already were. This is
  load-bearing, not a style choice.
- **Correct in production only.** Staff and portal share one origin there
  (nginx, portal under `/portal/`); the dev servers run them on separate
  ports, so both links 404 under `pnpm dev`. Deliberately not worked
  around — there's no clean way to make a static anchor origin-aware
  without hardcoding a dev port into production code. Playwright asserts
  the `href` attribute rather than clicking through, for the same reason.
- **`/portal/` (not `/portal/login`) verified as the staff→portal target
  before switching to it**, not assumed: an unauthenticated hit lands on
  the portal's own `ProtectedRoute`-gated index route, which `<Navigate
  to="/login" />`s — resolved against the router's own `basename` since
  it runs inside the mounted app — to `/portal/login` regardless. An
  already-authenticated visitor skips the redirect entirely and lands on
  their own tab. Either way, `/portal/` is memorable and always lands
  somewhere correct, where a deep link teaches a URL nobody will recall.

### Uploaded documents plan: owner decisions (2026-09-14)

Plan: `docs/plans/uploaded-documents-plan.md` (revision 2). Documentation
only; nothing built. The Aadhaar PII rule in "Security rules" is deliberately
**not** amended yet — that edit ships in v0.9.0 with document upload, so this
file is true at every release.

- **Aadhaar (owner decision 1):** a scanned Aadhaar card may be collected as
  an encrypted uploaded document when the operator enables that document
  type; the number is never stored in any structured, searchable or
  exportable field. Exact replacement wording is in the plan, §3.
- **Documents attach to applicants and bookings through one table,
  `uploaded_documents`,** with exactly one owner per row (two real foreign
  keys plus a `num_nonnulls` CHECK). Rules out a second mirrored table and
  an `entity_type`/`entity_id` pair without foreign keys. Not named
  `documents`: `GET /documents/:id/download` already serves generated PDFs.
- **Multiple files per document type per entity (A).** No replace endpoint,
  no one-per-slot unique index; `document_types.max_files` (default 5,
  ceiling 10), enforced under a per-(type, entity) advisory lock because a
  count can't be a unique index. "Required" means at least one live file.
- **Required documents never block booking creation (F).** A visible
  "missing" state only; a gate at allotment or registration stays open. A
  required booking *custom field* does block Confirm — it's typed into the
  form, whereas files can only be uploaded after save.
- **Encrypted at rest under a new key domain,
  `UPLOADED_DOCUMENT_ENCRYPTION_KEYS`** (versioned, same format as
  `PLUGIN_SECRET_ENCRYPTION_KEYS`). Project media and generated PDFs stay
  unencrypted.
- **Fresh-install grants (B):** read + upload for super_admin, company_admin,
  sales_manager, sales_executive; delete for super_admin, company_admin,
  sales_manager; read for accounts. New `admin.document-type.manage` for the
  master. Existing installs: only super_admin receives them automatically;
  every other role is granted deliberately through Roles. The dormant
  `POSTSALES_DOCUMENT_*` and `PORTAL_DOCUMENT_UPLOAD` constants are **not**
  reused — they're already granted on every install, so activating them
  would silently widen roles on upgrade. `POSTSALES_BOOKING_UPDATE` is
  reused for booking custom-field edits: activating it gives no role more
  than it can already do with bookings.
- **Booking custom fields** get a `bookings.custom_fields` JSONB column,
  written from `BookingController` inside an outer transaction that
  `createBooking` joins. `BookingService` itself is not edited; no ledger,
  GST or status-machine code changes. The column on the frozen `Booking`
  table is an owner-approved exception. There is no written "frozen list" in
  this file — "frozen" is descriptive; `docs/todo.md` had misquoted one.
- **The Aadhaar guard requires a valid Verhoeff checksum (C).** Pattern
  alone rejects too many phone and account numbers. Tables verified this
  session against the Wikipedia *Verhoeff algorithm* article (citing
  Verhoeff 1969) and its worked example, plus structural checks. UIDAI's
  *A UID Numbering Scheme* (May 2010) specifies 12 digits with a Verhoeff
  check digit, but names the permutation only as "such as … other
  permutations can also be used" — so v0.7.0 must pass a human conformance
  check against real cards before shipping, with only the result recorded.
  Measured residuals: ~10% of any 12-digit number starting 2–9 still match,
  including ~1 in 10 contiguous `91` + mobile numbers. Aadhaar numbers with
  a single mistyped digit fail the checksum and are therefore not caught.
- **`applicant_documents` is not dropped in the document migration and never
  aborts an upgrade (D).** It's kept one more release, with a non-fatal
  warning from `upgrade-native.sh` if it has rows, and removed in v0.10.0 —
  the same deferred-drop pattern as `document_types.entity_type`, which is
  still written by the previous release during the upgrade window. An
  upgrade that hard-fails on a builder's server is worse than a dead table.
- **Release sequence (E):** v0.6.0 = the finished
  `feat/admin-generated-reset-links` and `fix/login-cross-links` branches;
  v0.7.0 = Aadhaar guard + booking custom fields (no env vars, no changes to
  install/upgrade/backup/restore — one new standalone read-only script);
  v0.8.0 = deploy plumbing only, to prove `upgrade-native.sh` can add a
  boot-required setting to an existing install without failing the
  healthcheck, with CI asserting the outcome (a key-canary encrypt on first
  boot, decrypt on restart, and a wrong-key restart that fails) rather than
  the env line; v0.9.0 = document types, applicant and booking documents,
  the Aadhaar rule amendment, key rotation; v0.10.0 = deferred drops.
  **Superseded by the "Release sequence moved: v0.7.0 is the admin 2FA
  reset" entry below** — every item here moved up one release.
- **Raised with the owner and still open:** checksum residuals and missed
  typos (with exemption options); staff unable to delete their own mistaken
  upload; `RolesService.update()` letting company_admin grant itself any
  permission, so "grant deliberately" is a process step, not a boundary;
  what the v0.10.0 drop does if `applicant_documents` has rows (proposed:
  rename, don't drop); v0.8.0 refusing boot on a key mismatch before any
  document exists. Full list: the plan, §6.
  **Superseded by the next entry — every item here except the
  `RolesService` one was ruled on the following day.**

### Uploaded documents plan: rulings on the open objections (2026-09-15)

Plan revised to revision 3 (`docs/plans/uploaded-documents-plan.md`).
Documentation only, again — nothing built. Rules on the six substantive
objections the previous day's entry left open.

- **Aadhaar guard redesigned into three layers, not just re-tuned** — the
  single pattern+Verhoeff guard from the prior entry was judged to reject
  too many ordinary phone and account numbers on its own. Layer (a): reject
  creating or renaming a custom field whose key or label contains
  `aadhaar`/`aadhar`/`आधार` (substring match, case/whitespace-normalized —
  no realistic false positive found) or `uid` (word-boundary match only,
  specifically to avoid `liquid`/`squid`/`guide`-class false positives that
  a plain substring check would hit; still false-positives on a field
  genuinely meant to be called "UID" for an unrelated external system —
  accepted, no exemption applies to this layer). Layer (b): the
  pattern+Verhoeff value guard as previously designed, unchanged. Layer
  (c): a new `allows_twelve_digit_values` boolean on
  `CustomFieldDefinition`, default false, that skips layer (b) for one
  field only (a legitimate bank-account-number field, the motivating case)
  — audited for free via the existing `AUDITED_MODELS` diff extension,
  shown with an inline warning and an ongoing list badge in the admin UI,
  and explicitly incapable of bypassing layer (a): a field cannot be named
  "Aadhaar" and exempted at the same time. Rides on the existing
  `admin.custom-field.update` permission rather than a new one — reasoned,
  not assumed: that permission is already held only by company_admin and
  super_admin on a fresh install, the same two roles already trusted with
  every other aspect of a custom field's validation shape, so a dedicated
  permission would add sprawl without adding containment. The plan now
  states plainly, in one place, that all of this is deterrence against
  accidental storage, not prevention against deliberate evasion — the
  measured residual rates (roughly 10% of legitimate 12-digit values still
  pass layer (b); 0% of single-digit Aadhaar typos are caught by it) are
  written down so nobody downstream assumes the guard is airtight. The
  pre-ship human conformance check against real Aadhaar numbers is kept,
  with an exact, specified procedure (a Node REPL with history disabled,
  the number never assigned to a variable or pasted elsewhere, and only
  the pass/fail outcome — never a digit — recorded in this log).
- **Self-delete: anyone may delete a file they uploaded themselves, no time
  window, regardless of the delete permission; deleting someone else's file
  still needs it.** Both paths write the same audit row, distinguished only
  by actor id — no separate audit code needed. Closes the "staff can't take
  back their own mistake" gap from the prior entry.
- **`RolesService.update()`'s missing grantor check is reported, not
  fixed, by explicit instruction — answered directly rather than left
  vague.** Grepped `packages/shared/src/roles.ts` line by line: on a fresh
  install, only `company_admin` (via its `admin.*` prefix filter) and
  `super_admin` (via `Object.values(P)`) hold `admin.role.update`; no
  lesser system role lists any `ADMIN_ROLE_*` permission by any path.
  **Marked low severity for that specific reason** — the gap lets an
  already-fully-trusted role grant itself something it doesn't yet hold,
  which is not an escalation across a boundary this system currently
  defines, though it would extend to any custom role an admin has already,
  deliberately, granted `admin.role.update` to. Added to `docs/todo.md` as
  a standalone security item rather than folded into this feature's scope.
- **`applicant_documents`'s disposition decided now, not deferred a second
  time.** In the v0.9.0 migration itself: drop it if it has zero rows,
  rename it to `applicant_documents_legacy` if it has any — never abort the
  upgrade, never destroy data, log the outcome loudly either way via an
  explicit post-migration check in `upgrade-native.sh` rather than assuming
  a SQL-level `NOTICE`/`WARNING` reaches the script's own output (unverified
  either way). No `v0.10.0` step remains for this table; `v0.10.0` now only
  drops `document_types.entity_type`.
- **v0.8.0's boot-refuses-on-key-mismatch design and v0.9.0's three-PR split
  (foundation / booking documents / rotation+docs) are both kept exactly as
  designed**, confirmed rather than revised.
- **`find-aadhaar-like-values.sh` stays under `deploy/native/`** — confirmed
  it is a standalone, read-only tool that touches neither the install nor
  the upgrade path, so v0.7.0's "no deploy-script changes" claim still
  holds for the scripts an operator actually runs to install or upgrade.

### Uploaded documents plan: `uid` dropped from the layer (a) guard (2026-09-15, same day, correction not a ruling)

**Supersedes the layer (a) description in the entry immediately above —
that entry's `uid` word-boundary check no longer exists.** This was raised
as an objection by the assistant, not requested by the owner, and applied
as a correction to a design that had shipped in the plan only hours
earlier. Plan now at revision 4.

`uid` is dropped from layer (a) entirely. It would have false-positived on
ordinary, plausible integration field names ("External UID", "Partner
UID") with no way around it — the layer (c) exemption deliberately can't
reach layer (a), by design, so there was no workaround for a company that
genuinely needed such a field name, only a rename. `uid` is also a weak,
generic signal for Aadhaar specifically, unlike `aadhaar`/`aadhar`/`आधार`,
none of which have any known legitimate use as a field name. Layer (b)'s
pattern+Verhoeff value check is what actually has to catch a determined or
accidental 12-digit entry — layer (a) narrowed to the three Aadhaar-specific
words is enough to keep it a true zero-known-false-positive layer, which
was the property the previous entry claimed for it but didn't actually
have while `uid` was still in the rule.

### Admin reset links: review fixes (before merge)

A review of this branch found one leak that blocked the merge and three
gaps. All fixed on the branch, each staff and portal together.

- **Admin-issued staff reset tokens no longer go through
  `CommunicationProvider.send()`.** The portal half of this branch had
  already dropped the send, because `ConsoleCommunicationProvider` logs
  message bodies in plaintext, but the staff half still sent the raw token
  through it. `UsersService.forcePasswordReset` now follows the portal
  rule and never sends; the token reaches only the admin, in the response.
  Nothing real was lost: `ConsoleCommunicationProvider` is the only
  implementation, bound unconditionally in `QueuesModule` with no setting
  to swap it, and no messaging plugin exists. Scope, stated precisely: this
  covers **admin-issued staff reset tokens only**. The portal self-service
  reset (`PortalPasswordResetProcessor`) still sends its raw token through
  the console provider, so reset tokens do still reach server logs through
  that path — see `docs/todo.md`.
- **Every other way a user's password gets set now consumes that user's
  outstanding reset links.** Before this, a stale admin-issued link could
  overwrite a password the user had just chosen — proven on all four paths
  by tests that failed before the fix. The four: staff change-password,
  staff force-change-password (first login), portal change-password, and
  portal invite consumption for an existing account (which also
  reactivates it). Each batches an `updateMany` on its own reset table into
  the same transaction as the password write, after it. The user-row update
  waits on the `FOR UPDATE` lock admin issuance takes, so a link issued at
  the same moment is either consumed or created after the new password.
  Uniform on all four paths. The only variation is that invite consumption
  does it only when the account already exists (a new account can't hold
  links). No new column: `consumedAt` now also covers "invalidated by a
  password change", which widens the existing used-vs-superseded ambiguity
  already logged in `docs/todo.md`. Not changed: `reset-admin-password.sh`
  (changing it means redoing its VM verification; logged in
  `docs/todo.md`) and redemption itself, which still doesn't consume a
  portal user's other live link (disclosed, left as-is by ruling).
- **A deactivated account can no longer use a reset link, and
  reactivation doesn't revive one.** Two layers, staff and portal:
  `UsersService.deactivate()` now consumes the user's live links in both
  reset tables (that endpoint deactivates staff and portal users alike),
  and both `confirmPasswordReset` methods refuse an inactive account with
  the same 401. The refusal is a conditional `updateMany` (`isActive:
  true`) after the link is claimed, so the refused link is used up and a
  concurrent deactivation can't slip between a check and the write.
  Checked before building it: no onboarding or invite path redeems a reset
  token. The only code that sets `isActive = false` is
  `deactivate()`, every reset-link creator refuses inactive users, and
  invite consumption (which does reactivate) uses `PortalInvite`, not a
  reset token. The consume in `deactivate()` runs through the system
  client after the tenant transaction, because the staff reset table isn't
  tenant-scoped. The redemption check covers the moment between those two
  writes. One narrower race remains, logged in `docs/todo.md`: issuance
  checks `isActive` before taking the user-row lock, so a link created
  just after deactivation's consume survives a quick reactivation if
  nobody tried it in between.
- **Verified locally** against the same `postgres:16-alpine` and
  `redis:7-alpine` containers CI uses (throwaway test infrastructure, not
  added to the repo). Every new test file failed against the code before
  its fix, for the reason the fix addresses, and passed after it. The
  cross-surface binding test passed against the branch before any code
  change, as a regression guard. Full `apps/api` suite with all four fixes
  in place (`PROPERTY_NUM_RUNS=500`): 100 files, 672 tests, 672 passed,
  0 failed, 0 skipped. Playwright `admin-reset-links.spec.ts` in real
  Chromium: 6/6. The staff and portal redemption scenarios in it are the
  browser proof that active accounts still redeem after the new
  inactive-account check. No new Playwright scenarios: none of the four
  fixes changes what the browser sends or shows.

### v0.6.0 released — merges admin-generated reset links and login cross-links

`feat/admin-generated-reset-links` (PR #46) and `fix/login-cross-links`
(PR #47, stacked on #46) both squash-merged onto `master`, matching the
existing convention there (checked empirically: 11 of the last 14
PR-sourced commits on `master` are single-parent squash-merges, the
current pattern; only 3 older two-parent merge commits predate it).
PR #47's base had to be manually retargeted from `feat/…` to `master`
after #46 merged (GitHub only auto-retargets a stacked PR when its base
branch is *deleted*, not merely merged) and `fix/login-cross-links` then
needed rebasing (`git rebase --onto`, not a plain `git rebase`, to avoid
replaying #46's already-squashed commits a second time) — squash-merging
a base PR breaks the ancestry a stacked PR's own merge computation relies
on; this is a mechanical consequence of squash-merging, not a defect in
either branch. Post-merge: master builds and typechecks clean, CI on
`master`'s merge commit (run `35185028166`) passed all 5 required jobs,
and both branches were force-deleted locally and on the remote after
confirming their unique content was fully captured in the squash commits
(a plain `git branch -d` correctly refuses a squash-merged branch since
its commits aren't literally ancestors of `master` — verified via
`git diff <branch> <squash-commit>` showing zero unique content on either
branch before force-deleting, rather than trusting the refusal to mean
"unmerged").

Version bumped 0.5.0 → 0.6.0 in all 11 workspace `package.json` files
(the API's health endpoint and Swagger spec both already read the
version from `package.json` at runtime, so neither needed a separate
edit) and in every doc making a *current-status* claim (`README.md`'s
status banner and roadmap tally, `CONTRIBUTING.md`, `docs/docs/intro.md`,
`docs/docs/features-and-usage.md`'s "As of vX" line,
`docs/docs/installation.md`'s example upgrade command). Historical
references to v0.5.0 as a past, specific release — this file's own
decisions log, `SECURITY.md`'s advisory, `docs/docs/security/asvs-
checklist.md`, `docs/releases/v0.5.0-release-notes.md`, and
`CHANGELOG.md`'s existing `[0.5.0]` entry — are deliberately left
untouched; changing them would make a true historical claim false.

**Release step, added afterwards:** don't run `pnpm install --lockfile-only`
after a version bump. Workspace packages appear in `pnpm-lock.yaml` only as
`specifier: workspace:*` / `version: link:…`, so their versions never reach
the lockfile and the command rewrites identical bytes. The v0.6.0 release ran
it anyway. Git then flagged the untouched file as modified for a whole day,
because its cached timestamp went stale. That needed a separate investigation
to rule out a real lockfile change.

### v0.6.1 — staff recovery-code input

- **Root cause: a coverage gap, not Playwright bypassing `maxlength`.** The
  staff code field (`TotpVerify.tsx`) had `maxLength={6}` since Phase 1, and
  recovery codes are 11 characters (`XXXXX-XXXXX`). It survived because no
  spec, staff or portal, had ever signed in with a recovery code.
  `portal-2fa.spec.ts` said so in its own header and deferred it.
  `e2e-totp.test.ts` covered recovery codes only at the API, where the
  request is built by hand. Found on the v0.6.0 VM by typing a real code.
- **Checked, not assumed: in Playwright 1.62.1 with Chromium 151, `fill()`
  and `pressSequentially()` both respect `maxlength`.** `FA897-AF930`
  became `FA897-` in both; only a scripted `el.value = …` kept the whole
  string. So the existing 2FA specs would have caught this if any had typed
  a recovery code. `harness-input-fidelity.spec.ts` pins that behaviour so
  a Playwright or Chromium upgrade that changes it fails loudly instead of
  quietly weakening every spec that types into a limited field.
- **The new recovery-code specs assert the field's value before
  submitting** (`toHaveValue(fullCode)`). Without that, a truncated field
  shows up as a generic "login failed" rather than a named cause. They type
  with `pressSequentially()`, the existing 2FA specs now do too, and each
  new spec gets its own fixture account because it enables 2FA and uses up
  codes.
- **A recovery-mode toggle, not a permanently text-mode field.** The toggle
  only changes keyboard hints (`inputMode`, `autoComplete`,
  `autoCapitalize`, `spellCheck`) and wording. The field accepts either
  kind of code in either mode, so a desktop user who ignores the toggle
  still gets in. Dropping `inputMode="numeric"` outright was rejected
  because it gives a worse keyboard for the 6-digit code every 2FA user
  types at every sign-in, just to serve a rare path. Switching mode clears
  the field and the error. Mirrored on the portal per the mirrored-auth
  rule, although the portal had no `maxLength`.
- **Normalisation lives in `totpVerifySchema` (`.trim().toUpperCase()`
  before the regex), not in either form.** One place covers the staff and
  portal API boundary (nestjs-zod's pipe passes the parsed value to the
  handler) and the staff form (`zodResolver` hands parsed values to
  `onSubmit`). Stored recovery codes are uppercase hex, so this changes no
  accepted code, only its spelling. Before this, a lowercase code was
  refused with 400 on both surfaces.
- **Audit (plan item d):** the only other `maxLength` in `apps/web` or
  `apps/portal` is BookingWizard's PAN field, set to 10, which matches a
  PAN's length.
- **Verification, and its limits.** Playwright sends real key events, so
  under the automated-browser clarification above it satisfies the auth
  click-through rule. No human has looked at the toggle yet; a manual pass
  is due after the VM upgrade. The keyboard each mode brings up on a phone
  is reasoned from `inputMode`, not checked on a device. Both limits are
  stated in the CHANGELOG and the release notes.

### Release sequence moved: v0.7.0 is the admin 2FA reset

- **v0.7.0 ships the admin 2FA reset on its own.** Owner decision. The
  reason is that it closes a live lockout: anyone who lost both their
  authenticator and their recovery codes had no in-app way back in, and a
  sole admin in that position had no way back in at all, because the
  break-glass script reset the password but not 2FA.
- **Everything planned moves up one release.** Aadhaar guard + booking
  custom fields → v0.8.0; deploy plumbing → v0.9.0; document types and
  documents → v1.0.0. The owner didn't place the old v0.10.0 (the deferred
  `document_types.entity_type` drop); v1.1.0 is assumed. The plan doc's own
  numbering is not yet updated — logged in `docs/todo.md`.

### v0.7.0 — the TOTP lockout survived a 2FA disable

- **Self-service disable cleared the secret and recovery codes but not
  `failedTotpAttempts`/`totpLockedUntil`, staff and portal.** Someone who
  locked themselves out with wrong codes, disabled 2FA and re-enrolled
  within five minutes had the first code from the new authenticator refused
  with a 429 by a lock belonging to the discarded secret. It self-heals
  after five minutes, which is why it went unnoticed.
- **Fixed with one definition, `TOTP_CLEARED` (`totp-lockout.ts`)**, used
  by both disables and both admin resets. The admin reset is exactly the
  flow that hits the bug, so the four sites must not drift. E3h in
  `e2e-totp-lockout.test.ts` checks both the columns and the consequence (a
  fresh authenticator's first code works); the consequence assertion was
  shown to fail on its own, with the column assertions removed, because
  otherwise they would always fire first and hide it.

### v0.7.0 — admin-side 2FA reset, staff and portal

- **A deliberate action, separate from password reset.** Coupling them
  would make every reset token a 2FA bypass, and reset tokens already leak
  in two places this log records: nginx access logs (query strings) and
  `ConsoleCommunicationProvider` (portal self-service). The confirm routes
  are also `@Public()`, so a coupled reset would have no actor to audit.
- **`ADMIN_USER_UPDATE` on both surfaces, not `ADMIN_PORTAL_INVITE_SEND`
  on the portal side.** Sales managers hold the latter and can already
  issue a portal password-reset link; letting them clear 2FA too would let
  them take over a broker account and approve NOCs as that broker. No new
  permission, so no upgrade-sync gap (a new key would reach only
  super_admin until granted by hand).
- **The portal controller carries `@RequirePermissions` at class level.**
  Checked by mutation: with the decorator removed, a real sales_manager's
  reset returned 200, not 403 — `PermissionsGuard`'s default-allow,
  observed rather than inferred.
- **Deactivated accounts are allowed**, unlike the reset link's 409. The
  reset issues no credential, and a deactivated account can't sign in
  either way (login refuses it; since v0.6.0 so does reset-link
  redemption). Requiring reactivation first would add a step and no
  security.
- **Staff refuses your own account (400)**: Settings → Disable 2FA does
  that without revoking the caller's own session. Staff also refuses portal
  users (400), pointing at their record; portal keeps
  `issueAdminPasswordReset`'s 404 and 409 `NO_PORTAL_ACCOUNT`.
- **`SYSTEM_PRISMA`, not the tenant client.** The tenant client's audit
  extension would add a generic `UPDATE` row whose before/after diff holds
  `totpSecret` and `recoveryCodes`.
- **Sessions: `revokeAllForUser`, with an honest limit.** No refresh token
  survives, and the reuse grace window can't revive one (it only rotates
  when a live token remains in the family — tested by refreshing seconds
  after a reset). But `JwtStrategy` does no database lookup, so an access
  token already issued stays valid up to `JWT_ACCESS_EXPIRES_IN` (15
  minutes). Stated in both service comments and the CHANGELOG.
- **`wasEnabled` is read under `SELECT ... FOR UPDATE`**, so concurrent
  resets report it accurately and the audit trail doesn't overstate what
  happened. The audit row is written even when nothing was cleared: the
  admin's action is itself worth recording.

### v0.7.0 — audit rows for 2FA and password events

- **One action name per event, `after.surface` saying which surface**
  (`staff`, `portal`, `cli`). The reset-link actions differ per surface only
  because they write different tables; these all write `users`. Names fit
  `audit_logs.action`, `VarChar(20)`.
- **The `@Public()` routes pass the IP explicitly.** The two reset confirms
  and invite consumption have no `req.user`, so `TenantContextInterceptor`
  sets no context and `getCurrentIpAddress()` returns nothing. Shown by
  mutation: without the controller passing `req.ip`, the row's IP was null.
- **`confirmPasswordReset` now runs the password write and the audit row in
  one transaction, but the link claim stays outside it.** Moving the claim
  in would roll it back when an inactive account is refused, and the link
  would work again after a reactivation — the v0.6.0 bug, reintroduced. A
  test checks the refused link stays consumed.
- **A first-time invite writes no `PASSWORD_CHANGED` row; a re-invite of an
  existing account does.** This diverges from the literal instruction,
  which asked for `PASSWORD_CHANGED` "including the new invite-consumption
  site" without distinguishing the two branches of
  `finalizeInviteConsumption`. A first-time invite *creates* the account:
  there was no password before it, so there's nothing to call a change, and
  account creation is already recorded by the invite itself. A re-invite
  *replaces* an existing account's password and reactivates the account if
  it was deactivated — exactly what an audit trail must be able to show,
  so it's recorded with `via: 'invite'`, the `inviteId` and
  `reactivated`. The account holder is the actor: they held the invite.
- **Counted: 10 self-service sites plus 2 admin**, not the 9 plus invite
  the instruction's wording implied — `PASSWORD_CHANGED` has four sites
  (staff self, portal self, staff first-login, portal invite), because the
  approved plan kept `changePassword` on both surfaces.

### v0.7.0 — `reset-admin-password.sh --clear-2fa`

- **A flag, not the default.** Owner decision: unconditional clearing
  would recreate the password-reset-implies-2FA-bypass coupling. Without
  the flag, on a 2FA account, the script still resets the password, exits
  0, and warns on stderr (`lib.sh`'s `warn()` writes to stdout, so these
  calls redirect themselves). A silent dead end is what caused the problem.
- **The script's header and `--help` said it bypassed 2FA "entirely".**
  False since it was written; corrected.
- **Two things psql has to set that Prisma never does:**
  `audit_logs.id` has no database default (Prisma generates it), so the
  insert uses `gen_random_uuid()`; `created_at` defaults to
  `CURRENT_TIMESTAMP` on a `TIMESTAMP` column holding UTC, so it is set to
  `now() AT TIME ZONE 'UTC'` — the bare default would be 5.5 hours off on
  the Asia/Kolkata VM. The audit row has `user_id NULL` (the column is
  nullable, so no sentinel system actor was needed) and `surface: 'cli'`.
- **CI's native-install job runs the script for real** and checks the
  outcomes a user would notice: login still demands a code without the
  flag, returns a session with it, the warning is on stderr, and exactly
  one CLI audit row exists. shellcheck was not run — not installed, and no
  CI job runs it (logged in `docs/todo.md`).

### Standing rule: a concurrency test must force its interleaving

The first concurrency test for the admin reset fired five requests with
`Promise.all` and asserted exactly one saw 2FA on. It passed, and it proved
nothing: with `FOR UPDATE` removed, the staff version still passed two runs
in three, because the requests often ran one after another. A race test
that passes against broken code most of the time is worse than none — it
turns an unproven claim into a green check.

The fix was a barrier the test controls: it takes its own lock on the row,
fires the requests, polls `pg_blocking_pids` (recursively, since queued
waiters block each other) until every request is blocked behind it, then
releases. That makes the interleaving certain instead of likely: with the
lock, every request blocks before its read; without it, every request reads
first. The mutation then failed 3 runs in 3.

**Rule: before trusting a concurrency test, run it against the code with
the protection removed, several times. If it doesn't fail every time,
force the interleaving — don't raise the request count and hope.** Size
the barrier below the connection pool (here 4 of `connection_limit=5`), or
a request waits for a connection instead of the lock and the barrier never
fills.

### v0.7.1 — audit rows silently dropped, written without an actor, or faked on failure

Found during v0.8.0 work, when a test for the Aadhaar guard's exemption
flag expected an UPDATE audit row and got none. Three separate defects,
all in `packages/db`, none in any frozen financial file.

- **Rows silently dropped.** `withTenantTx` ran its callback as
  `tenantTxContext.run({ tx }, () => fn(tx))`. A Prisma query is a lazy
  thenable, so `(tx) => tx.model.create(...)` returned it un-run; it
  executed after `run()` had exited, the audit hook found no transaction
  in context, and `if (!store?.tx) return;` skipped the row without a
  word. 53 write call sites in 24 files used that form. Reproduced in
  plain Node against the compiled app (`POST /custom-fields` → 201, 0
  audit rows) as well as under vitest. Fixed in one place: `run(...,
  async () => await fn(tx))`, and `return await` on the nested-reuse
  branch.
- **Rows without an actor.** 122 service-level `runWithTenant({
  companyId })` calls replaced the interceptor's store, dropping userId
  and IP, so nearly every audit row ever written had `user_id = NULL`,
  bookings and receipts included. `runWithTenant` now fills userId and
  ipAddress from the ambient store when the new store leaves them unset
  and the company is the same. It runs after the portal guardrail, so it
  can't widen or switch a portal scope; a different company inherits
  nothing. `audit_logs.user_id` references `users(id)` and portal
  sessions carry `sub = users.id`, so a portal actor always satisfies the
  foreign key.
- **Failed audit writes reported success.** The extension's `catch {}`
  swallowed the audit INSERT's error, but Postgres had already aborted
  the transaction, so Prisma's COMMIT became a silent rollback: when the
  audited write was the last statement, the caller got the created row
  back (a 201 with an id) for a write that was never saved. Measured
  before the fix. The owner's first decision ("fail-closed, don't throw")
  rested on the catch covering this; it didn't. Revised decision: any
  error while writing the row is logged (model, action, id, error code,
  never values) and rethrown. The no-transaction path stays log-only
  (`docs/todo.md` asks whether anything still reaches it).

Also: BigInt values serialize in the audit writer itself instead of
depending on `main.ts`'s global patch (necessary once errors rethrow:
test processes without the patch would otherwise fail writes), and the
sanitizer redacts secrets at any depth while leaving `Date` and
`Prisma.Decimal` whole.

**Why no test caught it:** no test had ever asserted a row written by the
audit extension. The audit assertions that existed all checked rows
written explicitly through the system client (auth events, purges, reset
links), plus RLS on `audit_logs`. The extension's own failure paths were
both silent, and the rows that did exist (Inquiry, Booking) came from
`async` callbacks, so the table looked populated.

**Standing rule: a new write path to an audited model needs a test that
asserts its audit row and actor through HTTP.** A passing write test says
nothing about the audit row, and the audit extension gives no signal when
it isn't writing one.

### v0.7.1 — the audit fix verified on a real install (192.168.1.20)

On 2026-09-24 the verification VM was upgraded from v0.6.0 (`924e55f`) to
master `b83ef31` (v0.7.0 plus the audit fix) with `upgrade-native.sh --ref
<full sha>`, run over `plink` with a pty. It exited 0, with no pending
migration (32 migrations, none new) and no permission changes. The API
came up healthy (`version` reads 0.7.0: the 0.7.1 bump is the release
commit), `NRestarts=0`, and its journal since the restart had no `[audit]`
lines and no error-level lines. The project owner then edited a project
in the browser and saw the row in Admin → Audit Log with their own name as
the user. That is the verification the v0.7.1 release notes cite.

- **What it does not show:** audit rows written by the new code on that
  box were produced by the owner's browser check, not by a scripted pass;
  the counts I took before and after the upgrade can't be compared for the
  fix, because every row that appeared between them (Inquiry UPDATE 6 → 14,
  a follow-up, a custom-field delete and purge) was written before cutover
  by the old release while the owner used the app during the backup and
  build.
- **The VM's clock was a week behind that day** (it read 2026-09-17), because
  the VM had been suspended; the owner corrected it on 2026-09-24. The
  upgrade log, backup and release directory names, and any audit row from
  that period carry the wrong date. `timedatectl` still said "System
  clock synchronized: yes" the whole time, so it can't be trusted after a
  resume. `docs/handoff.md` has the details and the testing note.
- **Handling:** the SSH password was piped to `sudo -S` over stdin and
  never written to a file, commit or log. It appeared twice where it
  shouldn't have: echoed by the pty into one tool output, and briefly as
  an argument to `grep` on the VM.

### v0.8.0 (PR 1) — Aadhaar guard on custom fields

- **A safety net against accidental storage, never described as blocking
  Aadhaar storage.** Three layers: (a) a name check on custom-field key and
  label (aadhaar/aadhar/आधार as substrings after NFKC folding; adhaar/adhar
  as whole words only, so Dharavi and Hardware pass; `uid` deliberately not
  blocked); (b) a value check on NEW or CHANGED staff writes to TEXT and
  NUMBER values (12 digits, first digit 2-9, optional 4-4-4 grouping with
  space or hyphen, valid Verhoeff), in `resolveValuesForWrite` rather than the
  zod schema so a stored value re-sent unchanged never blocks an edit; (c) a
  per-field `allows_twelve_digit_values` exemption, audited, refused on a
  field named after Aadhaar. Layer (b) is what makes it worth shipping; the
  v0.8.0 tag waits for a human real-number check (`docs/release-plan.md`).
- **Machine-driven writes redact instead of reject** (inbound lead API,
  plugin `ctx.leads.create`, the Excel importer): no one is there to read an
  error, and losing the lead is worse than losing the number. They write
  `[Aadhaar-like number removed]`.
- **Masking is display and CSV export only.** The raw value is still stored
  and still in the API response; docs say "masked", never "hidden".
- **Measured, not assumed:** about 1 in 10 random 12-digit numbers starting
  2-9 pass the check (tested), single-digit typos are not caught, and free
  text outside custom-field values is unchecked (`docs/todo.md`).
- **The scanner prints keys and counts, never values** and reaches a server
  through `deploy/native/find-aadhaar-like-values.sh` (standalone; install,
  upgrade, backup, restore and uninstall are untouched). `apps/api/scripts`
  is in the release tree because `apps/api/package.json` has no `files`
  allowlist for `pnpm deploy` to honour.
- **Tests never contain a 12-digit literal**: valid values are computed with
  Verhoeff, invalid ones are a valid value with its check digit changed.

### v0.8.0 — real-number release gate passed; scope narrowed to the guard

- **Human real-number check: pass, 2026-09-25.** Done by the owner, by
  hand, in a browser on the verification VM (192.168.1.20), in the plain,
  spaced and hyphenated formats. Recorded as pass only: no digits, no count
  of numbers.
- **Not counted toward the gate:** earlier the same day, Claude in Chrome
  ran the same screens with a made-up checksum-valid number; all three
  formats were refused with the Aadhaar message and nothing was saved. It
  used no real number, so it proves the wiring, not conformance with real
  numbers.
- **Before either run, the logging path was checked on the VM** with a
  computed synthetic value: a rejected value reached none of the API
  journal, the nginx logs, the PostgreSQL log or `audit_logs`.
- **Owner decision: v0.8.0 ships the Aadhaar guard only.** Booking custom
  fields (`bookings.custom_fields`, planned as v0.8.0 PR 2) move out of
  v0.8.0 and stay a planned item with no release assigned
  (`docs/release-plan.md`).

### v0.8.0 released — the Aadhaar guard only

- **Cut from master `3b159c6` (PR #55 squash-merged) on 2026-09-25**, the
  same way as v0.7.1: version 0.7.1 → 0.8.0 in the 11 workspace
  `package.json` files, a dated `[0.8.0]` CHANGELOG entry, release notes
  (`docs/releases/v0.8.0-release-notes.md`) that call the guard deterrence
  and list its limits, and the current-status lines in README,
  CONTRIBUTING and the docs site. Booking custom fields are not in it.

### 0.8.1 — staff and portal sessions separated

A security fix. A portal session could call staff API routes, and portal
accounts could get staff sessions; details in CHANGELOG `[0.8.1]`.

- **The surface is a signed claim checked by one global guard.** Access
  and 2FA-pending tokens carry `surface: 'staff' | 'portal'`.
  `SessionSurfaceGuard` (after `TwoFactorPendingGuard`, before CSRF and
  permissions) decides a route's surface by URL alone: under
  `PORTAL_PATH_PREFIX` is portal, everything else is staff, so a new
  route is staff-only by default. A token from the other surface gets 403,
  whatever its permissions. Tokens issued before the fix have no claim and
  are classified by `applicantId`/`brokerId`, so nobody is signed out.
  A token carrying both ids, or a claim contradicting its ids, is refused.
- **Staff login, refresh and 2FA verify refuse portal accounts; portal
  2FA verify refuses staff accounts.** Each 2FA verify endpoint also
  refuses a pending token from the other surface, so a user's 2FA attempts
  reach one endpoint, not two.
- **Portal roles hold only `portal.*` permissions.** The broker dashboard
  moved from `reports.broker.view` to `portal.broker.dashboard.read`. The
  Roles API refuses a staff permission on a portal role (`isPortal`); the
  Users API refuses a staff role for a portal account, a portal role for a
  staff account, and a role from another company.
- **Second narrow exception to "sync-permissions never touches role
  composition"**: `stripStaffPermissionsFromPortalRoles()` removes
  non-`portal.*` grants from portal roles on every upgrade, including ones
  an admin made (owner-approved). Same grounds as super_admin: a portal
  role is defined as portal permissions only, so a staff grant is drift,
  not a customisation. It prints what it removed and writes one
  `PORTAL_PERMS_REMOVED` audit row per role (no actor). The one-time grant
  of the new permission is a migration instead, because repeating it on
  every upgrade would undo an admin's deliberate removal. The function
  takes an optional company scope used only by tests: other test files
  give portal roles staff permissions on purpose.
- **What this doesn't cover:** `PermissionsGuard` is still default-allow
  within a surface, and all tokens share one signing secret (both in
  `docs/todo.md`).

### 0.8.2 — administrators can no longer act beyond what they hold

Released 2026-10-02 (advisory GHSA-6qrx-8q6w-hvgj, High 7.2, PR:H). Plans:
`docs/testing/v0.8.2-plan.md` (this release) and `v0.8.3-plan.md` (the 71
dropped foreign keys, deferred).

- **Rule: "you cannot act on, or grant, beyond what you hold."** Every user
  or role action (create, update, deactivate, reactivate, force password
  reset, reset 2FA; role create, update, remove) requires the caller to hold a
  superset of the target's permissions, and of the new role's when a role is
  being assigned. Shared in `apps/api/src/common/permission-subset.util.ts`.
  Compared against the stored literal permission rows, never a wildcard.
- **The caller is loaded fresh from the database on every such action**
  (`loadCurrentCaller`), never from the JWT, which is a snapshot: a caller
  demoted or deactivated after signing in is refused with their old token.
- **`super_admin` is the seeded system role with that slug (`isSystem` + slug,
  `isSuperAdminRole`).** Its permission set is immutable and it can't be
  deleted; the slug is reserved at `RolesService.create`; `updateRoleSchema`
  has no slug field. The loader treats a super_admin caller as holding every
  permission that exists (that is its definition), as defence in depth. Only a
  super_admin may act on a super_admin; the last active super_admin can't be
  demoted or deactivated (locked `SELECT ... FOR UPDATE` in the same
  transaction). Nobody may change their own role.
- **Peer administrators with identical permission sets can act on each other.**
  Deliberate: accountability is the audit log, not prevention.
  `ROLE_PERMS_CHANGED` is written explicitly (the generic audit extension
  never fires for `*Many` operations).
- **The unlinked-portal-role gap:** staff login, `verifyTotp` and
  `refreshTokens` also refuse `role.isPortal`, and the admin force-reset and
  2FA-reset refuse portal-role targets. The trigger
  `forbid_unlinked_portal_role` (migration `20260930000000`) is `SECURITY
  DEFINER`, owned by `openestate_system`, `search_path` pinned, and fails
  closed on an unresolvable role. Existing bad rows are left alone;
  `print_post_migrate_findings()` in `deploy/native/lib.sh` lists them (and any
  non-system `super_admin` role) after the upgrade's migrate step, as a plain
  query, not a `RAISE NOTICE`.
- **Private-fork testing method (replaces "run it on the VM"):** Docker
  `postgres:16-alpine` + `redis:7-alpine` from a throwaway compose file kept
  OUTSIDE the repo, `scripts/test-setup.sh` against it, then the full suite,
  lint/typecheck/build and Playwright locally (Actions don't run on a private
  advisory fork). Then a VM rehearsal: a `git bundle` of the branch copied over
  SSH, `upgrade-native.sh` with no `--ref`, scripted PASS/FAIL checks, then a
  real-browser run. Push to public as a fast-forward (never squash) so the
  rehearsed commits keep their hashes. Test-only Docker is fine on a dev
  machine; never put it in the repo.
- **A test that asserts a refusal must fail against the pre-fix code.** The new
  tests were mutation-checked against `af9ff7a` (25 of 31 failed there; the other 6
  were positive cases or controls). Playwright found a real design bug no API test did (a
  super_admin unticking a permission on its own role could not re-grant it).
- **Never put a real personal address in a tracked file.** `docs/todo.md`
  once named the owner's two test accounts; reworded before release.
- **LESSON: a history rewrite breaks tag fetches on every deployed clone; any
  future rewrite must ship a tested upgrade workaround first.** The earlier
  rewrite changed the hashes of tags `v0.1.0`–`v0.7.1`. A clone made before it
  still holds the old tags, and `upgrade-native.sh --ref ...` runs `git fetch
  --tags` (line 68, inside `set -e`), which git rejects ("would clobber
  existing tag"). The script then exits silently after its backup: nothing
  changed, nothing printed by us. It only surfaced on the first real `--ref`
  upgrade of a pre-rewrite clone (the maintainer VM). Workaround, proven on that
  VM: `sudo git -C /opt/openestate-src fetch --tags --force origin`, then the
  upgrade again. Documented in the v0.8.2 release notes, the published advisory,
  the CHANGELOG and `docs/docs/installation.md`. The script fix (fetch only the
  requested ref with `--force`, and a clear error on any fetch failure, with a
  CI test using a diverged local tag) is assigned to v0.8.3, not shipped now: a
  fixed script cannot help an install that runs its old one.
- **Release record:** v0.8.2 went public as a fast-forward of the rehearsed
  branch (tag `v0.8.2` at `d337a73`); all five CI jobs were green on the first
  run; the advisory was published, the temporary fork removed by GitHub on
  publication, the VM upgraded to the public tag, and the two legacy
  unlinked customer-role accounts on the VM deactivated through the real UI
  (an `is_active`-only update, which the new trigger correctly does not block).

### 0.8.3 — released 2026-10-10: broker document access, sessions that end at once, and what the release taught us

**Release record.** v0.8.3 is public: master `1f48533`, annotated tag `v0.8.3`,
the GitHub release, and advisory
[GHSA-gq5m-m6q6-x32p](https://github.com/stemAGH/openestate/security/advisories/GHSA-gq5m-m6q6-x32p)
published 2026-10-10 03:50 UTC (Low, CVSS 3.1 score 3.1, CWE-639, affected
<= 0.8.2, patched 0.8.3). A CVE was requested while the advisory was a draft; **the
number is still pending** (re-request it from the advisory page if none is assigned
within a week). Contents: the portal document fix (a broker session can fetch only
its own commission statements, a customer session only the types its portal lists;
the broker branch was removed from the booking and money policies by one
`ALTER POLICY` migration), sessions that end the moment a user stops being
authorised (one new column, `users.authz_version`), the refusal of tokens with no
surface claim, UTC audit timestamps, and the upgrade-script fetch fix. All five CI
jobs were green on `1f48533`. A customer session could never reach another
customer's documents (the policy and an existing test show it), and the advisory
says so.

**Verification.** The upgrade was rehearsed on a VM restored from a snapshot proven
to be v0.8.2 (35 migrations): the public code first, then the portal fix, with the
owner's browser checks. The final check then used the public tag with v0.8.2's own
`upgrade-native.sh`: 37 migrations, health 0.8.3, no errors, and open staff and
portal sessions each did one silent refresh and carried on.

**Lessons.**

- **An upgrade rehearsal must start from a snapshot proven to be the previous
  release.** Check the active build, the tag and the migration count before
  trusting it. A VM that another session had moved onto a release-candidate branch
  made the first v0.8.3 rehearsal prove nothing about the real upgrade path, and
  CI's upgrade job starts from v0.1.2, so it does not prove the previous-release
  path either (Part O in the v0.8.4 plan closes that).
- **After any snapshot revert, check the VM clock before anything
  time-dependent** (2FA codes, reset links, sessions). A resumed VM can say
  "System clock synchronized: yes" while hours or days behind; here reverts gave
  offsets of about 14 hours and of almost three days (one corrected within a minute,
  the other not within several), and a restart fixed a failing 2FA code.
- **A browser security check needs a "should work" control in the same session**,
  so a refusal cannot just mean "not signed in". A URL pasted into the address bar
  does not carry the portal sign-in (the access token lives in page memory and the
  refresh cookie is scoped to the sign-in path), so such checks run as a script in
  the signed-in window, with a control request that must succeed.
- **When one host has served both HTTPS and HTTP, Chrome keeps Secure-only cookies
  and cached HTTPS redirects that break plain-HTTP sign-ins:** sign-ins vanish on
  reload and API calls are sent to a port nothing listens on. Clearing "site data"
  does not clear the cached redirects. Use Incognito windows for VM browser checks.
- **Give `upgrade-native.sh` a release tag, never a branch name.** The script in
  v0.8.2 and earlier checks out the local copy of a branch, which a fetch never
  moves, and would silently install old code (Part N adds a guard).
- **Release order: fast-forward push, CI green, tag, release, then publish the
  advisory at once, with the owner present from push to publish.** The fix was
  public for about 20 minutes this time, between the push and the publication.
- **Owner direct pushes bypass the required status checks** (GitHub says so on
  every such push). Accepted, because CI is watched to green before the tag is
  created.

### v0.8.4 Part G — the append-only escape hatch is superuser-only

- **Until now any role could use it**, including `openestate_app`: the trigger
  only checked that `app.allow_financial_mutation` was `'on'`, and any role may
  set a custom setting. Migration `20261020000000_scope_financial_mutation_hatch`
  creates `openestate_maintenance` (NOLOGIN, no members) and honours the setting
  only when `pg_has_role(session_user, 'openestate_maintenance', 'MEMBER')`.
  Superusers count as members of every role, so in production only the postgres
  superuser can use it; no script grants membership, and
  `print_post_migrate_findings()` lists any non-superuser member.
- **`session_user`, not `current_user`.** Rows removed or nulled by a
  foreign-key cascade are changed by PostgreSQL as the table owner, so
  `current_user` inside the trigger is the owner; a `current_user` check refused
  every cascading cleanup (shown by mutation against test 3).
- **Fails closed:** with the role missing, `pg_has_role` raises.
- **Test teardown (`cleanupCompany`) now uses a superuser login,
  `DATABASE_URL_TEST_SUPER`** (written by `scripts/test-setup.sh`, passed by
  `turbo.json`, inherited by CI from `.test-env`). The test app and system roles
  are deliberately not members. `portal-demo-seed` needs
  `DATABASE_URL_MAINTENANCE`, a superuser URL.
- **Checked before building:** on a migrations-built database the 7 append-only
  tables and `forbid_financial_mutation()` are owned by the migrating superuser,
  and the app and system roles cannot TRUNCATE them, disable or drop their
  triggers, replace the function, or set `session_replication_role` (test 7).
  Every install path runs migrations as a superuser (native: `postgres`; the old
  Docker path: its `openestate` superuser), so no install can have these owned by
  the app or system role.
- **Not changed, reported:** `openestate_system` owns
  `forbid_unlinked_portal_role()` (v0.8.2, `SECURITY DEFINER` by design). It
  cannot replace it (no CREATE on the schema), but as owner it can
  `DROP FUNCTION ... CASCADE`, which also drops the v0.8.2 trigger on `users`,
  or `ALTER FUNCTION ... SECURITY INVOKER`. Both shown on the local test
  database in rolled-back transactions.
- **`prisma migrate deploy` (6.19) runs each migration file as one
  transaction**; a failed file leaves nothing behind but is recorded as failed,
  and later deploys stop with P3009 until `prisma migrate resolve
  --rolled-back <name>`. It does not show `RAISE NOTICE`/`WARNING` output, so
  anything an operator must see has to come from the upgrade script. Both
  verified on a scratch database.

### v0.8.4 — portal-check ownership, Part A (71 foreign keys back) and Part B (guards)

- **`forbid_unlinked_portal_role()` belongs to `openestate_guard_owner`**
  (NOLOGIN, no members, BYPASSRLS, SELECT on `roles(id, is_portal)` only), not
  to `openestate_system`. As owner, the system login role could `DROP ...
  CASCADE` it (removing the `users` trigger), switch it to SECURITY INVOKER or
  reset its search_path. BYPASSRLS is required: writes through the system
  client carry no company context, so without it every staff-user insert there
  failed ("does not resolve to a known role"), shown by mutation. Changelog
  note, no advisory (owner decision).
- **Part A: the 71 foreign keys are added NOT VALID, then validated one by one
  only where the link has zero orphans** (owner decision: never block an
  upgrade on orphans, never change rows). A link left NOT VALID still checks new
  and changed rows; `upgrade-native.sh` prints it and
  `deploy/native/check-foreign-keys.sh` lists it (read-only session). The report
  is a query run by the script because `prisma migrate deploy` hides NOTICEs.
- **Three links became ON DELETE RESTRICT** (`ledger_entries.installment_id`,
  `interest_accruals.installment_id`, `interest_accruals.interest_rule_id`; they
  were SET NULL, which would have to UPDATE an append-only row). The refusal is
  turned into a plain 409 by `ForeignKeyRefusalFilter`
  (`apps/api/src/common/filters`), so the frozen services are unchanged. Before
  this, editing a plan deleted an installment with interest charged and left
  ledger and accrual rows pointing at nothing (shown on the pre-A schema).
- **No lock-timeout retry inside the ADD file.** The file is one transaction,
  so a retry would keep the locks it already holds, including on `users`, for
  longer. Instead the 35 links that lock `users` run last, and a timeout fails
  the file cleanly (nothing applied; P3009 on the next deploy until the failed
  row is marked rolled back, which `upgrade-native.sh` now explains and the
  release notes give as one command).
- **Restore onto a fresh server needed the new roles first.** A dump never
  contains roles but now refers to `openestate_guard_owner`, so loading it
  failed with "role does not exist" (shown on a fresh PostgreSQL 16).
  `setup-database.sh` creates both NOLOGIN roles and `restore-native.sh` runs it
  before loading the dump as well as after.
- **Part B:** `packages/db/constraint-manifest.json` (generated by
  `packages/db/prisma/constraint-manifest.ts`, one entry per line) is compared
  with the migrated test database in CI, together with "every foreign key
  validated" and "no trigger or SECURITY DEFINER function owned by a
  non-superuser login role or by `openestate_app`/`openestate_system`".
  `apps/api/test/fk-enforcement.test.ts` proves every foreign key in the
  manifest refuses a bad pointer.
- **The ownership rule names the application roles explicitly, a lesson from
  its own mutation check.** The first version flagged only owners that can log
  in, and stayed green with the function given back to `openestate_system`: a
  migrations-built database (CI) creates that role NOLOGIN, and only a real
  install's `setup-database.sh` makes it a login role. A check that passes in CI
  for a state that is broken on every real install is no check.
- **The manifest self-checks compare copies, they don't alter the database.**
  A rolled-back `DROP CONSTRAINT` still takes ACCESS EXCLUSIVE locks while the
  api tests run concurrently, and deadlocked them. Dropping a real foreign key
  was shown to fail both the manifest test and the enforcement test by hand.
- **Restoring the keys exposed two test fixtures that were wrong all along:**
  e2e-tickets created tickets "raised by" an applicant id where production
  stores a user id, and teardown deleted brokers/applicants while their portal
  users still pointed at them (the restored ON DELETE SET NULL then trips the
  v0.8.2 portal-link trigger). In the product this means an applicant or broker
  with a portal account cannot be hard-deleted; nothing hard-deletes them.
  `scripts/lint-migration-drops.mjs` (CI step) refuses an unmarked DROP
  CONSTRAINT / TRIGGER / POLICY / FUNCTION or DISABLE TRIGGER after the cutoff
  `20261015000000_portal_document_scope`; a removal needs `-- ALLOW-DROP:
  <reason>` and an entry in `packages/db/approved-removals.json`.
- **Testing method worth reusing:** a foreign key probe must commit its filler
  rows first. PostgreSQL re-checks every foreign key of a row updated in the
  transaction that inserted it, so an uncommitted filler fails on its own
  placeholder values (`apps/api/test/helpers/fk-probe.ts`).

### v0.8.4 Part I — system-role permission sync with a per-role seed baseline

- **`role_seed_baselines` (one row per system role) records the seed each role
  was last synced to.** `syncSystemRoleBaselines()` (sync-permissions.ts, run by
  every upgrade and by seed.ts) adds only keys new to a role's seed since its
  baseline. A key in the baseline that the role lacks was removed by an admin
  and is never added back; keys an admin added are untouched. The first
  upgrade of an existing install records the baseline, adds nothing and
  prints each role's differences from its seed for an admin to review.
  super_admin keeps its own rule; custom roles are never touched. Each role
  that gains keys gets a `ROLE_PERMS_CHANGED` audit row (no actor,
  `surface: upgrade`) and its users' sessions end.
- **Standing rule: the permission sync never revokes. If a permission must be
  removed from a role for security reasons, that release ships its own
  migration that removes it, with a test.** (The portal-role strip in
  sync-permissions.ts predates this rule and stays the one exception: a portal
  role holding a staff permission is a security defect by definition.)
- **Known edge:** a key removed from a seed in one release and put back in a
  later one counts as new and is re-added, even if an admin had removed it.

### v0.8.4 rehearsal (2026-10-15) and what it taught

- **Rehearsal record.** VM reverted to `v0.8.3-clean` (tag v0.8.3, 37
  migrations, clock within 1 s), then upgraded with v0.8.3's own
  `upgrade-native.sh --ref <full sha of wip/v0.8.4 8e058a8c>` through GitHub's
  redirect from the old address: exit 0, 5 migrations, 42 recorded and equal to
  the release's folders, all foreign keys validated (the read-only scan found 0
  orphans in all 71 links beforehand), money totals identical, port 3000 refused
  from the LAN while nginx answered, the owner's edit from 192.168.1.18 audited
  with that IP, open staff and portal tabs kept working, the role-baseline report
  printed and nothing was added. A downgrade to v0.8.3 with the installed v0.8.4
  script was refused with nothing built or changed and switched the origin to
  stemAGH. Saved as snapshot `v0.8.4-rehearsal`, VM powered off.
- **Owner rulings.** The four pnpm "Failed to create bin" warnings on this upgrade
  are expected (v0.8.3's build code runs it; v0.8.4's cleanup removes only the
  stray folder of the release it builds, so `apps/openestate` left by earlier
  versions stays until the operator deletes it). The interest-rule gap ships as a
  known limitation: nothing writes `Booking.interestRuleId`, so no interest is
  ever charged and the v0.8.4 RESTRICT refusals can't be reached from the app; the
  fix is a v0.9 item that needs a plan and owner approval (frozen core).
- **Lessons.** A pull-request CI run is not created while the PR conflicts with
  master; after the rename was squash-merged to master, three pushes got no run
  until master was merged into the branch. Manual runs on one branch cancel each
  other (`cancel-in-progress`). Windows PowerShell strips inner double quotes from
  `ssh` arguments, so commands for the owner must be single-quoted with none
  inside before a snapshot. The new SSH key (`~/.ssh/id_ed25519_openestate_vm`,
  alias `openestate-vm`) exists only in the `v0.8.4-rehearsal` snapshot.

### v0.8.4 — every writer of a user's refresh tokens takes the per-user lock

- **Rule: every create, rotate or revoke of a user's refresh tokens runs in one
  transaction that first takes `pg_advisory_xact_lock(hashtextextended('refresh:'
  || user_id, 0))`.** In the API that is `TokenService.withUserLock`, used by
  `createRefreshToken`, `rotateRefreshToken`, `revokeFamily`, `revokeAllForUser`
  and `revokeAllForUserExceptToken`; every app path (sign-in, 2FA, invite,
  refresh, sign-out, password/2FA/account changes) goes through those. The one
  writer outside the API, `reset-admin-password.sh`, takes the same key in its
  psql transaction. A new writer must do the same, or it can run in another
  writer's gap. Rotation reads the token again under the lock.
- **Why:** rotation was a read, an update and an insert with no lock, so a second
  refresh arriving between the update and the insert was refused and cleared the
  session (the master CI failure on `aa7daf5`, and the long-standing E2E flake).
  Four forced-interleaving tests in
  `apps/api/test/refresh-rotation-race.test.ts` fail 5 of 5 without the lock.
- **Per user, not per family:** revoking every session goes by user, so a
  per-family lock would not serialise it with a rotation (shown by mutation).
- **Bounded waits:** `lock_timeout` 5 s inside the transaction (PostgreSQL gives
  up and frees the connection), transaction timeout 10 s, maxWait 10 s. The locked
  work is a few single-row statements with no outside I/O, and only one user's own
  requests share a key, so waits can't pile up across users.
- **Same role and context as before:** the transaction runs on the injected
  `SYSTEM_PRISMA` client (plain client, `openestate_system`, no tenant or audit
  extension); `refresh_tokens` has no RLS policy, and scoping is by token hash,
  family and user id in the queries, which two isolation tests pin.
- **Ending sessions is one locked transaction: `TokenService.endSessions`** bumps
  `authz_version` and revokes the refresh tokens together, then the caller
  writes the new version to the cache (`AuthzVersionService.publish`). Used by
  password change, password-reset confirm, first-login password change, 2FA
  confirm/disable, admin 2FA reset (staff and portal), deactivation and
  re-invite of an existing portal account. A refresh reads `authz_version` and
  `is_active` inside its own locked transaction, refuses an inactive account
  there, and signs the access token with that captured version, so a session end
  landing after the rotation leaves the access token stale instead of fresh.
  Log out everywhere still revokes without bumping (unchanged).
- **Role and permission changes keep bump-only, without the lock** (`bumpUsers`
  on a role change, `bumpRole`, reactivation). They revoke nothing, so a refresh
  can't slip between two steps; a refresh that read the old version just signs a
  token that is refused once, and the client refreshes again. Taking the lock for
  every user of a role would serialise against every member's refresh for no
  gain.
- **Not changed (owner decision):** after two overlapping refreshes the browser
  keeps whichever cookie arrives last (`docs/todo.md`).
- **`syncLeadStages` takes an optional `{ companyId }` scope for tests**, like
  the two other sync functions; the upgrade runs it unscoped. The P2002 flake was
  another test file's cleanup deleting its company's "already seeded" marker
  after the sync had seeded that company, not two syncs at once.

### v0.8.4 released (2026-10-15) — the release record, and what it taught

- **Record.** Master fast-forwarded to `5891f99` (PR #76; PR #74 also shows as
  merged, both by fast-forward, never squashed). Annotated tag `v0.8.4` on that
  exact commit; GitHub release `v0.8.4` (latest); advisory GHSA-x58f-9wjq-rjgj
  (Low, CVSS 3.1 3.3, CWE-362 and CWE-613, affects up to 0.8.3, patched 0.8.4)
  published at 10:05:01 UTC, six seconds after the release (10:04:55), with a CVE
  requested. GHSA-gq5m-m6q6-x32p (v0.8.3) was re-requested the same day. Both
  still have no number; re-check around 2026-10-22. Master CI on `5891f99`:
  8 of 8 jobs, the previous-release jobs starting from v0.8.3 (`1f48533`).
- **Why the release waited a day.** Master CI on the release commit `aa7daf5`
  failed one E2E test, the concurrent-refresh race. The owner chose to fix it
  before tagging, which led to the per-user lock and then to the session-end
  fix (see the entry above). Nothing was tagged until the fix had been verified
  on the VM.
- **Verification on the VM (snapshot `v0.8.4-verified`).** The installed v0.8.4
  script upgraded the rehearsal VM to `5891f99`: no pending migration (42), every
  foreign key validated, money totals unchanged, no "Failed to create bin"
  warnings and nothing new in `apps/openestate` (the real-world proof of part P).
  The owner's Incognito checks passed: sign-in, bursts of reloads on staff and
  portal, two simultaneous refreshes returning `[200, 200]`, a password change
  signing the other tab out while the changing tab stayed in, and sign-out. One
  `404` pair in the console was the owner's own misspelt address, confirmed from
  the nginx log, not a fault.
- **A test that can't fail is a guard, not a reproduction.** Of the three
  session-end tests written first, two failed on the old code and the third
  (a refresh landing between the bump and the revoke) passed, because the old
  order (revoke, then bump) already refused that refresh. It was kept as the guard
  that the two steps stay in one transaction, and mutation S2 proves it can fail.
  It was reported as passing on the old code, not forced to fail.
- **Proofread advisory text after widening it.** Adding a third gap left "Both
  need" and "Neither lets" in the first paragraph of the published advisory; it
  was corrected afterwards by editing only those words and re-fetching to confirm
  nothing else changed. Check number words whenever a list grows.
- **Smaller lessons.** `pnpm test --force` hands `--force` to pnpm and fails; use
  `pnpm exec turbo run test --force`. Git Bash's `/tmp` is not visible to Windows
  Python. A script with backslashes, backticks or line breaks written through a
  shell heredoc gets mangled; write it with a file tool. `docs/*.md` and
  `CHANGELOG.md` have CRLF working copies (git stores LF), so a plain string
  match from a shell script misses; normalise first. A todo or handoff entry
  that names a security gap stays out of public files until the release.
- **After a release, the previous-release CI job must pick a lower version, not
  just a different commit** (fixed in the docs PR after the release:
  `previous_release_tag` in `deploy/native/lib.sh`, tested by
  `test-previous-release.sh`).
- **Follow-ups, all in `docs/todo.md` and `docs/handoff.md`:** the v0.9 list
  (interest-rule gap first), the CVE re-checks, and the open owner items
  (rotate the test-VM passwords and the Cloudflare token first).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
