/**
 * Follow-Up Page spec's Successful -> Booking gap (item 3,
 * internal plan followup-spec-gap-analysis.md): InquiryService.attachBooking
 * links a real Booking back to its source inquiry (Booking.sourceInquiryId),
 * flipping the inquiry to SUCCESSFUL in the same transaction — the SOP says
 * Successful MEANS a confirmed booking, the booking causes the disposition,
 * not the reverse, so this deliberately does NOT require the inquiry to
 * already be SUCCESSFUL.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runWithTenant, withTenantTx } from '@openestate/db';
import { SYSTEM_CLOCK } from '@openestate/shared';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';
import { InquiryService } from '../src/presales/inquiry.service';
import { AssignmentService } from '../src/presales/assignment.service';
import { CustomFieldsService } from '../src/custom-fields/custom-fields.service';
import { LeadStageTransitionService } from '../src/presales/lead-stage-transition.service';
import { InquiryDispositionTransitionService } from '../src/presales/inquiry-disposition-transition.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;

describeIf('Booking.sourceInquiryId (Successful -> Booking)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let inquiryService: InquiryService;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    inquiryService = new InquiryService(
      tenantPrisma,
      systemPrisma,
      SYSTEM_CLOCK,
      new AssignmentService(tenantPrisma),
      undefined as never,
      new CustomFieldsService(tenantPrisma, systemPrisma),
      new LeadStageTransitionService(),
      new InquiryDispositionTransitionService(),
    );
    fx = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function makeBooking(applicantId: string) {
    const unitId = await makeUnit(systemPrisma, fx);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(50_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    return booking.id;
  }

  it('links a booking to an OPEN inquiry, flips it to SUCCESSFUL, stamps convertedAt, and writes a disposition-history row naming the booking', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const inquiry = await inquiryService.create(fx.companyId, { applicantId }, fx.userId);
    expect(inquiry.status).toBe('OPEN');
    const bookingId = await makeBooking(applicantId);

    const updated = await inquiryService.attachBooking(fx.companyId, inquiry.id, bookingId, fx.userId);
    expect(updated.sourceInquiryId).toBe(inquiry.id);

    const refreshed = await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } });
    expect(refreshed.status).toBe('SUCCESSFUL');
    expect(refreshed.convertedAt).not.toBeNull();

    const history = await systemPrisma.inquiryDispositionHistory.findMany({
      where: { inquiryId: inquiry.id },
      orderBy: { changedAt: 'asc' },
    });
    expect(history).toHaveLength(2); // creation (null -> OPEN) + this transition
    expect(history[1].fromStatus).toBe('OPEN');
    expect(history[1].toStatus).toBe('SUCCESSFUL');
    expect(history[1].reasonId).toBeNull();
    expect(history[1].remarks).toMatch(/Linked to booking/);
    expect(history[1].changedById).toBe(fx.userId);
  });

  it('refuses to link a booking to a DUMPED inquiry, with a clear message, and leaves everything untouched', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const inquiry = await inquiryService.create(fx.companyId, { applicantId }, fx.userId);
    const dumpReason = await systemPrisma.dumpReason.create({
      data: { companyId: fx.companyId, name: 'Attach Test Dump Reason', sortOrder: 0 },
    });
    await inquiryService.update(
      fx.companyId,
      inquiry.id,
      { status: 'DUMPED', dumpReasonId: dumpReason.id, dumpRemarks: 'Went cold' },
      { visibleUserIds: null },
      fx.userId,
    );
    const bookingId = await makeBooking(applicantId);

    await expect(inquiryService.attachBooking(fx.companyId, inquiry.id, bookingId, fx.userId)).rejects.toThrow(
      /dumped lead/i,
    );

    const booking = await systemPrisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking.sourceInquiryId).toBeNull();
  });

  it('rejects attaching a second booking to an inquiry already linked to one (double-attach)', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const inquiry = await inquiryService.create(fx.companyId, { applicantId }, fx.userId);
    const firstBookingId = await makeBooking(applicantId);
    await inquiryService.attachBooking(fx.companyId, inquiry.id, firstBookingId, fx.userId);

    const secondBookingId = await makeBooking(applicantId);
    await expect(
      inquiryService.attachBooking(fx.companyId, inquiry.id, secondBookingId, fx.userId),
    ).rejects.toThrow(/already linked/i);

    const second = await systemPrisma.booking.findUnique({ where: { id: secondBookingId } });
    expect(second.sourceInquiryId).toBeNull();
  });

  it('rejects attaching a booking that already has a different source inquiry', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const firstInquiry = await inquiryService.create(fx.companyId, { applicantId }, fx.userId);
    const bookingId = await makeBooking(applicantId);
    await inquiryService.attachBooking(fx.companyId, firstInquiry.id, bookingId, fx.userId);

    const secondInquiry = await inquiryService.create(fx.companyId, { applicantId }, fx.userId);
    await expect(
      inquiryService.attachBooking(fx.companyId, secondInquiry.id, bookingId, fx.userId),
    ).rejects.toThrow(/already linked/i);
  });

  it('retroactively linking an already-SUCCESSFUL inquiry sets the booking link but does not re-stamp convertedAt or write a duplicate history row', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const inquiry = await inquiryService.create(fx.companyId, { applicantId }, fx.userId);
    const successful = await inquiryService.update(
      fx.companyId,
      inquiry.id,
      { status: 'SUCCESSFUL' },
      { visibleUserIds: null },
      fx.userId,
    );
    const originalConvertedAt = successful.convertedAt;
    expect(originalConvertedAt).not.toBeNull();

    const bookingId = await makeBooking(applicantId);
    await inquiryService.attachBooking(fx.companyId, inquiry.id, bookingId, fx.userId);

    const refreshed = await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } });
    expect(refreshed.convertedAt?.toISOString()).toBe(originalConvertedAt.toISOString());

    const history = await systemPrisma.inquiryDispositionHistory.findMany({ where: { inquiryId: inquiry.id } });
    expect(history).toHaveLength(2); // creation + the manual SUCCESSFUL update only — attachBooking added none
    expect(history.some((h: { toStatus: string }) => h.toStatus === 'SUCCESSFUL')).toBe(true);

    const booking = await systemPrisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking.sourceInquiryId).toBe(inquiry.id);
  });

  describe('bookings_source_inquiry_id_key — the real enforcement, under real concurrency', () => {
    it('rejects a second concurrent booking.update() linking the same inquiry, at the DB layer, bypassing the service check entirely', async () => {
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const inquiry = await inquiryService.create(fx.companyId, { applicantId }, fx.userId);
      const bookingAId = await makeBooking(applicantId);
      const bookingBId = await makeBooking(applicantId);

      // Deliberately raw tx.booking.update() calls, not
      // InquiryService.attachBooking() — the point of this test is
      // proving the INDEX is what's authoritative, not the service's own
      // proactive check (covered separately above).
      const results = await Promise.allSettled([
        runWithTenant({ companyId: fx.companyId }, () =>
          withTenantTx(tenantPrisma, fx.companyId, (tx) =>
            tx.booking.update({ where: { id: bookingAId }, data: { sourceInquiryId: inquiry.id } }),
          ),
        ),
        runWithTenant({ companyId: fx.companyId }, () =>
          withTenantTx(tenantPrisma, fx.companyId, (tx) =>
            tx.booking.update({ where: { id: bookingBId }, data: { sourceInquiryId: inquiry.id } }),
          ),
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const linked = await systemPrisma.booking.count({
        where: { companyId: fx.companyId, sourceInquiryId: inquiry.id },
      });
      expect(linked).toBe(1);
    });

    it('allows unlimited bookings with a NULL sourceInquiryId — the index is partial, not a plain unique column', async () => {
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      await makeBooking(applicantId);
      await makeBooking(applicantId);
      const count = await systemPrisma.booking.count({
        where: { companyId: fx.companyId, sourceInquiryId: null },
      });
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });
});
