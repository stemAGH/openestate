import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedE2eFixture } from './fixtures/seed';
import { DATABASE_URL_SYSTEM } from './playwright.config';

// Runs once before any spec. Precondition (not started here, matching
// apps/api's own vitest.config.ts contract): the disposable test Postgres
// + Redis are already up — `bash scripts/test-setup.sh` from the repo
// root. Seeds one fixture company directly via Prisma (see fixtures/seed.ts
// for why this doesn't import apps/api's or packages/db's own test/seed
// helpers directly) and writes it to a JSON file the spec files read —
// simpler and more explicit than relying on env var propagation into
// Playwright's worker processes.
//
// One independent company+admin PER SCENARIO, not one shared across all
// four — auth-2fa.spec.ts changes its admin's password and enables 2FA
// as part of what it's testing, which would break the others if they
// ever ran after it against the same account. Isolated fixtures make the
// specs order-independent and safely parallelizable later, matching how
// every backend test file in this project seeds its own company rather
// than sharing one.
export default async function globalSetup() {
  const fixtures = {
    authTwoFactor: await seedE2eFixture(DATABASE_URL_SYSTEM, { forcePasswordChange: true }),
    mastersCrud: await seedE2eFixture(DATABASE_URL_SYSTEM),
    // Its own company: lead-stage.spec.ts briefly makes a new stage the
    // company-wide default and expects exactly one inquiry in it. On the
    // shared mastersCrud company, any spec creating an inquiry in parallel
    // could land in that stage too.
    leadStage: await seedE2eFixture(DATABASE_URL_SYSTEM),
    chequeBounce: await seedE2eFixture(DATABASE_URL_SYSTEM),
    plcBooking: await seedE2eFixture(DATABASE_URL_SYSTEM, { withPricingMasters: true }),
    ticketReply: await seedE2eFixture(DATABASE_URL_SYSTEM, { withPortalTicketSetup: true }),
    // Its own isolated portal user, same reasoning as authTwoFactor above
    // (that comment's "four" is now five, this is the sixth reason): this
    // spec enables 2FA on the account it logs into, which would break
    // ticket-reply/media-gallery/rapid-reload-session's own portal logins
    // if they ran afterward against the SAME account and got a
    // requiresTwoFactor response instead of a session. withPortalTicketSetup
    // is reused as-is (not a new leaner opt) — every fixture call already
    // pays for a full company+inventory seed regardless of which opts are
    // set, so the marginal cost of the ticket/land-booking rows this spec
    // doesn't use is small next to a second seed.ts code path to maintain.
    portalTwoFactor: await seedE2eFixture(DATABASE_URL_SYSTEM, { withPortalTicketSetup: true }),
    // Its own company and portal user, for the same reason as the two
    // above: admin-reset-links.spec.ts resets this portal user's password
    // through a generated link, which would break every other spec that
    // logs in as a shared fixture's portal user with the original one.
    resetLinks: await seedE2eFixture(DATABASE_URL_SYSTEM, { withPortalTicketSetup: true }),
    // Separate accounts for the recovery-code specs, for the same reason:
    // each one enables 2FA and uses up recovery codes on the account it
    // logs into.
    staffRecoveryCode: await seedE2eFixture(DATABASE_URL_SYSTEM),
    portalRecoveryCode: await seedE2eFixture(DATABASE_URL_SYSTEM, { withPortalTicketSetup: true }),
    // Separate accounts for the admin 2FA reset specs, for the same reason:
    // each turns 2FA on for an account and then has an admin clear it.
    staffTotpReset: await seedE2eFixture(DATABASE_URL_SYSTEM),
    portalTotpReset: await seedE2eFixture(DATABASE_URL_SYSTEM, { withPortalTicketSetup: true }),
    // Its own company and portal user: session-ended-portal.spec.ts deactivates
    // that portal user.
    portalSessionEnded: await seedE2eFixture(DATABASE_URL_SYSTEM, { withPortalTicketSetup: true }),
    // Its own company: role-permission-edit.spec.ts edits this company's
    // Customer portal role, which other specs' portal users depend on.
    rolesPortal: await seedE2eFixture(DATABASE_URL_SYSTEM, { withPortalTicketSetup: true }),
    // Its own company: interest-rule.spec.ts books the fixture's unit and
    // attaches a delay-interest rule to the booking.
    interestRule: await seedE2eFixture(DATABASE_URL_SYSTEM),
  };
  writeFileSync(path.join(__dirname, '.fixture-state.json'), JSON.stringify(fixtures, null, 2));
}
