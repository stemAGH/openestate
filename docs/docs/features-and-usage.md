---
id: features-and-usage
title: Features & Usage Guide
sidebar_position: 2
---

# OpenEstate — Features & Usage Guide

## What OpenEstate is

OpenEstate is a free, open-source, self-hosted CRM built specifically for
real-estate developers in India — covering the full lifecycle from a
website lead to a registered, paid-off unit, plus dedicated portals for
customers and brokers. It's distributed the way Zabbix and Wazuh are:
download it, run it on your own server, own your data, pay nothing for
the software itself.

**Who it's for:** real-estate developers and channel-sales teams who
currently manage leads in spreadsheets, track collections manually, or pay
recurring license fees to a closed-source CRM for features this covers
natively — GST/TDS-aware receipts, RERA fields, broker commission ledgers,
and Indian payment-plan conventions.

---

## The core idea: one system, three audiences

| Audience | What they use |
|---|---|
| **Your staff** (sales, accounts, admin) | The main web admin app — leads, bookings, receipts, reports |
| **Your customers** | A mobile-friendly customer portal — their unit, dues, documents, support tickets |
| **Your brokers** | A mobile-friendly broker portal — their sales, commission ledger, NOC actions |

All three read from and write to the same underlying data, in real time,
with role-based access so each audience sees only what they should.

---

## Module walkthrough

### 1. Pre-sales — turning inquiries into bookings
- Capture leads from walk-ins, phone calls, your website, or property
  portals (99acres, MagicBricks, etc. via the inbound lead API).
- Automatic duplicate detection — a lead with a phone number already in
  the system links to the existing person instead of creating a
  duplicate.
- A configurable lead-stage pipeline (admin-defined stages beyond the
  base Open/Continued/Dumped/Successful status, with a full stage-history
  audit trail per lead) sitting alongside — not replacing — that status.
- Round-robin auto-assignment across your sales team, or manual
  reassignment. Lead visibility follows your manager hierarchy: a manager
  sees their own leads plus their full reporting subtree, not the whole
  company, unless their role is explicitly granted company-wide visibility.
- A follow-up timeline per lead (calls, site visits, emails) with an
  overdue-follow-up queue so nothing falls through.
- A pre-sales reporting suite — funnel, source-conversion, staff- and
  manager-performance, and more, each filterable by date range and
  project, scoped by the same manager hierarchy, with view/export/print
  as separate permissions.

### 2. Post-sales — the part other CRMs don't get right
This is OpenEstate's core differentiator. Once a lead converts:
- **Inventory isn't limited to apartment-style towers.** A project can
  also be plotted/farmhouse/villa land inventory — priced and booked per
  acre or guntha (not forced through a per-square-foot conversion), with
  an optional Sector/Block/Cluster grouping for browsing. Both shapes
  live in the same booking flow below.
- **Booking wizard**: applicant + co-applicants, unit selection, a
  cost breakup (base price + preferential-location charges + parking +
  club + maintenance + GST), and a payment plan (down-payment,
  construction-linked, or custom).
- **Auto-generated installment schedule** from the payment plan.
- **Receipt entry** — fast, keyboard-first, with automatic oldest-dues-first
  allocation across installments, cheque lifecycle tracking (received →
  deposited → cleared/bounced), and correct GST split (CGST+SGST for
  in-state, IGST for inter-state, based on where the property is located
  — not where the buyer lives, per Indian tax law).
- **TDS tracking** (Section 194-IA) on payments above threshold, with a
  certificate-received flag and report.
- **Interest on delayed payments** (simple or compound) is calculated by
  the system, but it can't yet be switched on for a booking from the app,
  so in practice no interest is charged today. See the known gaps below;
  a fix is planned for v0.9.
- **Transfers** (re-selling a booking to a new buyer, or swapping units)
  and **cancellations/surrenders** with configurable deduction rules and a
  refund workflow — every rupee is traceable through an append-only
  ledger that always reconciles.
