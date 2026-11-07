/**
 * A barrier for forced-interleaving tests (CLAUDE.md standing rule: a
 * concurrency test must force its interleaving). The test holds its own row
 * lock on a unit, starts the requests under test, waits until a given number
 * of database sessions are blocked behind it (directly or through each other,
 * since queued waiters block each other), then releases.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;

export interface Barrier {
  pid: number;
  /** Commit the barrier; with `setStatus`, first change the unit's status in it. */
  release: (setStatus?: string) => Promise<void>;
}

/** Hold FOR NO KEY UPDATE on one unit row, on its own connection, until released. */
export async function holdUnitLock(systemPrisma: Client, unitId: string): Promise<Barrier> {
  let release!: (setStatus?: string) => void;
  const gate = new Promise<string | undefined>((r) => (release = r));
  let pidReady!: (pid: number) => void;
  const pid = new Promise<number>((r) => (pidReady = r));
  const done = systemPrisma.$transaction(
    async (tx: Client) => {
      const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM units WHERE id = ${unitId}::uuid FOR NO KEY UPDATE`;
      pidReady(Number(row.pid));
      const setStatus = await gate;
      if (setStatus) {
        await tx.$executeRaw`UPDATE units SET status = ${setStatus}::"UnitStatus" WHERE id = ${unitId}::uuid`;
      }
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  return {
    pid: await pid,
    release: async (setStatus?: string) => {
      release(setStatus);
      await done;
    },
  };
}

/** Wait until `count` sessions are blocked, directly or transitively, behind `pid`. */
export async function waitBlockedBehind(systemPrisma: Client, pid: number, count: number, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    const rows: Array<{ pid: number; blockers: number[] }> = await systemPrisma.$queryRaw`
      SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database()`;
    const blocked = new Set<number>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) {
        if (blocked.has(r.pid)) continue;
        if (r.blockers.some((b) => b === pid || blocked.has(b))) {
          blocked.add(r.pid);
          grew = true;
        }
      }
    }
    if (blocked.size >= count) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`only ${blocked.size} of ${count} sessions blocked behind the barrier`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
