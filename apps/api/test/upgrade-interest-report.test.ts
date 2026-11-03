/**
 * v0.9 ruling (e): no rule is attached on upgrade; the upgrade prints how many
 * active bookings have none. bookingsWithoutInterestRule is what the sync CLI
 * prints (packages/db/prisma/sync-permissions.ts). Scoped to this file's
 * company, because other test files create bookings concurrently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  makeClients,
  seedCompany,
  makeUnit,
  makeApplicant,
  cleanupCompany,
  TEST_SUPER_URL,
  type CompanyFixture,
} from './helpers/postsales-harness';
import { PrismaClient } from '@openestate/db';
import { bookingsWithoutInterestRule } from '../../../packages/db/prisma/sync-permissions';

const describeIf =
  process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

describeIf('upgrade report: active bookings with no interest rule', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ systemPrisma, tenantPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function booking(status: string, interestRuleId: string | null = null) {
    return systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId: await makeUnit(systemPrisma, fx),
        primaryApplicantId: await makeApplicant(systemPrisma, fx.companyId),
        bookingNumber: `RPT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status,
        agreedPricePaise: 100n,
        bookingDate: new Date('2026-01-01'),
        interestRuleId,
      },
    });
  }

  it('counts active bookings with no rule, and only those', async () => {
    const rule = await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: 'r', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    });
    await booking('BOOKED');
    await booking('ALLOTTED');
    await booking('REGISTERED');
    await booking('BOOKED', rule.id); // has a rule
    await booking('CANCELLED'); // not active
    await booking('APPLICATION'); // not active

    const rows = await bookingsWithoutInterestRule(systemPrisma, { companyId: fx.companyId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: fx.companyId, count: 3 });
  });

  it('counts a booking whose rule no longer exists (an orphan) as having no rule', async () => {
    // The state a v0.8.4 install can be in: the key is NOT VALID and a row
    // points at a deleted rule. Accrual finds no rule for it, so it charges
    // nothing; the report must say so. The orphan is planted with foreign-key
    // triggers off for this one transaction (superuser only).
    const before = (await bookingsWithoutInterestRule(systemPrisma, { companyId: fx.companyId }))[0]?.count ?? 0;
    const orphan = await booking('BOOKED');
    const sup = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
    try {
      await sup.$transaction([
        sup.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        sup.$executeRawUnsafe(`UPDATE bookings SET interest_rule_id = gen_random_uuid() WHERE id = $1::uuid`, orphan.id),
      ]);
    } finally {
      await sup.$disconnect();
    }
    expect((await systemPrisma.booking.findUnique({ where: { id: orphan.id } })).interestRuleId).not.toBeNull();
    const rows = await bookingsWithoutInterestRule(systemPrisma, { companyId: fx.companyId });
    expect(rows[0].count).toBe(before + 1);
  });
});