- **Documents**: allotment letters, demand letters, payment receipts, and
  account statements — auto-generated PDFs, using your own letterhead and
  templates.

### 3. Broker management
- Broker registry with RERA agent numbers, bank details, and commission
  rules (flat percentage or slab-based, e.g. 1% up to ₹50L, 1.5% up to
  ₹1Cr, 2% above).
- Commission accrues automatically on booking confirmation or on
  collection milestones — your choice.
- TDS on commission (Section 194-H) computed automatically.
- Cancellation clawback: if a broker's booking is later cancelled, unpaid
  commission is reversed and paid commission can be recovered or written
  off per your company policy.
- An NOC (no-objection) workflow — a broker can be required to
  acknowledge a cancellation before it proceeds.
- Broker statements as downloadable PDFs.

### 4. Customer portal
Your buyers log in from their phone to see:
- Their unit details, layout plans, and monthly construction-progress
  photos you publish.
- Their full cost breakup, payment schedule, and payment history.
- Self-service downloads: account statement, past receipts, current
  demand letter.
- A way to request updates to their phone/email (routed to your staff for
  approval — nothing changes on your records without your sign-off).
- A support ticket system.

### 5. Broker portal
Your channel partners log in to see:
- Every unit they've sold and its status.
- Their commission — due, received, outstanding — in real time.
- Live unit availability across your projects.
- The ability to approve/reject an NOC request from your team.
- Their commission statement, downloadable.

### 6. Reports
Dues by project/tower/floor/applicant with ageing buckets, daily/monthly
collection summaries, applicant ledgers, unit-sold vs available, broker
commission summaries, and more — every report exports to CSV.

### 7. Customization — this isn't just for real estate
- **Custom fields** on Applicants, Inquiries, and Projects, admin-configurable,
  no code required (Unit-level definitions can be created but not yet
  filled in — see "Known gaps" below).
- **An Aadhaar safety net on custom fields.** OpenEstate does not collect
  Aadhaar numbers. As a safety net against *accidental* entry, a custom field
  named after Aadhaar is refused, and a custom-field value that looks like an
  Aadhaar number is refused when saved; values already stored are shown
  masked (last four digits) on detail screens and in the inquiries CSV
  export. This is not a guarantee. About 1 in 10 random 12-digit numbers look
  valid and are refused; a number with a typo, or written with other
  separators, is not caught; and it checks custom-field values only, not
  names, addresses, notes or other free text. Masking is on display and
  export only: the raw value is still stored and is still in the API
  response. A field that legitimately holds a 12-digit number, such as a bank
  account, can be exempted by an admin. To see what is already stored, run
  `sudo ./deploy/native/find-aadhaar-like-values.sh` (read-only; reports
  field names and counts, never values).
- **Terminology overrides** — rename "Unit" to "Product," "Booking" to
  "Order," and the whole app relabels itself. A proof-of-concept
  `generic-sales` plugin ships showing exactly how far this goes.
- **Module flags** — hide entire sections (e.g. turn off post-sales if
  you only need lead management).
- **Plugin system** — messaging providers, telephony integrations, and
  lead sources are all pluggable; a webhook system lets you connect
  OpenEstate to anything else in your stack.

---

### 8. Account security and recovery
- Two-factor authentication (an authenticator app, plus one-time recovery
  codes) for staff, customers and brokers, each turned on from their own
  Settings or Security page.
- When someone loses both their phone and their recovery codes, a company
  admin clears their 2FA: from Admin → Users for staff, or from the
  customer's or broker's record for portal accounts. Their password stays
  the same, they're signed out everywhere, and they can set 2FA up again.
  Sales managers can send a portal password-reset link but cannot clear
  2FA.
- If the only admin is locked out, whoever runs the server can reset their
  password — and, with `--clear-2fa`, their 2FA — from the command line
  (see the installation guide).
- Every 2FA change and password change lands in the audit log, including
  who did it and from where.

## What OpenEstate deliberately does not do (yet)

