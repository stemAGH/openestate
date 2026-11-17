import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant, getCurrentIpAddress } from '@openestate/db';
import { assertOwnedByCompany } from '../common/tenant-ownership';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import {
  normalizePhone,
  normalizeEmail,
  maskPhone,
  maskPhoneFields,
  isFollowUpOverdue,
  istDayBounds,
  ACTIVE_INQUIRY_STATUSES,
  PERMISSIONS,
  redactAadhaarLike,
  maskPhonesInText,
  formatInr,
  type Clock,
} from '@openestate/shared';
import type {
  DeleteLeadDto,
  CreateInquiryDto,
  UpdateInquiryDto,
  InquiryListQuery,
} from '@openestate/shared';
import { CLOCK } from '../common/clock.provider';
import { AssignmentService } from './assignment.service';
import { ApplicantService } from './applicant.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { LeadStageTransitionService } from './lead-stage-transition.service';
import { InquiryDispositionTransitionService } from './inquiry-disposition-transition.service';

export interface InquiryScope {
  /**
   * `null` = no restriction (admin-tier caller, sees the whole company).
   * A finite array = restrict to inquiries assigned to one of these user
   * ids — the caller's own id plus their full reporting subtree, from
   * `TeamScopeService.getVisibleUserIds`. Never construct this by hand;
   * every non-TeamScopeService assignment here is caught by
   * team-scope-guard.test.ts.
   */
  visibleUserIds: string[] | null;
}

export interface LeadInput {
  name: string;
  phone: string;
  email?: string;
  projectId?: string;
  note?: string;
}

export interface LeadCreateResult {
  inquiryId: string;
  applicantId: string;
  duplicateApplicantIds: string[];
}

/** The ids an inquiry write may name; each must be the caller's company's own. */
function inquiryRefs(dto: { projectId?: string | null; sourceId?: string | null; inquiryTypeId?: string | null; temperatureId?: string | null; preferredUnitTypeId?: string | null }) {
  return [
    ['project', dto.projectId, 'Project'],
    ['inquirySource', dto.sourceId, 'Source'],
    ['inquiryType', dto.inquiryTypeId, 'Inquiry type'],
    ['inquiryTemperature', dto.temperatureId, 'Temperature'],
    ['unitType', dto.preferredUnitTypeId, 'Preferred unit type'],
  ] as Array<[string, string | null | undefined, string]>;
}

