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

## Internal decisions and operations

The project's decisions log, current operational state and internal plans are
maintained privately and are not part of this repository. Everything a
contributor needs to build, test and change the code is in this file, in
CONTRIBUTING.md and in the docs site.
