import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { MILESTONE_TYPE, type RaiseStageDto } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { computeRaisedDueDate, findStageRaise } from './stage-raise.util';

/**
 * Bulk per-project-stage demand raising. See
 * internal plan construction-linked-demand-fix.md §1.5-1.6 for why this is
 * bulk (a construction stage is a project-wide physical fact — the slab
 * gets poured once, for every customer on it) rather than per-booking,
 * and why no separate single-installment raise action exists: a booking
 * added after a stage is already raised picks it up automatically at
 * plan-instantiation time (PaymentPlanService, self-raise).
 */
@Injectable()
export class StageRaiseService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async raiseStage(companyId: string, projectId: string, dto: RaiseStageDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const project = await tx.project.findFirst({ where: { id: projectId, companyId } });
        if (!project) throw new NotFoundException('Project not found');

        const milestone = await tx.paymentPlanMilestone.findFirst({
          where: { companyId, templateId: dto.templateId, seq: dto.milestoneSeq },
        });
        if (!milestone) throw new NotFoundException('Milestone not found on this template');
        if (milestone.milestoneType !== MILESTONE_TYPE.STAGE_LINKED) {
          throw new BadRequestException(
            'This milestone is DATE_LINKED — it becomes due automatically and does not need raising',
          );
        }

        // Idempotent by design: a second raise of an already-raised stage
        // reuses the same StageRaise row (its original stageCompletedOn
        // is authoritative — correcting it is out of scope, see the plan
        // §1.6.1) and finds nothing left to raise, since every installment
        // that was going to be raised already was, and every booking made
        // since then self-raised at instantiation.
        let stageRaise = await findStageRaise(tx, companyId, projectId, dto.templateId, dto.milestoneSeq);
        if (!stageRaise) {
          stageRaise = await tx.stageRaise.create({
            data: {
              companyId,
              projectId,
              templateId: dto.templateId,
              milestoneSeq: dto.milestoneSeq,
              label: milestone.label,
              stageCompletedOn: dto.stageCompletedOn,
              raisedById: actorId,
            },
          });
        }

        const dueDate = computeRaisedDueDate(stageRaise.stageCompletedOn, milestone.graceDaysAfterRaise);

        // No ledger entry posted here — raising only sets a date, it's
        // inert until time passes (interest) or a receipt is later
        // allocated against it. This is deliberately a plain bulk UPDATE
        // (not a per-row loop) because there is no per-row side effect to
        // sequence in this pass; the plan names the future suspense-sweep
        // extension point as PaymentPlanService's self-raise path and
        // this bulk path both calling the same computeRaisedDueDate/
        // findStageRaise primitives, not this loop shape specifically.
        const result = await tx.installment.updateMany({
          where: {
            companyId,
            isActive: true,
            milestoneType: MILESTONE_TYPE.STAGE_LINKED,
            milestoneSeq: dto.milestoneSeq,
            dueDate: null,
            plan: { isActive: true, templateId: dto.templateId },
            booking: { unit: { projectId } },
          },
          data: { dueDate, stageRaiseId: stageRaise.id },
        });

        return { stageRaiseId: stageRaise.id, raisedCount: result.count, stageCompletedOn: stageRaise.stageCompletedOn };
      }),
    );
  }

  /**
   * Distinct STAGE_LINKED milestones currently unraised somewhere in this
   * project, with a count of bookings waiting — powers the "Construction
   * Stages" panel (§6.1). Uses SYSTEM_PRISMA (read-only, RLS-bypassing,
   * same pattern as every other report-shaped query in this codebase) —
   * the companyId filter is explicit below, matching that precedent.
   */
  async listPending(companyId: string, projectId: string) {
    const rows = await this.systemPrisma.installment.groupBy({
      by: ['milestoneSeq'],
      where: {
        companyId,
        isActive: true,
        milestoneType: MILESTONE_TYPE.STAGE_LINKED,
        dueDate: null,
        plan: { isActive: true },
        booking: { unit: { projectId } },
      },
      _count: { _all: true },
    });
    if (rows.length === 0) return [];

    // groupBy can't traverse into plan.templateId/label directly, so a
    // second small lookup fills those in per distinct milestoneSeq found
    // above. Small N (a handful of stages per project, never all bookings).
    const results = [];
    for (const row of rows) {
      const sample = await this.systemPrisma.installment.findFirst({
        where: {
          companyId,
          isActive: true,
          milestoneType: MILESTONE_TYPE.STAGE_LINKED,
          milestoneSeq: row.milestoneSeq,
          dueDate: null,
          plan: { isActive: true },
          booking: { unit: { projectId } },
        },
        select: { label: true, plan: { select: { templateId: true } } },
      });
      if (!sample?.plan.templateId) continue;
      results.push({
        templateId: sample.plan.templateId,
        milestoneSeq: row.milestoneSeq,
        label: sample.label,
        pendingCount: row._count._all,
      });
    }
    return results;
  }
}
