# Release notes: next release (draft)

The version number is decided at release. Built so far on `next/v0.10.1`; v0.10.0's notes are in
[v0.10.0-release-notes.md](v0.10.0-release-notes.md).

## What's new

- **Delete and restore a lead.** A lead (inquiry) can be deleted with a reason (Duplicate, Junk or test, Customer asked,
  or Other with a note), after a confirmation. A deleted lead disappears from every list, report, reminder and the
  dashboard, and can be restored from **Inquiries → Deleted leads** until it is purged; the daily purge removes it, with
  its follow-ups and history, after the company's retention period (**Company Config → Deleted Leads**, default 30 days).
  The person's contact record (applicant) is never deleted. A lead that converted to a booking can't be deleted.
  Needs the new permission `presales.lead.delete`.
- **Receipt Entry finds the payer by name, phone or booking number** for the accounts role, which has no pre-sales
  access. Only people on an active booking are offered, with a masked phone.
- **Post-sales reports for finance roles.** The new permission `reports.postsales.company-wide` makes the dues, ageing,
  collection and applicant-ledger reports cover the whole company instead of the bookings the user's team created.
  Accounts' Dues Dashboard now shows every booking.

## Changed

- **Refunds** are checked against the booking's ledger when requested (net of other open requests), approved and paid;
  a request, approval or payment above what is refundable is refused with the amounts.
- **Interest waivers** are limited to the interest charged on the booking less earlier waivers, and refused on a
  cancelled, surrendered or transferred booking (409).

## Roles and permissions

Added on upgrade through the seed baseline (an admin who removes them keeps them removed):

| Permission | Added to |
|---|---|
| `presales.lead.delete` | company_admin (super_admin holds every key) |
| `reports.postsales.company-wide` | accounts, company_admin |

`presales.inquiry.delete` has never been used by any route and still isn't; deleting a lead checks
`presales.lead.delete` only.

## Upgrading

Two migrations: new columns on `inquiries` (deleted leads) and `company_configs` (retention), an index, and one new
foreign key (`inquiries.deleted_by_id`), added unvalidated and validated by the second migration. No existing data
changes. The foreign-key count goes from 283 to 284.

### After you upgrade: what to check

The upgrade prints two new read-only reports after the company-references report. Neither changes anything.

- **Refunds:** bookings whose approved refunds are above what the booking held, with the amount over. If any are
  listed, check each booking's ledger and refunds with your accountant.
- **Interest waivers:** bookings whose waivers are above the interest charged, with the amount over. Check each with
  your accountant.

## API changes

- New: `GET /receipts/payers`, `DELETE /inquiries/:id`, `POST /inquiries/:id/restore`, `GET /inquiries/deleted`.
- `PATCH /company/config` accepts `leadPurgeAfterDays` (1 to 3650).
- `POST /bookings/:id/interest/waive` answers 409 above the waivable interest or on an inactive booking.
- `POST /bookings/:bookingId/refunds`, `/refunds/:id/approve` and `/refunds/:id/pay` answer 400 above the refundable
  amount.

## Known limitations

- `presales.inquiry.delete` remains in the permission list, unused (to be removed in a later release).
