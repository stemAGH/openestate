import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { CHANGE_REQUEST_STATUS, maskPhoneFields, type SubmitChangeRequestDto } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';

interface FieldChange {
  from: unknown;
  to: unknown;
}

/**
 * NOTHING here ever writes to Applicant from a portal-authenticated call —
 * submit() only ever creates an ApplicantChangeRequest row. The field
 * whitelist is enforced entirely by submitChangeRequestSchema's .strict()
 * shape at the controller boundary (see @openestate/shared/portal.ts); this
 * service never re-checks field names against a list, because a second,
 * separately-maintained whitelist here would be exactly the kind of drift
 * risk .strict() exists to avoid — the DTO type IS the whitelist.
 */
@Injectable()
export class ApplicantChangeRequestService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  /**
   * Portal-only — deliberately does NOT self-wrap runWithTenant like
   * approve()/reject() below. This must run inside the ambient portal
   * scope TenantContextInterceptor already established for the request; a
   * fresh runWithTenant({companyId}) here would silently strip that scope
   * for everything nested inside it, moving this call onto RLS's
   * staff-passthrough branch instead of the customer's own scope.
   */
  async submit(companyId: string, applicantId: string, requestedById: string, dto: SubmitChangeRequestDto) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const applicant = await tx.applicant.findFirst({ where: { id: applicantId } });
      if (!applicant) throw new NotFoundException('Applicant not found');

      const fieldChanges: Record<string, FieldChange> = {};
      if (dto.alternatePhones !== undefined) {
        fieldChanges.alternatePhones = { from: applicant.alternatePhones, to: dto.alternatePhones };
      }
      if (dto.email !== undefined) {
        fieldChanges.email = { from: applicant.email, to: dto.email };
      }

      return tx.applicantChangeRequest.create({
        data: {
          companyId,
          applicantId,
          requestedById,
          fieldChanges: fieldChanges as unknown as Prisma.InputJsonValue,
          status: CHANGE_REQUEST_STATUS.PENDING,
        },
      });
    });
  }

  /** Staff queue. Uses the system client — this is a staff-only surface, no portal scope involved. */
  async listPending(companyId: string) {
    // A list view: requested phone changes (from/to) are masked.
    return maskPhoneFields(
      await this.systemPrisma.applicantChangeRequest.findMany({
        where: { companyId, status: CHANGE_REQUEST_STATUS.PENDING },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /**
   * TOCTOU-safe: re-validates every field's CURRENT value against the
   * snapshot taken at submission time, inside the SAME transaction as the
   * eventual update — if anything drifted (e.g. staff edited the applicant
   * directly between submission and approval), the whole approval is
   * rejected with a 409 whose body echoes submittedAt, and NOTHING is
   * applied (all-or-nothing across every field in the request).
   *
   * Staff-only, so — unlike submit() above — self-wraps runWithTenant,
   * matching the established convention for staff-facing services
   * (e.g. ApplicantService.update()): safe here because no portal role
   * can ever reach this method (ADMIN_CHANGE_REQUEST_APPROVE only), so
   * there is no ambient portal scope that could be accidentally stripped.
   */
  async approve(companyId: string, id: string, reviewerId: string) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const request = await tx.applicantChangeRequest.findFirst({ where: { id } });
        if (!request) throw new NotFoundException('Change request not found');
        if (request.status !== CHANGE_REQUEST_STATUS.PENDING) {
          throw new BadRequestException('Change request has already been reviewed');
        }

        const applicant = await tx.applicant.findFirst({ where: { id: request.applicantId } });
        if (!applicant) throw new NotFoundException('Applicant not found');

        const fieldChanges = request.fieldChanges as unknown as Record<string, FieldChange>;
        const updateData: Record<string, unknown> = {};

        for (const [field, change] of Object.entries(fieldChanges)) {
          const currentValue = (applicant as Record<string, unknown>)[field];
          if (JSON.stringify(currentValue) !== JSON.stringify(change.from)) {
            throw new ConflictException({
              message: `Field "${field}" has changed since this request was submitted — ask the customer to resubmit`,
              submittedAt: request.createdAt,
            });
          }
          updateData[field] = change.to;
        }

        await tx.applicant.update({ where: { id: request.applicantId }, data: updateData });

        return tx.applicantChangeRequest.update({
          where: { id },
          data: { status: CHANGE_REQUEST_STATUS.APPROVED, reviewedById: reviewerId, reviewedAt: new Date() },
        });
      }),
    );
  }

  /** Staff-only — same self-wrap reasoning as approve() above. */
  async reject(companyId: string, id: string, reviewerId: string, reviewNote: string) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const request = await tx.applicantChangeRequest.findFirst({ where: { id } });
        if (!request) throw new NotFoundException('Change request not found');
        if (request.status !== CHANGE_REQUEST_STATUS.PENDING) {
          throw new BadRequestException('Change request has already been reviewed');
        }

        return tx.applicantChangeRequest.update({
          where: { id },
          data: {
            status: CHANGE_REQUEST_STATUS.REJECTED,
            reviewedById: reviewerId,
            reviewedAt: new Date(),
            reviewNote,
          },
        });
      }),
    );
  }
}
