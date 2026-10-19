import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenantTx, runWithTenant, getCurrentIpAddress } from '@openestate/db';
import { INTEREST_RATE_TYPE, PERMISSIONS, type Clock } from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';
import { CLOCK } from '../common/clock.provider';
import { InterestService, ACCRUING_STATUSES, lockBookingInterest } from './interest.service';

export interface SetInterestRuleResult {
  bookingId: string;
  interestRuleId: string | null;
  /** YYYY-MM-DD, or null with no rule. */
  interestFromDate: string | null;
  /** Interest posted under the old rule up to today before the switch (paise). */
  settledPaise: string;
}

interface RuleRow {
  id: string;
  name: string;
  rate_type: string;
  rate_percent: string;
  is_active: boolean;
}

const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * Attach, change or remove a booking's delay-interest rule (v0.9 item 1).
 * Kept outside the frozen BookingService and InterestService: it sets
 * bookings.interest_rule_id and bookings.interest_from_date, and uses
 * InterestService only to settle up.
 *
 * - Interest runs only from the attach date (interest_from_date).
 * - A change or removal first accrues up to today under the old rule, then
 *   switches; past interest is never recalculated.
 * - Only SIMPLE rules may be attached: the rule's compounding frequency is not
 *   applied yet (compounding waits for the CA review).
 *
 * Concurrency: everything runs under lockBookingInterest, the same per-booking
 * lock accrual takes, so a concurrent accrual or a second change runs wholly
 * before or after this one. The rule row is read FOR SHARE so a rate edit on
 * the rule (masters guard, FOR UPDATE) waits for this attach and then sees the
 * rule in use.
 */
@Injectable()
export class BookingInterestRuleService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly interest: InterestService,
  ) {}

  async setRule(
    companyId: string,
    bookingId: string,
    interestRuleId: string | null,
    actorId: string | null,
  ): Promise<SetInterestRuleResult> {
    return runWithTenant({ companyId }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      withTenantTx(this.tenantPrisma, companyId, async (tx: any) => {
        await lockBookingInterest(tx, bookingId);
        const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
        if (!booking) throw new NotFoundException('Booking not found');
        if (!ACCRUING_STATUSES.includes(booking.status)) {
          throw new ConflictException(
            `This booking is ${booking.status}; delay interest can only be set on an active booking.`,
          );
        }

        const unchanged = {
          bookingId,
          interestRuleId: booking.interestRuleId,
          interestFromDate: isoDate(booking.interestFromDate),
          settledPaise: '0',
        };
        if (booking.interestRuleId === interestRuleId) return unchanged;

        let rule: RuleRow | null = null;
        if (interestRuleId) {
          const rows: RuleRow[] = await tx.$queryRaw`
            SELECT id, name, rate_type, rate_percent::text AS rate_percent, is_active
              FROM interest_rules
             WHERE id = ${interestRuleId}::uuid AND company_id = ${companyId}::uuid
               FOR SHARE`;
          rule = rows[0] ?? null;
          if (!rule) throw new NotFoundException('Interest rule not found');
          if (!rule.is_active) throw new ConflictException('This interest rule is inactive. Choose an active rule.');
          if (rule.rate_type !== INTEREST_RATE_TYPE.SIMPLE) {
            throw new ConflictException(
              'Only simple-interest rules can be attached for now: compounding is not applied yet. Choose a simple-interest rule.',
            );
          }
        }

        const now = this.clock.now();
        // Settle up under the old rule (re-enters the lock above; joins this
        // transaction). Posts nothing when there is no old rule.
        const settled = await this.interest.accrueForBooking(companyId, bookingId, now);
        const interestFromDate = rule ? utcDay(now) : null;

        const before = booking.interestRuleId
          ? await tx.interestRule.findFirst({ where: { id: booking.interestRuleId, companyId } })
          : null;
        await tx.booking.update({
          where: { id: bookingId },
          data: { interestRuleId: rule ? rule.id : null, interestFromDate },
        });
        await tx.auditLog.create({
          data: {
            companyId,
            userId: actorId,
            entityType: 'Booking',
            entityId: bookingId,
            action: 'INTEREST_RULE_SET',
            before: {
              interestRuleId: booking.interestRuleId,
              ruleName: before?.name ?? null,
              interestFromDate: isoDate(booking.interestFromDate),
            },
            after: {
              interestRuleId: rule ? rule.id : null,
              ruleName: rule?.name ?? null,
              rateType: rule?.rate_type ?? null,
              ratePercent: rule ? String(Number(rule.rate_percent)) : null,
              interestFromDate: isoDate(interestFromDate),
              settledPaise: settled.postedPaise.toString(),
              permission: PERMISSIONS.POSTSALES_INTEREST_MANAGE,
            },
            ipAddress: getCurrentIpAddress(),
          },
        });

        return {
          bookingId,
          interestRuleId: rule ? rule.id : null,
          interestFromDate: isoDate(interestFromDate),
          settledPaise: settled.postedPaise.toString(),
        };
      }),
    );
  }
}
