import { ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { INTEREST_RATE_TYPE } from '@openestate/shared';
import type { MasterModuleConfig } from './master.factory';
import { ACCRUING_STATUSES } from '../postsales/interest.service';

/**
 * The InterestRule master.
 *
 * rateType/ratePercent/frequency are required, non-nullable Prisma columns
 * createMasterSchema never had. rateType reuses InterestService's own
 * INTEREST_RATE_TYPE enum (SIMPLE/COMPOUND) so this can never drift from what
 * the accrual engine understands.
 *
 * beforeUpdate (v0.9): the rate of a rule attached to an active booking can't
 * be edited. Accrual reads the rule on every run, so an edit would silently
 * change interest on every booking using it; a rate change goes through a new
 * rule and PUT /bookings/:id/interest-rule instead, which settles up and is
 * audited. Only a real change is refused: the Masters screen sends the whole
 * record, so unchanged rate fields (a rename, a sort order, isActive) pass.
 * The rule row is locked FOR UPDATE first, so an attach in flight (which holds
 * it FOR SHARE) commits before the in-use count is taken.
 */
export const INTEREST_RULE_MASTER: MasterModuleConfig = {
  modelName: 'InterestRule',
  routePath: 'interest-rules',
  apiTag: 'Interest Rules',
  extraFields: {
    rateType: z.nativeEnum(INTEREST_RATE_TYPE),
    ratePercent: z.coerce.number().min(0).max(100),
    frequency: z.enum(['DAILY', 'MONTHLY', 'YEARLY']),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  beforeUpdate: async (tx: any, companyId, id, data) => {
    if (data.rateType === undefined && data.ratePercent === undefined) return;
    const rows: Array<{ rate_type: string; rate_percent: string }> = await tx.$queryRaw`
      SELECT rate_type, rate_percent::text AS rate_percent
        FROM interest_rules
       WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
         FOR UPDATE`;
    const current = rows[0];
    if (!current) return; // update() itself reports the 404
    const changed =
      (data.rateType !== undefined && data.rateType !== current.rate_type) ||
      (data.ratePercent !== undefined && Number(data.ratePercent) !== Number(current.rate_percent));
    if (!changed) return;
    const inUse: number = await tx.booking.count({
      where: { companyId, interestRuleId: id, status: { in: ACCRUING_STATUSES } },
    });
    if (inUse > 0) {
      throw new ConflictException(
        `This interest rule is attached to ${inUse} booking(s), so its rate can't be changed. ` +
          'Create a new rule and change the bookings to it.',
      );
    }
  },
};
