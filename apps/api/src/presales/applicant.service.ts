import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { normalizePhone, normalizeEmail, orderApplicantPair, maskPhone, maskPhoneFields } from '@openestate/shared';
import type {
  CreateApplicantDto,
  UpdateApplicantDto,
  PaginationQuery,
} from '@openestate/shared';
import { PanEncryptionService } from '../common/pan-encryption.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';

@Injectable()
export class ApplicantService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly panEncryption: PanEncryptionService,
    private readonly customFields: CustomFieldsService,
  ) {}

  async findAll(companyId: string, query: PaginationQuery) {
    const { page, limit, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId, mergedIntoId: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { primaryPhone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.systemPrisma.applicant.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { createdAt: 'desc' },
        // panMasked is the display value; the encrypted blob has no
        // legitimate reason to ever leave the server (nothing in this
        // service decrypts an Applicant's PAN — unlike Broker.revealPan
        // — so there's no internal caller depending on it being present
        // here either).
        omit: { panCiphertext: true, panKeyVersion: true },
      }),
      this.systemPrisma.applicant.count({ where }),
    ]);

    return {
      // A list view (also the booking wizard's and receipt entry's pickers):
      // phone numbers show the last 4 digits; findOne keeps the full number.
      data: maskPhoneFields(data),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(companyId: string, id: string) {
    const item = await this.systemPrisma.applicant.findFirst({
      where: { id, companyId },
      omit: { panCiphertext: true, panKeyVersion: true },
    });
    if (!item) throw new NotFoundException('Applicant not found');
    return item;
  }

  /**
   * Duplicate candidates by exact normalized phone/email match, excluding
   * tombstoned rows. `excludeConfirmedAgainstId`, when given, drops any
   * candidate that already has a confirmed-distinct decision recorded
   * against that applicant (ApplicantDistinctPair) — only meaningful for
   * an EXISTING applicant's re-check (findDuplicatesForApplicant); a
   * brand-new applicant being created has no id yet to check pairs
   * against, so create()/createFromLead() never pass this.
   */
  async findDuplicates(
    companyId: string,
    primaryPhoneNormalized: string,
    emailNormalized: string | null,
    excludeConfirmedAgainstId?: string,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const or: any[] = [{ primaryPhoneNormalized }];
    if (emailNormalized) or.push({ emailNormalized });

    const candidates = await this.systemPrisma.applicant.findMany({
      where: { companyId, mergedIntoId: null, OR: or },
    });

    if (!excludeConfirmedAgainstId || candidates.length === 0) return candidates;

    const confirmedPairs = await this.systemPrisma.applicantDistinctPair.findMany({
      where: {
        companyId,
        OR: candidates.map((c: { id: string }) => {
          const [applicantAId, applicantBId] = orderApplicantPair(excludeConfirmedAgainstId, c.id);
          return { applicantAId, applicantBId };
        }),
      },
      select: { applicantAId: true, applicantBId: true },
    });
    const confirmedOtherIds = new Set(
      confirmedPairs.map((p: { applicantAId: string; applicantBId: string }) =>
        p.applicantAId === excludeConfirmedAgainstId ? p.applicantBId : p.applicantAId,
      ),
    );

    return candidates.filter((c: { id: string }) => !confirmedOtherIds.has(c.id));
  }

  /** Re-check for an EXISTING applicant: same match rule as findDuplicates,
   *  minus itself and minus any confirmed-distinct pair. */
  async findDuplicatesForApplicant(companyId: string, applicantId: string) {
    const applicant = await this.findOne(companyId, applicantId);
    const duplicates = await this.findDuplicates(
      companyId,
      applicant.primaryPhoneNormalized,
      applicant.emailNormalized,
      applicantId,
    );
    // A list of other people: phone numbers masked.
    return maskPhoneFields(duplicates.filter((d: { id: string }) => d.id !== applicantId));
  }

  /** The deliberate opposite of merge() — records "these are different
   *  people," idempotently, so findDuplicatesForApplicant stops
   *  resurfacing this exact pair. */
  async confirmDistinct(
    companyId: string,
    applicantId: string,
    otherApplicantId: string,
    actorId: string | null,
  ) {
    if (applicantId === otherApplicantId) {
      throw new BadRequestException('Cannot confirm an applicant as distinct from itself');
    }
    await Promise.all([
      this.findOne(companyId, applicantId),
      this.findOne(companyId, otherApplicantId),
    ]);

    const [applicantAId, applicantBId] = orderApplicantPair(applicantId, otherApplicantId);

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.applicantDistinctPair.upsert({
          where: {
            companyId_applicantAId_applicantBId: { companyId, applicantAId, applicantBId },
          },
          update: {},
          create: { companyId, applicantAId, applicantBId, decidedById: actorId },
        }),
      ),
    );
  }

  async create(companyId: string, dto: CreateApplicantDto) {
    const primaryPhoneNormalized = normalizePhone(dto.primaryPhone);
    const emailNormalized = dto.email ? normalizeEmail(dto.email) : null;

    const duplicates = await this.findDuplicates(
      companyId,
      primaryPhoneNormalized,
      emailNormalized,
    );

    // Server-side validation against the company's ACTIVE definitions.
    // Until v0.2.3 this was `z.record(z.unknown())` — any key, any
    // value, straight into JSONB.
    const customFields = await this.customFields.resolveValuesForWrite(
      companyId,
      'APPLICANT',
      dto.customFields,
    );

    const applicant = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.applicant.create({
          data: {
            companyId,
            name: dto.name,
            primaryPhone: dto.primaryPhone.trim(),
            primaryPhoneNormalized,
            alternatePhones: dto.alternatePhones ?? [],
            email: dto.email,
            emailNormalized,
            addressLine1: dto.addressLine1,
            city: dto.city,
            state: dto.state,
            pincode: dto.pincode,
            panCiphertext: dto.pan ? this.panEncryption.encrypt(dto.pan) : null,
            panMasked: dto.pan ? this.panEncryption.mask(dto.pan) : null,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            customFields: customFields as any,
          },
        }),
      ),
    );

    return {
      ...applicant,
      possibleDuplicateApplicantIds: duplicates.map((d: { id: string }) => d.id),
    };
  }

  async update(companyId: string, id: string, dto: UpdateApplicantDto) {
    const existing = await this.findOne(companyId, id);
    if (existing.mergedIntoId) {
      throw new ConflictException(
        `Applicant has been merged into ${existing.mergedIntoId}`,
      );
    }

    const { pan, ...rest } = dto;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = { ...rest };
    if (dto.primaryPhone !== undefined) {
      data.primaryPhone = dto.primaryPhone.trim();
      data.primaryPhoneNormalized = normalizePhone(dto.primaryPhone);
    }
    if (dto.email !== undefined) {
      data.emailNormalized = dto.email ? normalizeEmail(dto.email) : null;
    }
    if (pan !== undefined) {
      data.panCiphertext = this.panEncryption.encrypt(pan);
      data.panMasked = this.panEncryption.mask(pan);
    }
    if (dto.customFields !== undefined) {
      // Merged against what's stored, so omitting a required field in a
      // PATCH can't silently bypass it.
      data.customFields = await this.customFields.resolveValuesForWrite(
        companyId,
        'APPLICANT',
        dto.customFields,
        existing.customFields as Record<string, unknown> | null,
      );
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.applicant.update({ where: { id }, data }),
      ),
    );
  }

  async recordConsent(
    companyId: string,
    applicantId: string,
    actorId: string | null,
    given: boolean,
    source: string | undefined,
  ) {
    const applicant = await this.findOne(companyId, applicantId);
    if (applicant.mergedIntoId) {
      throw new ConflictException(
        `Applicant has been merged into ${applicant.mergedIntoId}`,
      );
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.applicantConsent.create({
          data: { companyId, applicantId, given, source, actorId },
        }),
      ),
    );
  }

  async getConsentHistory(companyId: string, applicantId: string) {
    await this.findOne(companyId, applicantId);
    return this.systemPrisma.applicantConsent.findMany({
      where: { companyId, applicantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Current consent = latest recorded row (or "no consent recorded" if none). */
  async getCurrentConsent(companyId: string, applicantId: string) {
    await this.findOne(companyId, applicantId);
    const latest = await this.systemPrisma.applicantConsent.findFirst({
      where: { companyId, applicantId },
      orderBy: { createdAt: 'desc' },
    });
    return { given: latest?.given ?? false, recordedAt: latest?.createdAt ?? null };
  }

  /**
   * Timeline surfaces communications logged against this applicant AND any
   * applicant later merged into it. CommunicationLog.applicantId is never
   * rewritten on merge, so a merged-in applicant's rows still carry their
   * original applicantId — we join through Applicant.mergedIntoId instead
   * of reassigning rows, preserving the original recipient identity.
   */
  async getCommunicationTimeline(companyId: string, applicantId: string) {
    await this.findOne(companyId, applicantId);
    const mergedFrom = await this.systemPrisma.applicant.findMany({
      where: { companyId, mergedIntoId: applicantId },
      select: { id: true },
    });
    const applicantIds = [applicantId, ...mergedFrom.map((a: { id: string }) => a.id)];

    const rows = await this.systemPrisma.communicationLog.findMany({
      where: { companyId, applicantId: { in: applicantIds } },
      orderBy: { createdAt: 'desc' },
    });
    // A list view: an SMS recipient is a phone number, so it is masked.
    return rows.map((r: { channel: string; toAddress: string }) =>
      r.channel === 'SMS' ? { ...r, toAddress: maskPhone(r.toAddress) } : r,
    );
  }

  async merge(
    companyId: string,
    survivorId: string,
    mergedId: string,
    actorId: string | null,
  ) {
    if (survivorId === mergedId) {
      throw new BadRequestException('Cannot merge an applicant into itself');
    }

    const [survivor, merged] = await Promise.all([
      this.systemPrisma.applicant.findFirst({ where: { id: survivorId, companyId } }),
      this.systemPrisma.applicant.findFirst({ where: { id: mergedId, companyId } }),
    ]);
    if (!survivor) throw new NotFoundException('Survivor applicant not found');
    if (!merged) throw new NotFoundException('Applicant to merge not found');
    if (survivor.mergedIntoId) {
      throw new ConflictException(
        `Survivor has itself been merged into ${survivor.mergedIntoId}; merge against that applicant instead`,
      );
    }
    if (merged.mergedIntoId) {
      throw new ConflictException(
        `Applicant has already been merged into ${merged.mergedIntoId}`,
      );
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        // Reassign Inquiry.applicantId (and therefore, transitively, all
        // FollowUp rows keyed by inquiryId) to the survivor. FollowUp rows
        // are never touched directly — nothing can be lost or duplicated.
        await tx.inquiry.updateMany({
          where: { applicantId: mergedId, companyId },
          data: { applicantId: survivorId },
        });

        // CommunicationLog rows are intentionally NOT reassigned — they
        // permanently identify the original recipient. See CLAUDE.md
        // Phase 3 decisions.
        await tx.applicant.update({
          where: { id: mergedId },
          data: { mergedIntoId: survivorId },
        });

        return tx.applicantMerge.create({
          data: { companyId, survivorId, mergedId, mergedById: actorId },
        });
      }),
    );
  }
}
