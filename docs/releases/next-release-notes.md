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

## Deprecated

- **`POST /api/v1/bookings`** still works for API clients, but creates a
  booking with no payment plan. Use `POST /api/v1/bookings/with-plan`. The
  separate `/bookings/:id/plan/...` endpoints stay.

## Before you upgrade

No migrations, no new environment variable, no permission changes.

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