@Injectable()
export class InquiryService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly assignmentService: AssignmentService,
    private readonly applicantService: ApplicantService,
    private readonly customFields: CustomFieldsService,
    private readonly leadStageTransition: LeadStageTransitionService,
    private readonly dispositionTransition: InquiryDispositionTransitionService,
  ) {}

  async findAll(companyId: string, query: InquiryListQuery, scope: InquiryScope) {
    const { page, limit, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // Every condition is ANDed, so a filter can only narrow the team scope.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const and: any[] = [];
    if (scope.visibleUserIds) and.push({ assignedToId: { in: scope.visibleUserIds } });
    if (query.assignedToId) and.push({ assignedToId: query.assignedToId });
    if (query.status) and.push({ status: { in: query.status } });
    if (query.temperatureId) and.push({ temperatureId: query.temperatureId });
    if (query.projectId) and.push({ projectId: query.projectId });
    if (query.followUp) {
      const { startOfToday, endOfToday } = istDayBounds(this.clock.now());
      and.push({
        status: { in: [...ACTIVE_INQUIRY_STATUSES] },
        nextFollowupAt: query.followUp === 'today' ? { gte: startOfToday, lte: endOfToday } : { lt: startOfToday },
      });
    }
    if (query.search) {
      const text = { contains: query.search, mode: 'insensitive' as const };
      // Phone digits: "+91 98765 43210" finds the stored 9876543210.
      const digits = normalizePhone(query.search).replace(/\D/g, '');
      and.push({
        applicant: {
          OR: [
            { name: text },
            { email: text },
            { primaryPhone: text },
            ...(digits.length >= 4 ? [{ primaryPhoneNormalized: { contains: digits } }] : []),
          ],
        },
      });
    }
    const where = { companyId, AND: and };

    const [data, total] = await Promise.all([
      this.systemPrisma.inquiry.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { createdAt: 'desc' },
        include: {
          applicant: { omit: { panCiphertext: true, panKeyVersion: true } },
          project: true,
          temperature: true,
          // Real leak, found while wiring follow-up attribution display:
          // a bare `assignedTo: true` returns every scalar column on
          // User, passwordHash/totpSecret/recoveryCodes included, over
          // the wire on every inquiry list response.
          assignedTo: { select: { id: true, name: true, email: true } },
        },
      }),
      this.systemPrisma.inquiry.count({ where }),
    ]);

    return {
      // A list view: phone numbers show the last 4 digits only (CLAUDE.md).
      // The detail endpoint (findOne) keeps the full number.
      data: maskPhoneFields(data),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(companyId: string, id: string, scope: InquiryScope) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { id, companyId };
    if (scope.visibleUserIds) where.assignedToId = { in: scope.visibleUserIds };

    const item = await this.systemPrisma.inquiry.findFirst({
      where,
      include: {
        applicant: { omit: { panCiphertext: true, panKeyVersion: true } },
        project: true,
        source: true,
        inquiryType: true,
        preferredUnitType: true,
        temperature: true,
        assignedTo: { select: { id: true, name: true, email: true } },
        followUps: { orderBy: { createdAt: 'desc' } },
        assignments: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!item) throw new NotFoundException('Inquiry not found');
    return item;
  }

  /**
   * Lightweight existence+scope check, no `include`s — for callers (like
   * `FollowUpService`) that only need to know "is this inquiry visible to
   * this caller," not the full inquiry payload. Throws the same
   * `NotFoundException` `findOne` does when the inquiry exists but is out
   * of scope, for the same IDOR-hiding reason.
   */
  async assertInScope(companyId: string, id: string, scope: InquiryScope): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { id, companyId };
    if (scope.visibleUserIds) where.assignedToId = { in: scope.visibleUserIds };
    const exists = await this.systemPrisma.inquiry.findFirst({ where, select: { id: true } });
    if (!exists) throw new NotFoundException('Inquiry not found');
  }

  /**
   * QA-003: who this caller may assign the lead to: active users in the
   * caller's team scope whose role can open leads (presales.inquiry.read).
   * assign() refuses anyone else. 404 for a lead outside the caller's scope.
   */
  async assignableUsers(companyId: string, inquiryId: string, scope: InquiryScope) {
    await this.assertInScope(companyId, inquiryId, scope);
    return this.systemPrisma.user.findMany({
      where: {
        companyId,
        isActive: true,
        ...(scope.visibleUserIds ? { id: { in: scope.visibleUserIds } } : {}),
        role: { isPortal: false, permissions: { some: { permission: { key: PERMISSIONS.PRESALES_INQUIRY_READ } } } },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Delete a lead (soft): hidden from every read (packages/db soft-delete
   * extension) until restored, purged after the company's retention period.
   * Within the caller's team scope (404 outside it, as for reading). Refused
   * for a lead a booking came from (any booking status) or a SUCCESSFUL one.
   * The lead's row is locked first; attachBooking takes the same lock, so a
   * booking can't be linked to it at the same moment. The applicant is
   * never deleted. Audited as LEAD_DELETED, with no phone number.
   */
  async softDelete(companyId: string, id: string, dto: DeleteLeadDto, scope: InquiryScope, actorId: string) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        // Raw SQL: a row lock has no Prisma API; both ids are bound parameters.
        await tx.$queryRaw`SELECT id FROM inquiries WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const where: any = { id, companyId };
        if (scope.visibleUserIds) where.assignedToId = { in: scope.visibleUserIds };
        const inquiry = await tx.inquiry.findFirst({ where, select: { id: true, status: true, applicantId: true } });
        if (!inquiry) throw new NotFoundException('Inquiry not found');

        const booking = await tx.booking.findFirst({ where: { companyId, sourceInquiryId: id }, select: { bookingNumber: true } });
        if (booking || inquiry.status === 'SUCCESSFUL') {
          throw new ConflictException(
            `This lead converted to a booking${booking ? ` (${booking.bookingNumber})` : ''} and can't be deleted`,
          );
        }

        const followUps = await tx.followUp.count({ where: { companyId, inquiryId: id } });
        const note = dto.note ? maskPhonesInText(dto.note) : null;
        const deletedAt = this.clock.now();
        await tx.inquiry.update({
          where: { id },
          data: { deletedAt, deletedById: actorId, deleteReason: dto.reason, deleteNote: note },
        });
        await tx.auditLog.create({
          data: {
            companyId,
            userId: actorId,
            entityType: 'Inquiry',
            entityId: id,
            action: 'LEAD_DELETED',
            after: { reason: dto.reason, note, applicantId: inquiry.applicantId, followUps },
            ipAddress: getCurrentIpAddress() ?? null,
          },
        });
        return { id, deletedAt };
      }),
    );
  }

  /** Bring a deleted lead back (within the caller's team scope), before it is purged. */
  async restore(companyId: string, id: string, scope: InquiryScope, actorId: string) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await tx.$queryRaw`SELECT id FROM inquiries WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const where: any = { id, companyId, deletedAt: { not: null } };
        if (scope.visibleUserIds) where.assignedToId = { in: scope.visibleUserIds };
        const inquiry = await tx.inquiry.findFirst({ where, select: { id: true, applicantId: true, deleteReason: true } });
        if (!inquiry) throw new NotFoundException('Deleted lead not found');
        await tx.inquiry.update({
          where: { id, deletedAt: { not: null } },
          data: { deletedAt: null, deletedById: null, deleteReason: null, deleteNote: null },
        });
        await tx.auditLog.create({
          data: {
            companyId,
            userId: actorId,
            entityType: 'Inquiry',
            entityId: id,
            action: 'LEAD_RESTORED',
            after: { previousReason: inquiry.deleteReason, applicantId: inquiry.applicantId },
            ipAddress: getCurrentIpAddress() ?? null,
          },
        });
        return { id, restored: true };
      }),
    );
  }

  /** Deleted leads in the caller's team scope, newest first, with the date each will be purged. */
  async findDeleted(companyId: string, query: { page: number; limit: number }, scope: InquiryScope) {
    const { page, limit } = query;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId, deletedAt: { not: null } };
    if (scope.visibleUserIds) where.assignedToId = { in: scope.visibleUserIds };
    const [rows, total, config] = await Promise.all([
      this.systemPrisma.inquiry.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { deletedAt: 'desc' },
        select: {
          id: true,
          status: true,
          deletedAt: true,
          deleteReason: true,
          deleteNote: true,
          applicant: { select: { id: true, name: true, primaryPhone: true } },
          project: { select: { id: true, name: true } },
          deletedBy: { select: { id: true, name: true } },
        },
      }),
      this.systemPrisma.inquiry.count({ where }),
      this.systemPrisma.companyConfig.findUnique({ where: { companyId }, select: { leadPurgeAfterDays: true } }),
    ]);
    const days = config?.leadPurgeAfterDays ?? 30;
    const data = rows.map((r) => ({ ...r, purgeAfter: new Date(r.deletedAt!.getTime() + days * 86_400_000) }));
    return { data: maskPhoneFields(data), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * The daily purge: removes this company's leads deleted longer ago than its
   * leadPurgeAfterDays, with their follow-ups, assignments and history
   * (ON DELETE CASCADE). Applicants and communication logs stay (the log's
   * inquiry link becomes null). One LEADS_PURGED audit row per run that
   * removes anything (ids and a count only).
   */
  async purgeDeleted(companyId: string): Promise<{ purged: number }> {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const config = await tx.companyConfig.findFirst({ where: { companyId }, select: { leadPurgeAfterDays: true } });
        const days = config?.leadPurgeAfterDays ?? 30;
        const cutoff = new Date(this.clock.now().getTime() - days * 86_400_000);
        const due = await tx.inquiry.findMany({ where: { companyId, deletedAt: { not: null, lt: cutoff } }, select: { id: true } });
        if (due.length === 0) return { purged: 0 };
        const ids = due.map((r: { id: string }) => r.id);
        const res = await tx.inquiry.deleteMany({ where: { companyId, id: { in: ids }, deletedAt: { not: null, lt: cutoff } } });
        await tx.auditLog.create({
          data: {
            companyId,
            userId: null,
            entityType: 'Inquiry',
            entityId: 'purge',
            action: 'LEADS_PURGED',
            after: { purged: res.count, inquiryIds: ids, retentionDays: days },
          },
        });
        return { purged: res.count };
      }),
    );
  }

  /** Assigned to me, still open, and today's-or-overdue next follow-up. */
  async myDay(companyId: string, userId: string) {
    // IST day, the same boundary as the dashboard tiles and the list filter.
    const { endOfToday } = istDayBounds(this.clock.now());

    // A list view: phone numbers masked, as in findAll.
    const rows = await this.systemPrisma.inquiry.findMany({
      where: {
        companyId,
        assignedToId: userId,
        status: { in: ['OPEN', 'CONTINUED'] },
        nextFollowupAt: { lte: endOfToday },
      },
      include: { applicant: { omit: { panCiphertext: true, panKeyVersion: true } }, project: true, temperature: true },
      orderBy: { nextFollowupAt: 'asc' },
    });
    return maskPhoneFields(rows);
  }

  /**
   * `createdById` is the interactively-authenticated caller (always set —
   * InquiryController.create() is behind JwtAuthGuard). Machine-driven
   * intake (createFromLead, bulk import) has no human creator and never
   * passes one, which is exactly the signal the creator-retains policy
   * below keys off.
   */
  async create(companyId: string, dto: CreateInquiryDto, createdById: string) {
    // Resolved BEFORE the transaction opens: validation reads the
    // definitions table, and there's no reason to hold a pooled
    // connection open across those reads.
    const inquiryCustomFields = await this.customFields.resolveValuesForWrite(
      companyId,
      'INQUIRY',
      dto.customFields,
    );
    const applicantCustomFields = dto.applicant
      ? await this.customFields.resolveValuesForWrite(
          companyId,
          'APPLICANT',
          dto.applicant.customFields,
        )
      : undefined;

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await assertOwnedByCompany(tx, companyId, inquiryRefs(dto));
        let applicantId = dto.applicantId;
        let possibleDuplicateApplicantIds: string[] = [];
        // Item 7: enriched alongside the existing id-only array (kept
        // unchanged for the plugin-sdk/existing-test contract) so
        // Inquiries.tsx's duplicate-warning banner can show a name/phone
        // per candidate instead of a bare count.
        let possibleDuplicates: Array<{ id: string; name: string; primaryPhone: string }> = [];

        if (!applicantId && dto.applicant) {
          const primaryPhoneNormalized = normalizePhone(dto.applicant.primaryPhone);
          const emailNormalized = dto.applicant.email
            ? normalizeEmail(dto.applicant.email)
            : null;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const or: any[] = [{ primaryPhoneNormalized }];
          if (emailNormalized) or.push({ emailNormalized });
          const duplicates = await tx.applicant.findMany({
            where: { companyId, mergedIntoId: null, OR: or },
          });
          possibleDuplicateApplicantIds = duplicates.map((d: { id: string }) => d.id);
          possibleDuplicates = duplicates.map(
            (d: { id: string; name: string; primaryPhone: string }) => ({
              id: d.id,
              name: d.name,
              // Other people's numbers: masked, like any list.
              primaryPhone: maskPhone(d.primaryPhone),
            }),
          );

          const created = await tx.applicant.create({
            data: {
              companyId,
              name: dto.applicant.name,
              primaryPhone: dto.applicant.primaryPhone.trim(),
              primaryPhoneNormalized,
              alternatePhones: dto.applicant.alternatePhones ?? [],
              email: dto.applicant.email,
              emailNormalized,
              addressLine1: dto.applicant.addressLine1,
              city: dto.applicant.city,
              state: dto.applicant.state,
              pincode: dto.applicant.pincode,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              customFields: applicantCustomFields as any,
            },
          });
          applicantId = created.id;
        } else if (applicantId) {
          const existing = await tx.applicant.findFirst({
            where: { id: applicantId, companyId },
          });
          if (!existing) throw new NotFoundException('Applicant not found');
          if (existing.mergedIntoId) {
            throw new ConflictException(
              `Applicant has been merged into ${existing.mergedIntoId}`,
            );
          }
        }

        const resolvedStageId = await this.leadStageTransition.resolveInitialStage(tx, companyId, dto.stageId);
        const inquiry = await tx.inquiry.create({
          data: {
            companyId,
            applicantId: applicantId as string,
            projectId: dto.projectId,
            sourceId: dto.sourceId,
            inquiryTypeId: dto.inquiryTypeId,
            budgetMinPaise: dto.budgetMinPaise,
            budgetMaxPaise: dto.budgetMaxPaise,
            preferredUnitTypeId: dto.preferredUnitTypeId,
            temperatureId: dto.temperatureId,
            stageId: resolvedStageId,
            nextFollowupAt: dto.nextFollowupAt,
            createdById,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            customFields: inquiryCustomFields as any,
          },
        });
        await this.leadStageTransition.writeStageTransition(tx, companyId, inquiry.id, null, resolvedStageId, createdById);
        await this.dispositionTransition.writeDispositionTransition(tx, companyId, inquiry.id, null, inquiry.status, createdById);

        // Creator-retains-lead policy (default on): a rep's own inquiry
        // must never silently move to someone else via round-robin.
        // Round-robin only ever runs for machine-driven intake — this
        // method always has a human createdById, so when the toggle is on
        // the creator simply keeps it, full stop, regardless of project
        // pool membership.
        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const creatorRetains = config?.presalesCreatorRetainsLead ?? true;

        let assignedToId: string | null = null;
        let assignmentType: 'creator' | 'auto' | null = null;
        if (creatorRetains) {
          assignedToId = createdById;
          assignmentType = 'creator';
        } else if (dto.projectId) {
          assignedToId = await this.assignmentService.autoAssign(
            tx,
            companyId,
            dto.projectId,
          );
          assignmentType = 'auto';
        }

        if (assignedToId) {
          await tx.inquiry.update({
            where: { id: inquiry.id },
            data: { assignedToId },
          });
          await tx.inquiryAssignment.create({
            data: {
              companyId,
              inquiryId: inquiry.id,
              toUserId: assignedToId,
              assignmentType: assignmentType as string,
              actorId: assignmentType === 'creator' ? createdById : null,
            },
          });
        }

        return { ...inquiry, assignedToId, possibleDuplicateApplicantIds, possibleDuplicates };
      }),
    );
  }

  /**
   * Machine-driven lead intake (inbound lead API, §5) — auto-links to an
   * existing applicant on a phone/email match instead of prompting a
   * human (there isn't one), same "never silently skip a possible
   * duplicate" discipline as the bulk-import path (Phase 3 decisions),
   * NOT the interactive create()'s "always create new + surface
   * possibleDuplicateApplicantIds for a human to resolve" behavior —
   * those are deliberately different flows for deliberately different
   * callers. What IS shared with every other dedup call site (create(),
   * ApplicantService.create(), the plugin runtime's ctx.applicants) is
   * the underlying duplicate lookup: ApplicantService.findDuplicates().
   * Returns the shape @openestate/plugin-sdk's LeadCreateResult already
   * committed to in Phase 7 commit 1.
   *
   * Item 7: CompanyConfig.presalesPhoneDedupAutoLink (default true) gates
   * whether a phone/email match auto-links here at all. Companies with
   * heavy phone sharing (a shared family/office number funnelling
   * distinct people through the same inbound channel) can flip it off —
   * every lead then always creates a NEW applicant, with
   * duplicateApplicantIds still populated so the caller/plugin can flag
   * it, matching the interactive create() flow's "always create + flag,
   * let a human decide" discipline instead of silently merging.
   */
  async createFromLead(companyId: string, lead: LeadInput): Promise<LeadCreateResult> {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await assertOwnedByCompany(tx, companyId, [['project', lead.projectId, 'Project']]);
        const primaryPhoneNormalized = normalizePhone(lead.phone);
        const emailNormalized = lead.email ? normalizeEmail(lead.email) : null;

        const duplicates = await this.applicantService.findDuplicates(companyId, primaryPhoneNormalized, emailNormalized);
        const duplicateApplicantIds = duplicates.map((d: { id: string }) => d.id);

        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const autoLink = config?.presalesPhoneDedupAutoLink ?? true;

        let applicantId: string;
        if (duplicates.length > 0 && autoLink) {
          applicantId = duplicates[0].id;
        } else {
          const created = await tx.applicant.create({
            data: {
              companyId,
              name: lead.name,
              primaryPhone: lead.phone.trim(),
              primaryPhoneNormalized,
              email: lead.email,
              emailNormalized,
            },
          });
          applicantId = created.id;
        }

        const resolvedStageId = await this.leadStageTransition.resolveInitialStage(tx, companyId, undefined);
        const inquiry = await tx.inquiry.create({
          data: {
            companyId,
            applicantId,
            projectId: lead.projectId,
            stageId: resolvedStageId,
            // Aadhaar guard: machine-written notes (the inbound lead API and
            // plugins' ctx.leads.create both land here) are REDACTED, never
            // rejected — there is no one to show an error to.
            customFields: lead.note ? { leadNote: redactAadhaarLike(lead.note) } : undefined,
          },
        });
        // No human actor for machine-driven intake — same reasoning as
        // this method's assignmentType: 'auto'/actorId: null below.
        await this.leadStageTransition.writeStageTransition(tx, companyId, inquiry.id, null, resolvedStageId, null);
        await this.dispositionTransition.writeDispositionTransition(tx, companyId, inquiry.id, null, inquiry.status, null);

        if (lead.projectId) {
          const assignedToId = await this.assignmentService.autoAssign(tx, companyId, lead.projectId);
          if (assignedToId) {
            await tx.inquiry.update({ where: { id: inquiry.id }, data: { assignedToId } });
            await tx.inquiryAssignment.create({
              data: { companyId, inquiryId: inquiry.id, toUserId: assignedToId, assignmentType: 'auto', actorId: null },
            });
          }
        }

        return { inquiryId: inquiry.id, applicantId, duplicateApplicantIds };
      }),
    );
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateInquiryDto,
    scope: InquiryScope,
    actorId: string,
  ) {
    const existing = await this.findOne(companyId, id, scope);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = { ...dto };
    // Not real Inquiry columns — they belong on the disposition-history
    // row only (InquiryDispositionHistory.reasonId/remarks), never on
    // Inquiry itself. Delete rather than pass through to tx.inquiry.update().
    delete data.dumpReasonId;
    delete data.dumpRemarks;

    const statusChanged = dto.status !== undefined && dto.status !== existing.status;

    // convertedAt is stamped on the TRANSITION into SUCCESSFUL, not on
    // every save of an already-successful inquiry — otherwise it would
    // drift exactly like updatedAt, which is the problem it exists to
    // solve. Cleared when the inquiry moves back out of SUCCESSFUL, so a
    // re-opened lead stops counting as a conversion. attachBooking()
    // below is the other code path that can set SUCCESSFUL (a real
    // booking causing the disposition, not the reverse) and follows the
    // identical stamp-only-on-transition discipline.
    if (statusChanged) {
      if (dto.status === 'SUCCESSFUL') {
        data.convertedAt = this.clock.now();
      } else if (existing.status === 'SUCCESSFUL') {
        data.convertedAt = null;
      }
      // SOP rule 5: Dump requires both a reason (from the configurable
      // DumpReason catalogue) and remarks — currently unenforced was the
      // whole finding. Checked here, not in the zod schema, since it's
      // conditional on the transition actually being INTO Dumped, which
      // depends on live state zod can't see (same shape as LeadStage's
      // default-deactivation guard).
      if (dto.status === 'DUMPED' && (!dto.dumpReasonId || !dto.dumpRemarks?.trim())) {
        throw new BadRequestException(
          'Dumping a lead requires both a reason and remarks — select a reason and explain why for future reference.',
        );
      }
    }
    // The budget range stays in order: whichever end isn't sent keeps its stored value.
    const stored = existing as { budgetMinPaise: bigint | null; budgetMaxPaise: bigint | null };
    const budgetMin = dto.budgetMinPaise ?? stored.budgetMinPaise;
    const budgetMax = dto.budgetMaxPaise ?? stored.budgetMaxPaise;
    if (budgetMin != null && budgetMax != null && budgetMax < budgetMin) {
      throw new BadRequestException(
        `Budget max (${formatInr(budgetMax)}) is below budget min (${formatInr(budgetMin)})`,
      );
    }
    if (dto.customFields !== undefined) {
      data.customFields = await this.customFields.resolveValuesForWrite(
        companyId,
        'INQUIRY',
        dto.customFields,
        (existing as { customFields?: Record<string, unknown> | null }).customFields ?? null,
      );
    }
    const existingStageId = (existing as { stageId: string | null }).stageId;
    const stageChanged = dto.stageId !== undefined && dto.stageId !== existingStageId;

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        // RLS filters reads, not a client-supplied FK on write — must be
        // checked before the update() call actually persists it, not
        // after. See LeadStageTransitionService.assertStageBelongsToCompany.
        if (stageChanged) {
          await this.leadStageTransition.assertStageBelongsToCompany(tx, companyId, dto.stageId!);
        }
        await assertOwnedByCompany(tx, companyId, inquiryRefs(dto));
        if (statusChanged && dto.status === 'DUMPED') {
          await this.dispositionTransition.assertReasonBelongsToCompany(tx, companyId, dto.dumpReasonId!);
        }
        const updated = await tx.inquiry.update({ where: { id }, data });
        if (stageChanged) {
          await this.leadStageTransition.writeStageTransition(
            tx,
            companyId,
            id,
            existingStageId,
            dto.stageId!,
            actorId,
          );
        }
        if (statusChanged) {
          await this.dispositionTransition.writeDispositionTransition(
            tx,
            companyId,
            id,
            existing.status,
            dto.status!,
            actorId,
            dto.status === 'DUMPED' ? dto.dumpReasonId : null,
            dto.status === 'DUMPED' ? dto.dumpRemarks : null,
          );
        }
        return updated;
      }),
    );
  }

  /**
   * Links a real Booking back to the inquiry it converted from
   * (Booking.sourceInquiryId — mirrors BrokerService.assignToBooking's
   * shape exactly: scalar FK, no relation, a separate call after the
   * booking already exists, BookingService itself never touched).
   *
   * Ordering is deliberate: the SOP says Successful MEANS a confirmed
   * booking — the booking causes the disposition, not the reverse — so
   * this does NOT require the inquiry to already be SUCCESSFUL. It
   * accepts any inquiry that isn't DUMPED (a dead lead doesn't get
   * revived by a booking link — reject that outright) and that doesn't
   * already have a booking attached (one lead converts to one booking;
   * bookings_source_inquiry_id_key is the actual, concurrency-safe
   * enforcement — the checks below exist only for a clean error message
   * before the DB round trip). The status flip to SUCCESSFUL and its
   * disposition-history row only fire when the inquiry wasn't already
   * SUCCESSFUL, so retroactively linking an old, already-successful lead
   * doesn't re-stamp convertedAt or write a no-op transition row.
   */
  async attachBooking(companyId: string, inquiryId: string, bookingId: string, actorId: string) {
    try {
      return await runWithTenant({ companyId }, () =>
        withTenantTx(this.tenantPrisma, companyId, async (tx) => {
          // The lead's row lock, as softDelete takes it: a lead being deleted
          // can't get a booking linked at the same moment (it is then "not found").
          // Raw SQL: a row lock has no Prisma API; both ids are bound parameters.
          await tx.$queryRaw`SELECT id FROM inquiries WHERE id = ${inquiryId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`;
          const inquiry = await tx.inquiry.findFirst({ where: { id: inquiryId, companyId } });
          if (!inquiry) throw new NotFoundException('Inquiry not found');
          const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
          if (!booking) throw new NotFoundException('Booking not found');

          if (inquiry.status === 'DUMPED') {
            throw new BadRequestException(
              'Cannot link a booking to a dumped lead — a dumped lead does not get revived by a booking link.',
            );
          }
          if (booking.sourceInquiryId) {
            throw new BadRequestException('This booking is already linked to a source inquiry.');
          }
          const alreadyLinked = await tx.booking.findFirst({
            where: { companyId, sourceInquiryId: inquiryId },
            select: { bookingNumber: true },
          });
          if (alreadyLinked) {
            throw new BadRequestException(
              `This inquiry is already linked to booking ${alreadyLinked.bookingNumber}.`,
            );
          }

          const updatedBooking = await tx.booking.update({
            where: { id: bookingId },
            data: { sourceInquiryId: inquiryId },
          });

          if (inquiry.status !== 'SUCCESSFUL') {
            await tx.inquiry.update({
              where: { id: inquiryId },
              data: { status: 'SUCCESSFUL', convertedAt: this.clock.now() },
            });
            await this.dispositionTransition.writeDispositionTransition(
              tx,
              companyId,
              inquiryId,
              inquiry.status,
              'SUCCESSFUL',
              actorId,
              null,
              `Linked to booking ${booking.bookingNumber}`,
            );
          }

          return updatedBooking;
        }),
      );
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
        throw new BadRequestException('This inquiry is already linked to a booking.');
      }
      throw err;
    }
  }

  /**
   * Both the inquiry being reassigned and the target user must be in the
   * caller's visible set — a manager can only move a lead within their
   * own subtree, never in from or out to someone they can't see. Admins
   * (`scope.visibleUserIds === null`) are unrestricted, same as every
   * other TeamScopeService-gated endpoint.
   */
  async assign(
    companyId: string,
    inquiryId: string,
    toUserId: string,
    actorId: string,
    reason: string | undefined,
    scope: InquiryScope,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const inquiryWhere: any = { id: inquiryId, companyId };
        if (scope.visibleUserIds) inquiryWhere.assignedToId = { in: scope.visibleUserIds };
        const inquiry = await tx.inquiry.findFirst({ where: inquiryWhere });
        if (!inquiry) throw new NotFoundException('Inquiry not found');

        if (scope.visibleUserIds && !scope.visibleUserIds.includes(toUserId)) {
          throw new NotFoundException('Target user not found');
        }
        const targetUser = await tx.user.findFirst({ where: { id: toUserId, companyId } });
        if (!targetUser) throw new NotFoundException('Target user not found');
        // QA-003: the same rule as assignableUsers(): active, and a role that can open leads.
        if (!targetUser.isActive) {
          throw new BadRequestException(`${targetUser.name} is deactivated, so the lead can't be assigned to them`);
        }
        const canOpenLeads = await tx.rolePermission.count({
          where: { roleId: targetUser.roleId, permission: { key: PERMISSIONS.PRESALES_INQUIRY_READ } },
        });
        if (!canOpenLeads) {
          throw new BadRequestException(`${targetUser.name} can't open leads (their role has no lead access), so the lead can't be assigned to them`);
        }

        const fromUserId = inquiry.assignedToId;
        await tx.inquiry.update({
          where: { id: inquiryId },
          data: { assignedToId: toUserId },
        });

        return tx.inquiryAssignment.create({
          data: {
            companyId,
            inquiryId,
            fromUserId,
            toUserId,
            assignmentType: 'manual',
            actorId,
            reason,
          },
        });
      }),
    );
  }

  isOverdue(nextFollowupAt: Date | null): boolean {
    return isFollowUpOverdue(nextFollowupAt, this.clock.now());
  }
}
