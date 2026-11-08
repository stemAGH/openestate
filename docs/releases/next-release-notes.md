# Release notes: next release (draft)

The version number is decided at release.

## What's fixed

**A refused payment plan no longer leaves a booking without a plan.** The
booking wizard used to create the booking first and its payment plan in a
second request. The plan step showed and collected amounts against the price
*excluding* GST, but the server requires the installments to add up to the
price *including* GST. So the plan was refused, and the booking was left
BOOKED with no plan. Its unit stayed booked, and booking that unit again was
refused.

Now:

- The wizard works out the price first (cost lines with GST) and shows
  **Total payable (GST included)** on the payment-plan and confirm steps.
- A custom schedule is checked against that total as you type, and you
  can't continue until it matches.
- The booking, its payment plan and its delay-interest rule are created in
  **one request**. If any part is refused, nothing is booked, the unit stays
  free, the booking number isn't used up, and the screen says why.
- If the price changes between the preview and booking (for example a GST
  rate is edited in Masters), the booking is refused with the old and new
  totals.

**Two bookings of one unit at the same moment can no longer both succeed.**
Nothing in the database stopped two active bookings on the same unit. Two
bookings made at the same moment could both succeed, and so could a booking
racing a manual block of the unit, or a transfer into a unit racing a booking
of it. Every change to a unit's status now locks the unit first, so the second
request sees the first one's result and is refused.

## New

- **"Create payment plan" on the installment schedule** of any active booking
  that has no payment plan. Choose a template or enter a custom schedule. A
  custom schedule must add up to the booking's agreed price including GST,
  shown on the panel.
- **API:**
  - `POST /api/v1/bookings/quote` prices a booking without saving anything.
    It needs `postsales.booking.create`.
  - `POST /api/v1/bookings/with-plan` creates a booking and its plan, and
    optionally its delay-interest rule, in one transaction. It needs
    `postsales.booking.create` and `postsales.plan.edit`, plus
    `postsales.interest.manage` when an interest rule is sent. Those are the
    same permissions as the separate calls.

## Sales screens

- **Inquiries list:** a search box (name, phone or email) and filters for status,
  temperature, project, follow-up due (today or overdue) and, for managers, owner.
  The filters are kept in the address, so a link or the back button reopens the same
  view. New columns: next follow-up ("Today" or "2 days overdue", with the date),
  owner, and Call and WhatsApp buttons on every row.
- **Inquiry page:** the follow-up form sits beside the details (above them on a
  phone), with the history newest first. Status buttons read "Mark as Continued"
  and so on, and the page has Call and WhatsApp buttons. Reassign shows only for
  people allowed to reassign.
- **Dashboard:** the greeting uses your name, and each count opens the list filtered
  to exactly what it counts.
- **Dates on these screens** are shown as DD-MM-YYYY, in India Standard Time.
- **Fixed:** sales managers and executives got hidden "access denied" errors on the
  Inquiries pages. Nothing visible changes; the pages just stop asking for data those
  roles can't read.

### Dashboard counts can move at midnight IST

"Follow-ups due today", "Overdue follow-ups" and My Day now count by the **IST
calendar day**, on any server. They used to use the server's own time zone. On a
server set to IST nothing changes. On a server set to UTC (or anything else), the
counts used to roll over at the server's midnight, which is 05:30 IST for UTC. They
now roll over at midnight IST, and they match the new follow-up filter on the
Inquiries list exactly.

### API

- `GET /api/v1/inquiries` takes `search`, `status` (one or more, comma-separated),
  `temperatureId`, `projectId`, `assignedToId` and `followUp` (`today` or `overdue`).
  Same permission as before (`presales.inquiry.read`), and a filter never shows a
  lead outside your team.
- **Stricter:** unknown query parameters are now refused (400), and `sortBy` accepts
  only `createdAt` and `nextFollowupAt`. An API client that sent anything else got it
  silently ignored (or a 500 for an unknown `sortBy`) and now gets a 400 that names it.
  `search` was accepted before but ignored; it now filters.

## Sensitive identifier fields in API responses

This release tightens how sensitive identifier fields appear in API responses.
Only the masked value of an identifier is returned, on every endpoint, and new
audit entries no longer store internal identifier fields. Stored audit entries
are unchanged; these fields are left out when they are shown. No action is
needed, and no screen changes.

