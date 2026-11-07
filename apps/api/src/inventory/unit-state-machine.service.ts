import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA } from '../database/database.module';
import {
  isValidTransition,
  REASON_REQUIRED_STATUSES,
  isSystemOnlyTarget,
} from '@openestate/shared';
import type { UnitStatus, ActorType } from '@openestate/shared';

/**
 * Lock unit rows FOR NO KEY UPDATE, lower id first, inside the caller's
 * transaction. Raw SQL because Prisma has no row-lock clause; the ids are
 * bound parameters. NO KEY UPDATE (not FOR UPDATE) excludes every other
 * status change of these units, and is the mode the status UPDATE takes
 * anyway, but it doesn't block the key-share locks that inserting a booking
 * or a status-history row takes on the unit.
 */
export async function lockUnits(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  companyId: string,
  unitIds: string[],
): Promise<void> {
  for (const id of [...new Set(unitIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM units WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid FOR NO KEY UPDATE`;
  }
}

@Injectable()
export class UnitStateMachineService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
  ) {}

  async transition(
    companyId: string,
    unitId: string,
    toStatus: UnitStatus,
    actorType: ActorType,
    actorId: string | null,
    reason: string | undefined,
  ) {
    if (REASON_REQUIRED_STATUSES.includes(toStatus) && !reason) {
      throw new BadRequestException(
        `Reason is mandatory when transitioning to ${toStatus}`,
      );
    }

    // Booking-lifecycle statuses are system-only (Phase 4). A user-initiated
    // transition may never reach BOOKED/ALLOTTED/REGISTERED/CANCELLED — those
    // are driven exclusively by the booking service.
    if (actorType === 'user' && isSystemOnlyTarget(toStatus)) {
      throw new BadRequestException(
        `Transition to ${toStatus} is system-only and must go through the booking lifecycle, not the manual transition endpoint`,
      );
    }

    // Global lock order for every path that locks units (booking, with-plan,
    // transfer, cancellation, allot/register, manual holds):
    //   booking row → number sequence → units (lower id first) → interest
    //   advisory lock.
    // Attaching an interest rule takes advisory → booking row, only on a
    // booking no other path can hold. Never lock a unit before allocating a
    // number: a transfer holds the number sequence while it waits for its
    // units, so the reverse order deadlocks (unit-lock-race.test.ts, 3b).
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        // Lock before reading, so the status checked is the status changed.
        await lockUnits(tx, companyId, [unitId]);
        const unit = await tx.unit.findFirst({ where: { id: unitId, companyId } });
        if (!unit) throw new NotFoundException('Unit not found');

        const fromStatus = unit.status as UnitStatus;

        if (!isValidTransition(fromStatus, toStatus)) {
          throw new BadRequestException(
            `Invalid transition from ${fromStatus} to ${toStatus}`,
          );
        }

        await tx.unit.update({
          where: { id: unitId },
          data: { status: toStatus },
        });

        await tx.unitStatusChange.create({
          data: {
            companyId,
            unitId,
            fromStatus,
            toStatus,
            reason: reason ?? null,
            actorType,
            actorId,
          },
        });

        return { unitId, fromStatus, toStatus };
      }),
    );
  }
}