Honesty matters more than a feature list. As of v0.8.5:
- No native mobile app (the portals are mobile-web, not App Store apps).
- No built-in accounting/GL beyond the receivables ledger — it's not a
  full accounting system; export to your accountant's tool.
- Tax logic (GST/TDS/RERA) is India-specific. The platform architecture
  is country-agnostic (currency, terminology, and tax masters are all
  configurable), but non-Indian tax rules haven't been built — that's
  configuration/extension work for a future contributor, not a turnkey
  feature today.
- The plugin system trusts first-party, in-repo plugins (reviewed code),
  not arbitrary third-party uploads — it is not yet a sandboxed
  marketplace.

## Known gaps before you run a real project on this

Found on a full pre-pilot walkthrough, not from a spec — each is a real
limitation of the current build, not a bug you'll hit by accident:

- ~~You cannot edit a project once created~~ — **fixed.** ProjectDetail
  now has an Edit Project form (name, RERA number, address, location,
  dates, custom fields). The project `code` stays fixed — it's used to
  match projects during bulk inquiry CSV import — and changing a
  project's area/location warns about the booking count first if the
  project already has bookings (existing bookings' GST is unaffected;
  it's a one-time snapshot).
- ~~GST on a booking's cost lines defaults to 0% unless every line names
  its own rate~~ — **fixed.** The booking wizard now has a GST-rate
  picker on the base price line, and the booking is rejected outright
  (not silently priced at 0%) if any cost line's rate can't be resolved.
  Bookings created before this fix are unaffected (rates are
  immutable snapshots) — check Post-sales → Reports → "Zero-GST
  bookings" for any that need a manually-corrected document.
- ~~No staff screen to publish a construction update or photo~~ —
  **fixed.** `ProjectDetail.tsx` now has a Construction Updates panel:
  create (title/description/date), attach photos, list, delete.
- ~~No staff screen to view or reply to a customer's support ticket~~ —
  **fixed.** Support → Tickets lists open tickets; the detail screen
  replies and changes status.
- **Custom fields on a Unit can be defined but never captured or shown.**
  Applicant, Inquiry, and Project custom fields work end to end; a
  Unit-level custom field has no form to fill it in on today — there's
  no single-unit edit screen to hang one on yet (units are created via
  Bulk-Generate or CSV import, not one at a time).
- **The audit log is incomplete.** From v0.7.1, create, update and delete
  actions on audited records are recorded with the acting user and IP, and
  a failed audit write fails the action. Before v0.7.1 most of them were
  not recorded at all, and that history can't be recovered. Still missing:
  an UPDATE row shows the new values only, not the old ones; changing a
  role's permissions, and a few other bulk changes, write no row; and the
  log is protected by the application, not the database.
- **Delayed-payment interest can't be switched on.** Interest rules can be
  set up under Masters, but there is no way in the app to attach one to a
  booking, so no interest is ever charged. A fix is planned for v0.9.
- **`Project.isActive` has no enforced effect anywhere.** It's shown as
  a read-only column and set at creation, but nothing — not
  available-unit lookups, not reports, not the portal — reads it.
  Deliberately left out of the project-edit form rather than shipping a
  toggle that looks like it does something and doesn't.

See [docs/todo.md](https://github.com/stemAGH/openestate/blob/master/docs/todo.md)
for the complete, maintained list, including smaller deferred items.

---

## A typical week, module by module

**Monday:** Sales reviews weekend leads from the website (auto-captured
via the inbound lead API), the round-robin assigns them, follow-ups get
scheduled. **Wednesday:** A site visit converts — booking wizard, payment
plan selected, first receipt recorded, allotment letter auto-generated and
emailed. **Friday:** Accounts runs the collection report, verifies two
cheques in the queue, and processes a broker commission payment. Ongoing:
a customer checks their dues on their phone before making a bank transfer;
a broker checks a live availability grid before bringing a client to site.

---

## Getting started

See the [Installation Guide](./installation.md) for setup. Once running,
walk through the "First login and initial setup SOP" section, then the
"dry-run booking" step before inviting real customers.