## Phone numbers are masked in lists

Every screen and API response that lists many people now shows only the last
4 digits of a phone number (`••••••3210`). Detail pages, PDFs and CSV exports
keep the full number.

- **Screens:**
  - Inquiries, My Day, Applicants, Brokers, the duplicate warning, and the
    applicant pickers in the booking wizard and Receipt Entry.
  - The audit log, communications, dispatch history and pending change
    requests.
  - The on-screen pre-sales Inquiries Export, the birthday list and the
    broker dues report.
- **Call and WhatsApp in lists:** pressing one fetches the number from the
  inquiry's own record, with the same permission and team scope, so the list
  never carries it. Call opens your phone app. WhatsApp opens a new tab.
- **API change for integrations:** list endpoints now return masked values in
  `primaryPhone`, `primaryPhoneNormalized`, `alternatePhones` and `phone` (and
  `toAddress` / `recipientAddress` for SMS):
  - `GET /inquiries`, `/inquiries/my-day`, `/applicants`,
    `/applicants/:id/duplicates`, `/brokers`, `/users` and `/audit`;
  - the `possibleDuplicates` in `POST /inquiries`;
  - communications, dispatch history and `/admin/change-requests`;
  - the JSON form of the reports above.

  Read a single record (`GET /applicants/:id`, `/inquiries/:id`,
  `/brokers/:id`, `/users/:id`) for the full number. Search by phone still
  works on the full number.
- **CSV downloads need `presales.report.export`:**
  - It already applied to the pre-sales exports. It now also applies to the
    birthday list and all broker reports, and each download writes an audit
    row.
  - Every standard role that can view those reports already holds it.
  - **Admins with custom roles** that view the birthday list or the broker
    reports should check the role also holds `presales.report.export`, or the
    CSV button will be refused.
  - The on-screen view of every report is unchanged and needs only the view
    permission, as before.
- **Logs:** phone numbers typed into a search box are now masked in the
  request log. **Logs from earlier releases may contain phone numbers from
  search URLs** (for example `GET /api/v1/applicants?search=98765…`). Treat
  them as personal data under your retention rules.

## Deprecated

- **`POST /api/v1/bookings`** still works for API clients, but creates a
  booking with no payment plan. Use `POST /api/v1/bookings/with-plan`. The
  separate `/bookings/:id/plan/...` endpoints stay.

## Before you upgrade

No migrations, no new environment variable, no permission changes. If you have
scripts that call `GET /api/v1/inquiries`, check they send only the parameters
listed above. Scripts that read phone numbers from list endpoints must read the
single record instead (see "Phone numbers are masked in lists").

## After you upgrade: two reports to read

The upgrade output prints two new counts per company. Neither changes
anything.

1. **"Payment plans: N active booking(s) have no payment plan"**, followed by
   their booking numbers. These are most likely bookings left by the old
   wizard. For each one, open its installment schedule (Post-sales → the
   booking) and either:
   - **Create payment plan**, so the installments add up to the agreed price
     including GST shown on the panel; or
   - **Cancel Booking** if it was never meant to stand. This releases the unit.
     Nothing was received on such a booking, so nothing is refunded.

   If the count is 0, there is nothing to do.
2. **"Units: N unit(s) have more than one active booking"**, followed by the
   unit and its booking numbers. This could only happen through the race fixed
   above. For each unit:
   - Decide which booking stands; check receipts first.
   - Cancel the other booking, or transfer it to a free unit, from its
     installment schedule.

   If the count is 0, there is nothing to do.

## How this was checked

- **Automated tests:**
  - the old wizard requests, reproduced through the API
  - an equivalence test holding the moved pricing code to the original on
    2,000 generated bookings
  - forced-interleaving tests for each race, including two that deadlock if
    the locks are taken in the wrong order
  - through-the-wire tests for both new endpoints, including a refusal at
    the last step that leaves nothing behind
  - browser tests of the wizard and the new panel
- **Mutation checks:** each protection listed in the pull request was removed
  in turn, and a test failed each time.
- **Not yet done:** a rehearsal of the upgrade on the verification machine.
