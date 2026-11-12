import { Inject, Injectable } from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA } from '../database/database.module';
import { assertOwnedByCompany } from '../common/tenant-ownership';
import type { UpsertAssignmentPoolDto } from '@openestate/shared';

const AUTO_ASSIGN_MAX_RETRIES = 3;
const RETRY_BACKOFF_BASE_MS = 20;

interface PoolRow {
  id: string;
  user_id: string;
}

@Injectable()
export class AssignmentService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
  ) {}

  /**
   * Picks the next assignee from a project's round-robin pool and claims
   * it, using SELECT ... FOR UPDATE SKIP LOCKED so concurrent callers each
   * lock a *different* pool row instead of queueing for the same one —
   * two inquiries arriving simultaneously never land on the same executive
   * (up to pool size). Must be called with a transaction client (`tx`)
   * that is already inside a tenant-scoped `withTenantTx` (RLS session var
   * set) — this method does not open its own transaction so it can share
   * the caller's inquiry-creation transaction.
   *
   * Returns null (never throws, never 500s) if the pool is empty/paused,
   * or if all rows remain locked after `maxRetries` short-backoff retries
   * — the caller falls back to leaving the inquiry unassigned.
   */
  async autoAssign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    companyId: string,
    projectId: string,
    maxRetries = AUTO_ASSIGN_MAX_RETRIES,
  ): Promise<string | null> {
    const activeCount: number = await tx.projectAssignmentPool.count({
      where: { companyId, projectId, isActive: true },
    });
    if (activeCount === 0) return null;

    // Serialize the pick-and-claim critical section per project with a
    // transaction-scoped advisory lock. Two DIFFERENT projects never
    // contend (different lock keys, fully concurrent); two claims for the
    // SAME project queue here instead of racing. This is what turns "no
    // duplicate picks" (which SKIP LOCKED alone already guarantees) into
    // "strict round-robin order" — without it, concurrent transactions can
    // each independently decide "the earliest-last_assigned_at row is
    // free" from stale-relative-to-each-other reads and legitimately claim
    // different rows via SKIP LOCKED, yet still converge on an uneven
    // distribution under a true concurrent thundering herd, because
    // nothing serializes the ORDER in which rows get re-queued to the
    // back of the line. The advisory lock costs nothing extra for the
    // common case (no contention) and is released automatically at
    // transaction end — no separate unlock call needed.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const rows: PoolRow[] = await tx.$queryRaw`
        SELECT id, user_id FROM project_assignment_pools
        WHERE project_id = ${projectId}::uuid
          AND company_id = ${companyId}::uuid
          AND is_active = true
        ORDER BY last_assigned_at ASC NULLS FIRST, sort_order ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (rows.length > 0) {
        const picked = rows[0];
        await tx.$executeRaw`
          UPDATE project_assignment_pools SET last_assigned_at = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE id = ${picked.id}::uuid
        `;
        return picked.user_id;
      }

      if (attempt < maxRetries) {
        await sleep(RETRY_BACKOFF_BASE_MS + Math.random() * RETRY_BACKOFF_BASE_MS);
      }
    }

    return null;
  }

  async listPool(companyId: string, projectId: string) {
    return this.systemFindPool(companyId, projectId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async systemFindPool(companyId: string, projectId: string): Promise<any> {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.projectAssignmentPool.findMany({
          where: { companyId, projectId },
          orderBy: { sortOrder: 'asc' },
        }),
      ),
    );
  }

  async setMembership(
    companyId: string,
    projectId: string,
    userId: string,
    dto: UpsertAssignmentPoolDto,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await assertOwnedByCompany(tx, companyId, [
          ['project', projectId, 'Project'],
          ['user', userId, 'User'],
        ]);
        const existing = await tx.projectAssignmentPool.findFirst({
          where: { companyId, projectId, userId },
        });

        const reactivating = !!existing && !existing.isActive && dto.isActive;

        if (existing) {
          return tx.projectAssignmentPool.update({
            where: { id: existing.id },
            data: {
              isActive: dto.isActive,
              pausedReason: dto.isActive ? null : (dto.pausedReason ?? null),
              // Returning members go to the back of the queue, not the front.
              lastAssignedAt: reactivating ? new Date() : existing.lastAssignedAt,
            },
          });
        }

        return tx.projectAssignmentPool.create({
          data: {
            companyId,
            projectId,
            userId,
            isActive: dto.isActive,
            pausedReason: dto.isActive ? null : (dto.pausedReason ?? null),
          },
        });
      }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
