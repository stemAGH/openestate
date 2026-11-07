/**
 * Follow-Up Page spec gap #2 (internal plan followup-spec-gap-analysis.md,
 * SOP rule 5): Dump requires a reason (from configurable master data)
 * and remarks, and every InquiryStatus transition — not just Dump —
 * now writes an InquiryDispositionHistory row, closing the one axis of
 * three (stage/ownership/status) that had no dedicated history table.
 *
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runWithTenant, withTenantTx } from '@openestate/db';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { InquiryService } from '../src/presales/inquiry.service';
import { AssignmentService } from '../src/presales/assignment.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { LeadStageTransitionService } from '../src/presales/lead-stage-transition.service';
import { InquiryDispositionTransitionService } from '../src/presales/inquiry-disposition-transition.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describeIf('Inquiry disposition: Dump reason+remarks, disposition history', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let inquiryService: InquiryService;
  let companyA: CompanyFixture;
  let companyB: CompanyFixture;
  let dumpReasonId: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    companyA = await seedCompany(systemPrisma);
    companyB = await seedCompany(systemPrisma);

    const assignmentService = new AssignmentService(tenantPrisma);
    inquiryService = new InquiryService(
      tenantPrisma,
      systemPrisma,
      SYSTEM_CLOCK,
      assignmentService,
      undefined as never,
      new CustomFieldsService(tenantPrisma, systemPrisma),
      new LeadStageTransitionService(),
      new InquiryDispositionTransitionService(),
    );

    const reason = await systemPrisma.dumpReason.create({
      data: { companyId: companyA.companyId, name: 'Budget mismatch', sortOrder: 0 },
    });
    dumpReasonId = reason.id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, companyA.companyId);
    await cleanupCompany(systemPrisma, companyB.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('refuses to dump without a reason', async () => {
    const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
    const inquiry = await inquiryService.create(companyA.companyId, { applicantId }, companyA.userId);

    await expect(
      inquiryService.update(
        companyA.companyId,
        inquiry.id,
        { status: 'DUMPED', dumpRemarks: 'No reason selected' },
        { visibleUserIds: null },
        companyA.userId,
      ),
    ).rejects.toThrow(/requires both a reason and remarks/i);
  });

  it('refuses to dump without remarks', async () => {
    const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
    const inquiry = await inquiryService.create(companyA.companyId, { applicantId }, companyA.userId);

    await expect(
      inquiryService.update(
        companyA.companyId,
        inquiry.id,
        { status: 'DUMPED', dumpReasonId },
        { visibleUserIds: null },
        companyA.userId,
      ),
    ).rejects.toThrow(/requires both a reason and remarks/i);
  });

  it('refuses a dumpReasonId belonging to another company', async () => {
    const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
    const inquiry = await inquiryService.create(companyA.companyId, { applicantId }, companyA.userId);
    const foreignReason = await systemPrisma.dumpReason.create({
      data: { companyId: companyB.companyId, name: 'Foreign Reason', sortOrder: 0 },
    });

    await expect(
      inquiryService.update(
        companyA.companyId,
        inquiry.id,
        { status: 'DUMPED', dumpReasonId: foreignReason.id, dumpRemarks: 'Should not work' },
        { visibleUserIds: null },
        companyA.userId,
      ),
    ).rejects.toThrow(/dump reason not found/i);
  });

  it('dumps successfully with reason+remarks, and writes a queryable disposition history row', async () => {
    const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
    const inquiry = await inquiryService.create(companyA.companyId, { applicantId }, companyA.userId);

    await inquiryService.update(
      companyA.companyId,
      inquiry.id,
      { status: 'DUMPED', dumpReasonId, dumpRemarks: 'Budget too low for any available unit' },
      { visibleUserIds: null },
      companyA.userId,
    );

    const updated = await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } });
    expect(updated.status).toBe('DUMPED');

    const history = await systemPrisma.inquiryDispositionHistory.findMany({
      where: { inquiryId: inquiry.id },
      orderBy: { changedAt: 'asc' },
    });
    // Row 0: the initial null -> OPEN write at creation. Row 1: OPEN -> DUMPED.
    expect(history).toHaveLength(2);
    expect(history[0].fromStatus).toBeNull();
    expect(history[0].toStatus).toBe('OPEN');
    expect(history[0].reasonId).toBeNull();
    expect(history[1].fromStatus).toBe('OPEN');
    expect(history[1].toStatus).toBe('DUMPED');
    expect(history[1].reasonId).toBe(dumpReasonId);
    expect(history[1].remarks).toBe('Budget too low for any available unit');
    expect(history[1].changedById).toBe(companyA.userId);
  });

  it('writes a disposition history row for every status transition, not just Dump', async () => {
    const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
    const inquiry = await inquiryService.create(companyA.companyId, { applicantId }, companyA.userId);

    await inquiryService.update(companyA.companyId, inquiry.id, { status: 'CONTINUED' }, { visibleUserIds: null }, companyA.userId);
    await inquiryService.update(companyA.companyId, inquiry.id, { status: 'SUCCESSFUL' }, { visibleUserIds: null }, companyA.userId);

    const history = await systemPrisma.inquiryDispositionHistory.findMany({
      where: { inquiryId: inquiry.id },
      orderBy: { changedAt: 'asc' },
    });
    expect(history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['OPEN', 'CONTINUED', 'SUCCESSFUL']);
    // Successful/Followups transitions carry no reason/remarks — those
    // are Dump-specific, not generic disposition-history requirements.
    expect(history[2].reasonId).toBeNull();
    expect(history[2].remarks).toBeNull();
  });

  it('a no-op save that does not change status writes no new history row', async () => {
    const applicantId = await makeApplicant(systemPrisma, companyA.companyId);
    const inquiry = await inquiryService.create(companyA.companyId, { applicantId }, companyA.userId);

    await inquiryService.update(companyA.companyId, inquiry.id, { budgetMinPaise: 1_000_00n }, { visibleUserIds: null }, companyA.userId);

    const history = await systemPrisma.inquiryDispositionHistory.findMany({ where: { inquiryId: inquiry.id } });
    expect(history).toHaveLength(1); // just the initial creation row
  });

  it('company B cannot see company A\'s dump_reasons or inquiry_disposition_history, even via a raw filter-less query', async () => {
    async function countAs(companyId: string, sql: string): Promise<number> {
      return runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, async (tx: any) => {
          const rows = await (tx as { $queryRawUnsafe: (q: string) => Promise<Array<{ n: bigint }>> }).$queryRawUnsafe(sql);
          return Number(rows[0].n);
        }),
      );
    }

    const ownReasons = await countAs(companyA.companyId, `SELECT count(*)::bigint AS n FROM dump_reasons WHERE name = 'Budget mismatch'`);
    expect(ownReasons).toBe(1);
    const otherReasons = await countAs(companyB.companyId, `SELECT count(*)::bigint AS n FROM dump_reasons WHERE name = 'Budget mismatch'`);
    expect(otherReasons).toBe(0);
  });
});
