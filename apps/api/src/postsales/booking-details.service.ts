import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenantTx, runWithTenant, getCurrentIpAddress } from '@openestate/db';
import { TENANT_PRISMA } from '../database/database.module';
import { assertOwnedByCompany } from '../common/tenant-ownership';

/** Bookings that can no longer be edited. */
const CLOSED = new Set(['CANCELLED', 'SURRENDERED', 'TRANSFERRED_OUT']);

interface Actor {
  companyId: string;
  sub: string;
}

/**
 * Non-financial booking edits (v0.10.1, Plan D): the remark and the
 * co-applicants. Nothing here changes an amount, a ledger row, the unit or the
 * status. Each call locks the booking row, checks it is in the caller's scope
 * (404 otherwise) and still open (409 on a cancelled, surrendered or
 * transferred-out booking). Co-applicant changes write a COAPP_* audit row
 * naming both applicants: adding one gives that person's portal account read
 * access to the booking, so the API requires confirmPortalAccess.
 */
@Injectable()
export class BookingDetailsService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async editable(tx: any, companyId: string, bookingId: string, visibleCreators: string[] | null) {
    // Raw SQL: a row lock has no Prisma API; both ids are bound parameters.
    await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { id: bookingId, companyId };
    if (visibleCreators) where.createdById = { in: visibleCreators };
    const booking = await tx.booking.findFirst({ where, select: { id: true, status: true, primaryApplicantId: true } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (CLOSED.has(booking.status)) throw new ConflictException(`Booking is ${booking.status}; it can no longer be edited`);
    return booking;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private audit(tx: any, actor: Actor, bookingId: string, action: string, after: Record<string, unknown>) {
    return tx.auditLog.create({
      data: { companyId: actor.companyId, userId: actor.sub, entityType: 'Booking', entityId: bookingId, action, after, ipAddress: getCurrentIpAddress() ?? null },
    });
  }

  private run<T>(companyId: string, fn: (tx: unknown) => Promise<T>): Promise<T> {
    return runWithTenant({ companyId }, () => withTenantTx(this.tenantPrisma, companyId, fn));
  }

  async setRemark(actor: Actor, bookingId: string, remark: string | null, visible: string[] | null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.run(actor.companyId, async (tx: any) => {
      await this.editable(tx, actor.companyId, bookingId, visible);
      // An UPDATE row with the previous and new remark is written by the audit extension.
      await tx.booking.update({ where: { id: bookingId }, data: { remark: remark && remark.trim() ? remark.trim() : null } });
      return { id: bookingId, remark: remark && remark.trim() ? remark.trim() : null };
    });
  }

  async addCoApplicant(actor: Actor, bookingId: string, applicantId: string, visible: string[] | null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.run(actor.companyId, async (tx: any) => {
      const booking = await this.editable(tx, actor.companyId, bookingId, visible);
      await assertOwnedByCompany(tx, actor.companyId, [['applicant', applicantId, 'Applicant']]);
      if (applicantId === booking.primaryApplicantId) throw new ConflictException('This person is already the primary applicant');
      const rows: Array<{ applicantId: string; ordinal: number }> = await tx.bookingCoApplicant.findMany({ where: { bookingId }, select: { applicantId: true, ordinal: true } });
      if (rows.some((r) => r.applicantId === applicantId)) throw new ConflictException('This person is already a co-applicant');
      const ordinal = rows.reduce((m, r) => Math.max(m, r.ordinal), 1) + 1;
      await tx.bookingCoApplicant.create({ data: { companyId: actor.companyId, bookingId, applicantId, ordinal } });
      await this.audit(tx, actor, bookingId, 'COAPP_ADDED', { applicantId, primaryApplicantId: booking.primaryApplicantId, ordinal, portalAccessConfirmed: true });
      return { bookingId, applicantId, ordinal };
    });
  }

  async removeCoApplicant(actor: Actor, bookingId: string, applicantId: string, visible: string[] | null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.run(actor.companyId, async (tx: any) => {
      const booking = await this.editable(tx, actor.companyId, bookingId, visible);
      const row = await tx.bookingCoApplicant.findFirst({ where: { bookingId, applicantId } });
      if (!row) throw new NotFoundException('Not a co-applicant on this booking');
      await tx.bookingCoApplicant.delete({ where: { id: row.id } });
      const rest: Array<{ id: string }> = await tx.bookingCoApplicant.findMany({ where: { bookingId }, orderBy: { ordinal: 'asc' }, select: { id: true } });
      for (let i = 0; i < rest.length; i++) await tx.bookingCoApplicant.update({ where: { id: rest[i].id }, data: { ordinal: i + 2 } });
      await this.audit(tx, actor, bookingId, 'COAPP_REMOVED', { applicantId, primaryApplicantId: booking.primaryApplicantId });
      return { bookingId, applicantId, removed: true };
    });
  }

  async reorderCoApplicants(actor: Actor, bookingId: string, applicantIds: string[], visible: string[] | null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.run(actor.companyId, async (tx: any) => {
      await this.editable(tx, actor.companyId, bookingId, visible);
      const rows: Array<{ id: string; applicantId: string }> = await tx.bookingCoApplicant.findMany({ where: { bookingId }, select: { id: true, applicantId: true } });
      const current = new Set(rows.map((r) => r.applicantId));
      if (applicantIds.length !== rows.length || new Set(applicantIds).size !== applicantIds.length || !applicantIds.every((id) => current.has(id))) {
        throw new BadRequestException('List every co-applicant of this booking exactly once');
      }
      const byApplicant = new Map(rows.map((r) => [r.applicantId, r.id]));
      for (let i = 0; i < applicantIds.length; i++) {
        await tx.bookingCoApplicant.update({ where: { id: byApplicant.get(applicantIds[i]) }, data: { ordinal: i + 2 } });
      }
      await this.audit(tx, actor, bookingId, 'COAPP_REORDERED', { applicantIds });
      return { bookingId, applicantIds };
    });
  }
}
