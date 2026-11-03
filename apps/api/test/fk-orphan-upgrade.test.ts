/**
 * v0.8.4 Part A on a database that already has an orphan row, through the real
 * `prisma migrate deploy`, on a throwaway scratch database:
 *
 *  1. migrate to just before Part A, plant one orphan (webhook_endpoints.created_by_id
 *     pointing at a user that doesn't exist);
 *  2. hold a lock on `users` and run Part A with a short lock_timeout: the ADD
 *     file fails, nothing is applied, and the next deploy stops with P3009;
 *  3. the release-notes recovery command (mark the failed migration rolled
 *     back) lets the next deploy run;
 *  4. the migrations finish, that one link stays NOT VALID, the other 70 are
 *     validated, no row was changed or deleted;
 *  5. upgrade-native.sh's report (lib.sh) and check-foreign-keys.sh both name it.
 *
 * Steps 5 run the real bash scripts and need `psql` on PATH (CI has it).
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@openestate/db';
import { TEST_SUPER_URL } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const describeIf = APP_URL ? describe : describe.skip;

const REPO = path.join(__dirname, '../../..');
const DB_DIR = path.join(REPO, 'packages/db');
const MIGRATIONS = path.join(DB_DIR, 'prisma/migrations');
const PART_A = ['20261022000000_restore_foreign_keys', '20261022000100_validate_restored_foreign_keys'];
const SCRATCH = `zz_fk_orphan_${Date.now()}`;
const scratchUrl = (options = '') => {
  const u = new URL(TEST_SUPER_URL);
  u.pathname = `/${SCRATCH}`;
  u.search = options ? `?options=${encodeURIComponent(options)}` : '';
  return u.toString();
};
const hasPsql = spawnSync('psql', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

function deploy(schemaPath: string, url: string): { ok: boolean; out: string } {
  try {
    const out = execSync(`npx prisma migrate deploy --schema "${schemaPath}"`, {
      cwd: DB_DIR,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    }).toString();
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, out: `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}` };
  }
}

function runBash(script: string): { status: number; out: string } {
  const u = new URL(TEST_SUPER_URL);
  const r = spawnSync('bash', ['-c', script], {
    cwd: REPO,
    env: {
      ...process.env,
      DB_HOST: u.hostname,
      PG_SUPERUSER: decodeURIComponent(u.username),
      PG_SUPERUSER_PASSWORD: decodeURIComponent(u.password),
      OPENESTATE_DB_NAME: SCRATCH,
    },
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describeIf('v0.8.4 Part A: upgrading a database that has an orphan row', () => {
  let admin: PrismaClient;
  let scratch: PrismaClient;
  let preADir: string;
  let orphanId: string;

  beforeAll(async () => {
    admin = new PrismaClient({ datasourceUrl: TEST_SUPER_URL });
    await admin.$executeRawUnsafe(`CREATE DATABASE ${SCRATCH}`);
    // A copy of the schema and every migration before Part A, as a v0.8.3
    // install has. (Not "every migration except Part A": a later migration may
    // depend on Part A — v0.9's 20261101000000_booking_interest_rule replaces a
    // foreign key Part A adds. The deploys below apply Part A and everything
    // after it, in order, as a real upgrade does.)
    preADir = mkdtempSync(path.join(tmpdir(), 'fk-orphan-'));
    cpSync(path.join(DB_DIR, 'prisma/schema.prisma'), path.join(preADir, 'schema.prisma'));
    for (const m of readdirSync(MIGRATIONS)) {
      if (m < PART_A[0] || m === 'migration_lock.toml') {
        cpSync(path.join(MIGRATIONS, m), path.join(preADir, 'migrations', m), { recursive: true });
      }
    }
    const pre = deploy(path.join(preADir, 'schema.prisma'), scratchUrl());
    if (!pre.ok) throw new Error(`pre-A deploy failed:\n${pre.out}`);
    scratch = new PrismaClient({ datasourceUrl: scratchUrl() });
  }, 300_000);

  afterAll(async () => {
    await scratch?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin?.$disconnect();
    if (preADir) rmSync(preADir, { recursive: true, force: true });
  });

  it('plants one orphan before Part A', async () => {
    const companyId = randomUUID();
    orphanId = randomUUID();
    await scratch.$executeRawUnsafe(
      `INSERT INTO companies (id, name, slug, updated_at) VALUES ($1::uuid, 'Orphan Co', $2, now())`,
      companyId,
      `orphan-${companyId}`,
    );
    await scratch.$executeRawUnsafe(
      `INSERT INTO webhook_endpoints (id, company_id, name, url, secret_ciphertext, secret_key_version, event_types, created_by_id, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Orphan hook', 'https://example.invalid/hook', 'x', 1, '{}', gen_random_uuid(), now())`,
      orphanId,
      companyId,
    );
    const fk = await scratch.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_created_by_id_fkey'`);
    expect(fk).toEqual([]);
  });

  it('a lock timeout fails the ADD file cleanly; the next deploy stops with P3009 until the recovery command is run', async () => {
    const blocker = new PrismaClient({ datasourceUrl: scratchUrl() });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = blocker.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`LOCK TABLE users IN ROW EXCLUSIVE MODE`);
        locked();
        await held;
      },
      { timeout: 120_000 },
    );
    await isLocked;
    try {
      const first = deploy(path.join(DB_DIR, 'prisma/schema.prisma'), scratchUrl('-c lock_timeout=2s'));
      expect(first.ok).toBe(false);
      expect(first.out).toMatch(/lock timeout/i);
      expect(first.out).toContain('20261022000000_restore_foreign_keys');
      const second = deploy(path.join(DB_DIR, 'prisma/schema.prisma'), scratchUrl('-c lock_timeout=2s'));
      expect(second.ok).toBe(false);
      expect(second.out).toContain('P3009');
    } finally {
      release();
      await holder;
      await blocker.$disconnect();
    }
    // Nothing from the failed file was applied.
    const added = await scratch.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_created_by_id_fkey'`);
    expect(added).toEqual([]);
    // The recovery command from the release notes, exactly.
    await scratch.$executeRawUnsafe(
      `UPDATE _prisma_migrations SET rolled_back_at = now() WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
    );
  }, 300_000);

  it('the migrations then finish: the orphaned link stays NOT VALID, the other 70 are validated, the row is untouched', async () => {
    const r = deploy(path.join(DB_DIR, 'prisma/schema.prisma'), scratchUrl());
    expect(r.ok, r.out).toBe(true);
    const rows = await scratch.$queryRawUnsafe<Array<{ conname: string; convalidated: boolean }>>(
      `SELECT conname, convalidated FROM pg_constraint WHERE contype = 'f' AND NOT convalidated`,
    );
    expect(rows).toEqual([{ conname: 'webhook_endpoints_created_by_id_fkey', convalidated: false }]);
    const partA = [...readFileSync(path.join(MIGRATIONS, PART_A[0], 'migration.sql'), 'utf8').matchAll(/ADD CONSTRAINT "(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(partA).toHaveLength(71);
    const validated = await scratch.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM pg_constraint WHERE contype = 'f' AND convalidated AND conname = ANY($1::text[])`,
      partA,
    );
    expect(Number(validated[0].n)).toBe(70);
    const still = await scratch.$queryRawUnsafe<Array<{ created_by_id: string | null }>>(
      `SELECT created_by_id::text FROM webhook_endpoints WHERE id = $1::uuid`,
      orphanId,
    );
    expect(still).toHaveLength(1);
    expect(still[0].created_by_id).not.toBeNull();
  }, 300_000);

  it.runIf(hasPsql || process.env.CI)('upgrade-native.sh report and check-foreign-keys.sh both name it, read-only', () => {
    const report = runBash(`source deploy/native/lib.sh && print_unvalidated_foreign_keys`);
    expect(report.status, report.out).toBe(2);
    expect(report.out).toMatch(/webhook_endpoints \| created_by_id \| users \| 1 \| webhook_endpoints_created_by_id_fkey/);
    const check = runBash(`./deploy/native/check-foreign-keys.sh`);
    console.log(check.out);
    expect(check.status, check.out).toBe(2);
    expect(check.out).toMatch(/webhook_endpoints \| created_by_id \| users \| 1 \| webhook_endpoints_created_by_id_fkey/);
    expect(check.out).not.toMatch(/ \| 0 \| /);
  });
});
