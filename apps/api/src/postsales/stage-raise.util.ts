import { Prisma } from '@prisma/client';

/**
 * The one date-computation formula for a STAGE_LINKED installment's due
 * date, used by both raise paths (the bulk per-project-stage endpoint and
 * self-raise-at-instantiation) so there is exactly one place this math
 * lives. See internal plan construction-linked-demand-fix.md §1.2 — this is
 * NOT dueOffsetDays (that stays booking-date-anchored, DATE_LINKED only).
 */
export function computeRaisedDueDate(stageCompletedOn: Date, graceDaysAfterRaise: number): Date {
  const d = new Date(stageCompletedOn);
  d.setUTCDate(d.getUTCDate() + graceDaysAfterRaise);
  return d;
}

/**
 * Look up an existing raise for (project, template, milestone). Used both
 * to make a bulk re-raise idempotent (§1.6) and to let a booking created
 * after the stage was already raised pick that up automatically at
 * instantiation time (§1.7.1) — the same lookup serves both purposes, so
 * there is exactly one query to keep in sync with StageRaise's shape.
 */
export function findStageRaise(
  tx: Prisma.TransactionClient,
  companyId: string,
  projectId: string,
  templateId: string,
  milestoneSeq: number,
) {
  return tx.stageRaise.findFirst({
    where: { companyId, projectId, templateId, milestoneSeq },
  });
}
