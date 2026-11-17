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
- **Edit a lead's details** on Inquiry Detail (**Edit details**): project, source, type, temperature, preferred unit
  type, budget and custom fields. The budget range must stay in order.
- **Edit a person's contact details** on Applicant 360 (**Edit contact**). A phone or email another person already has
  is flagged with the match; you can confirm they are different people and save (records are not merged from here).
  If the customer signs in to the portal with the phone or email being changed, only an admin (`admin.user.update`)
  can change it: their portal login moves to the new value and they are signed out.
- **Bookings list** under Post-Sales, with the outstanding balance, search by booking number, name or phone, and
  filters. Sales roles see their team's bookings; accounts and admins see the whole company.
- **Booking details** on the installment schedule: a remark, and co-applicants (add, remove, reorder). Adding a
  co-applicant says first that their portal account will then see the booking. The broker can no longer be changed
  once commission has accrued.
- **Reassign** offers only people who can take the lead (active, in your team, with lead access).
- **Receipt Entry finds the payer by name, phone or booking number** for the accounts role, which has no pre-sales
  access. Only people on an active booking are offered, with a masked phone.
- **Post-sales reports for finance roles.** The new permission `reports.postsales.company-wide` makes the dues, ageing,
  collection and applicant-ledger reports cover the whole company instead of the bookings the user's team created.
  Accounts' Dues Dashboard now shows every booking.

## Changed

- **Refunds** are checked against the booking's ledger when requested (net of other open requests), approved and paid;
  a request, approval or payment above what is refundable is refused with the amounts.
- **A bounced refund cheque** sends the refund back to *requested*: paying it again needs a new approval, which checks
  what is owed now. If less is owed (for example after a bounce charge), the approval says so with both amounts;
  reject the refund and request the correct amount. Refunds can now be rejected.
- **Interest waivers** are limited to the interest charged on the booking less earlier waivers, and refused on a
  cancelled, surrendered or transferred booking (409).
- **Audit log:** an edit now records the previous values of the fields changed, not only the new ones.
- **Accounts' dashboard** shows links to the role's areas instead of a lead summary it can't read.

## Roles and permissions

Added on upgrade through the seed baseline (an admin who removes them keeps them removed):

| Permission | Added to |
|---|---|
| `presales.lead.delete` | company_admin (super_admin holds every key) |
| `reports.postsales.company-wide` | accounts, company_admin |

`presales.inquiry.delete` has never been used by any route and still isn't; deleting a lead checks
`presales.lead.delete` only. Reassign no longer needs `admin.user.read`.

## Upgrading

Three migrations: new columns on `inquiries` (deleted leads) and `company_configs` (retention), an index, and one new
foreign key (`inquiries.deleted_by_id`), added unvalidated and validated by the second migration; the third adds a
nullable `remark` column to `bookings`. No existing data changes. The foreign-key count goes from 283 to 284.

### After you upgrade: what to check

The upgrade prints two new read-only reports after the company-references report. Neither changes anything.

- **Refunds:** bookings whose approved or paid refunds are above what the booking held, with the amount over. If any
  are listed, check each booking's ledger, refunds and refund payments with your accountant.
- **Interest waivers:** bookings whose waivers are above the interest charged, with the amount over. Check each with
  your accountant.

## API changes

- New: `GET /receipts/payers`, `DELETE /inquiries/:id`, `POST /inquiries/:id/restore`, `GET /inquiries/deleted`,
  `GET /inquiries/:id/assignable-users`, `GET /bookings`, `PATCH /bookings/:id` (remark),
  `POST /bookings/:id/co-applicants`, `DELETE /bookings/:id/co-applicants/:applicantId`,
  `PUT /bookings/:id/co-applicants/order`, `POST /refunds/:id/reject`.
- `PATCH /company/config` accepts `leadPurgeAfterDays` (1 to 3650).
- `PATCH /applicants/:id` accepts `confirmDistinct`; a phone or email another person has answers 409 with the matches;
  changing a portal customer's sign-in phone or email needs `admin.user.update` (403 otherwise).
- `PATCH /inquiries/:id` answers 400 when the budget range would be out of order.
- `PATCH /inquiries/:id/assign` answers 400 for a deactivated user or one whose role can't open leads.
- `POST /bookings/:id/broker` answers 409 once commission has accrued on the booking.
- `POST /bookings/:id/interest/waive` answers 409 above the waivable interest or on an inactive booking.
- `POST /bookings/:bookingId/refunds`, `/refunds/:id/approve` and `/refunds/:id/pay` answer 400 above the refundable
  amount. After a refund cheque bounces, `/refunds/:id/pay` answers 409 until the refund is approved again.

## Known limitations

- `presales.inquiry.delete` remains in the permission list, unused (to be removed in a later release).
- A broker change and a commission accrual on the same booking at the same moment are not serialised by one lock
  (commission accrual is frozen code); the broker check runs under the booking row lock.
