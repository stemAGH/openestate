import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import type { CreateBrokerDto, UpdateBrokerDto, BrokerBankDetailDto, PaginationQuery } from '@openestate/shared';
import { maskPhoneFields } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { PanEncryptionService } from '../common/pan-encryption.service';

@Injectable()
export class BrokerService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly panEncryption: PanEncryptionService,
  ) {}

  async findAll(companyId: string, query: PaginationQuery) {
    const { page, limit, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.systemPrisma.broker.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { name: 'asc' },
        // panMasked is the display value; the encrypted blob has no
        // legitimate reason to leave the server outside the dedicated,
        // audited revealPan() action below (which reads it via its own
        // query, not this one).
        omit: { panCiphertext: true, panKeyVersion: true },
      }),
      this.systemPrisma.broker.count({ where }),
    ]);

    // A list view: last 4 digits only. findOne keeps the full number.
    return { data: maskPhoneFields(data), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(companyId: string, id: string) {
    const broker = await this.systemPrisma.broker.findFirst({
      where: { id, companyId },
      include: { bankDetails: true },
      omit: { panCiphertext: true, panKeyVersion: true },
    });
    if (!broker) throw new NotFoundException('Broker not found');
    return broker;
  }

  async create(companyId: string, dto: CreateBrokerDto) {
    const { pan, ...rest } = dto;
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.broker.create({
          data: {
            companyId,
            ...rest,
            panCiphertext: pan ? this.panEncryption.encrypt(pan) : null,
            panMasked: pan ? this.panEncryption.mask(pan) : null,
          },
        }),
      ),
    );
  }

  async update(companyId: string, id: string, dto: UpdateBrokerDto) {
    await this.findOne(companyId, id);
    const { pan, ...rest } = dto;
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.broker.update({
          where: { id },
          data: {
            ...rest,
            ...(pan !== undefined
              ? { panCiphertext: this.panEncryption.encrypt(pan), panMasked: this.panEncryption.mask(pan) }
              : {}),
          },
        }),
      ),
    );
  }

  /** Soft-deactivate — never a hard delete. Feeds NocService's auto-approval path (§6). */
  async deactivate(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.broker.update({ where: { id }, data: { isActive: false, deactivatedAt: new Date() } }),
      ),
    );
  }

  async reactivate(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.broker.update({ where: { id }, data: { isActive: true, deactivatedAt: null } }),
      ),
    );
  }

  async addBankDetail(companyId: string, brokerId: string, dto: BrokerBankDetailDto) {
    await this.findOne(companyId, brokerId);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        if (dto.isPrimary) {
          await tx.brokerBankDetail.updateMany({ where: { companyId, brokerId }, data: { isPrimary: false } });
        }
        return tx.brokerBankDetail.create({ data: { companyId, brokerId, ...dto } });
      }),
    );
  }

  async listBankDetails(companyId: string, brokerId: string) {
    await this.findOne(companyId, brokerId);
    return this.systemPrisma.brokerBankDetail.findMany({ where: { companyId, brokerId }, orderBy: { isPrimary: 'desc' } });
  }

  /**
   * Decrypted PAN — only for the rare "reveal" action, never in a list
   * response. Queries panCiphertext directly rather than going through
   * findOne(), which deliberately omits it for every other caller.
   */
  async revealPan(companyId: string, id: string): Promise<string | null> {
    const broker = await this.systemPrisma.broker.findFirst({
      where: { id, companyId },
      select: { panCiphertext: true },
    });
    if (!broker) throw new NotFoundException('Broker not found');
    if (!broker.panCiphertext) return null;
    return this.panEncryption.decrypt(broker.panCiphertext);
  }

  /**
   * Sourcing broker for a booking — Booking.brokerId (Decision A). A
   * separate call after the booking already exists, same two-step
   * pattern as POST /bookings/:id/plan/from-template. BookingService
   * itself is never touched — this writes the scalar column directly.
   */
  async assignToBooking(companyId: string, bookingId: string, brokerId: string) {
    await this.findOne(companyId, brokerId);
    const booking = await this.systemPrisma.booking.findFirst({ where: { id: bookingId, companyId } });
    if (!booking) throw new NotFoundException('Booking not found');

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        // v0.10.1: once commission has accrued for the booking's broker, changing
        // the broker would leave that commission with the wrong person. Checked
        // under the booking's row lock. (Raw SQL: a row lock has no Prisma API;
        // both ids are bound parameters.)
        await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`;
        const accrued =
          (await tx.brokerBookingCommission.count({ where: { companyId, bookingId } })) +
          (await tx.commissionLedgerEntry.count({ where: { companyId, bookingId } }));
        const current = await tx.booking.findFirst({ where: { id: bookingId, companyId }, select: { brokerId: true } });
        if (accrued > 0 && brokerId !== current?.brokerId) {
          throw new ConflictException(
            'Commission has already accrued on this booking for its broker; the broker can no longer be changed here (a clawback is needed).',
          );
        }
        return tx.booking.update({ where: { id: bookingId }, data: { brokerId } });
      }),
    );
  }
}
