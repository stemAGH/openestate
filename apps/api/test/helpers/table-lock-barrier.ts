/**
 * Forces an interleaving (CLAUDE.md: "a concurrency test must force its
 * interleaving"): a superuser connection holds an ACCESS EXCLUSIVE lock on
 * one table, and the requests under test are started one at a time, in the
 * order given. Each is started only once every earlier one is waiting,
 * directly on the lock or behind another waiting request (pg_blocking_pids,
 * followed transitively), or has finished, so the order in which they reach
 * their locks is fixed, not left to timing. The lock is released when all
 * are waiting or finished.
 *
 * Table-wide lock: only for *.serial.test.ts files (vitest.serial.config.ts),
 * which run after every other suite has finished.
 */
import { PrismaClient } from '@openestate/db';
import { TEST_SUPER_URL } from './postsales-harness';

/* eslint-disable @typescript-eslint/no-explicit-any -- raw Prisma transaction client */

const BLOCKED_BEHIND = `
  WITH RECURSIVE b(pid) AS (
    SELECT a.pid FROM pg_stat_activity a WHERE $1::int = ANY (pg_blocking_pids(a.pid))
    UNION
    SELECT a.pid FROM pg_stat_activity a JOIN b ON b.pid = ANY (pg_blocking_pids(a.pid))
  )
  SELECT count(*)::int AS n FROM b`;

export async function behindTableLock<T>(
  table: string,
  starters: Array<() => Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
  const holder = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
  const observer = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
  const started: Array<Promise<T>> = [];
  try {
    await holder.$transaction(
      async (tx: any) => {
        const [{ pid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
        await tx.$executeRawUnsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
        let finished = 0;
        for (const start of starters) {
          const p = start();
          // Counts a request that completes without ever blocking (which is
          // what an unprotected one may do); also keeps a rejection from
          // surfacing as unhandled before allSettled below.
          p.then(
            () => finished++,
            () => finished++,
          );
          started.push(p);
          const deadline = Date.now() + 15_000;
          for (;;) {
            const [{ n }] = (await observer.$queryRawUnsafe(BLOCKED_BEHIND, pid)) as Array<{ n: number }>;
            if (n + finished >= started.length) break;
            if (Date.now() > deadline) {
              throw new Error(`barrier: only ${n} of ${started.length} requests blocked behind the ${table} lock`);
            }
            await new Promise((r) => setTimeout(r, 25));
          }
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return await Promise.allSettled(started);
  } finally {
    await holder.$disconnect();
    await observer.$disconnect();
  }
}
