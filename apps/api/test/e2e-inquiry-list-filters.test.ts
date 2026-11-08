/**
 * GET /inquiries search, filters and sort, plus the IST day boundary that
 * the followUp filter, the dashboard tiles and My Day share.
 *
 * The process clock is UTC (as on a CI runner or a UTC server), and the
 * injected clock is set either side of IST midnight (18:30 UTC), so these
 * tests fail if any of the three falls back to the host's own time zone.
 *
 * Requires the compiled dist/ — see e2e-company-update.test.ts for why.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PASSWORD = 'StaffPass123';
const TAG = `${Date.now()}-${process.pid}`;

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-inquiry-list-filters-${TAG}-`;

// 18:29 UTC = 23:59 IST on 10 Nov; 18:31 UTC = 00:01 IST on 11 Nov.
const BEFORE_IST_MIDNIGHT = new Date('2026-11-10T18:29:00Z');
const AFTER_IST_MIDNIGHT = new Date('2026-11-10T18:31:00Z');
const clock = { current: BEFORE_IST_MIDNIGHT, now: () => new Date(clock.current) };

async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = APP_URL;
  process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
  process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
  process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
  process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
  process.env.CORS_ALLOWLIST ??= 'http://localhost:5174';
  process.env.SWAGGER_ENABLED = 'false';

  const require = createRequire(import.meta.url);
  const { AppModule } = require('../dist/app.module');
  const { CLOCK } = require('../dist/common/clock.provider');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  const nestApp = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  nestApp.use(cookieParser());
  nestApp.setGlobalPrefix('api/v1');
  nestApp.useGlobalPipes(new ZodValidationPipe());
  await nestApp.init();
  return nestApp;
}

describeIf('e2e GET /inquiries search, filters, sort and IST day boundaries', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  const email = (who: string) => `e2e-inqf-${who}-${TAG}@test.com`;
  const ids: Record<string, string> = {};
  const tokens = new Map<string, string>();

  async function token(who: string) {
    if (!tokens.has(who)) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: email(who), password: PASSWORD })
        .expect(200);
      tokens.set(who, res.body.accessToken);
    }
    return tokens.get(who)!;
  }

  async function list(who: string, query: string, status = 200) {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/inquiries${query}`)
      .set('Authorization', `Bearer ${await token(who)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body;
  }

  const names = (body: { data: Array<{ applicant: { name: string } }> }) =>
    body.data.map((i) => i.applicant.name).sort();

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const permByKey = new Map(
      (await systemPrisma.permission.findMany()).map((p: { key: string; id: string }) => [p.key, p.id]),
    );
    const mkRole = async (slug: string, keys: readonly string[]) => {
      const role = await systemPrisma.role.create({
        data: { companyId: fx.companyId, name: `${slug} ${TAG}`, slug: `${slug}-${TAG}` },
      });
      await systemPrisma.rolePermission.createMany({
        data: keys.map((k) => ({ roleId: role.id, permissionId: permByKey.get(k) })),
      });
      return role.id;
    };
    const hash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });
    const mkUser = async (who: string, roleId: string, managerId: string | null = null) =>
      (
        await systemPrisma.user.create({
          data: { companyId: fx.companyId, email: email(who), name: `User ${who}`, passwordHash: hash, roleId, managerId, forcePasswordChange: false },
        })
      ).id;

    const mgrRole = await mkRole('mgr', ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_MANAGER]);
    const repRole = await mkRole('rep', ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE]);
    const acctRole = await mkRole('acct', ROLE_PERMISSIONS[SYSTEM_ROLES.ACCOUNTS]);
    ids.mgr = await mkUser('mgr', mgrRole);
    ids.rep = await mkUser('rep', repRole, ids.mgr);
    ids.peer = await mkUser('peer', repRole); // reports to nobody
    await mkUser('acct', acctRole);

    const hot = await systemPrisma.inquiryTemperature.create({ data: { companyId: fx.companyId, name: 'Hot' } });
    const cold = await systemPrisma.inquiryTemperature.create({ data: { companyId: fx.companyId, name: 'Cold' } });
    ids.hot = hot.id;
    const project2 = await systemPrisma.project.create({
      data: { companyId: fx.companyId, name: `Second ${TAG}`, code: `S-${TAG}`, areaLocationId: (await systemPrisma.project.findUnique({ where: { id: fx.projectId } })).areaLocationId },
    });
    ids.project2 = project2.id;

    let phoneSeq = 0;
    const mk = async (
      name: string,
      opts: { owner: string; status?: string; next?: string | null; temp?: string; project?: string; email?: string; createdAt?: string },
    ) => {
      const phone = `97000${String(10000 + phoneSeq++).slice(-5)}`;
      const applicant = await systemPrisma.applicant.create({
        data: { companyId: fx.companyId, name, primaryPhone: phone, primaryPhoneNormalized: phone, email: opts.email },
      });
      const inq = await systemPrisma.inquiry.create({
        data: {
          companyId: fx.companyId,
          applicantId: applicant.id,
          assignedToId: ids[opts.owner],
          status: opts.status ?? 'OPEN',
          nextFollowupAt: opts.next ? new Date(opts.next) : null,
          temperatureId: opts.temp,
          projectId: opts.project ?? fx.projectId,
          createdAt: opts.createdAt ? new Date(opts.createdAt) : undefined,
        },
      });
      ids[name] = inq.id;
      ids[`${name}:phone`] = phone;
    };

    // Due 17:30 IST on 10 Nov: today before IST midnight, overdue after it.
    await mk('Asha Today', { owner: 'rep', next: '2026-11-10T12:00:00Z', temp: hot.id, email: 'asha@example.in', createdAt: '2026-11-01T00:00:00Z' });
    // Due 09:30 IST on 11 Nov: neither before IST midnight, today after it.
    await mk('Bala Tomorrow', { owner: 'rep', next: '2026-11-11T04:00:00Z', temp: cold.id, project: project2.id, createdAt: '2026-11-02T00:00:00Z' });
    // Due 23:50 IST on 9 Nov: overdue either side. On a UTC day boundary
    // (18:20 UTC on 10 Nov) it would count as "today" before midnight.
    await mk('Chitra Overdue', { owner: 'rep', next: '2026-11-09T18:20:00Z', status: 'CONTINUED', createdAt: '2026-11-03T00:00:00Z' });
    // Terminal: never due, whatever its date.
    await mk('Dev Dumped', { owner: 'rep', next: '2026-11-01T05:00:00Z', status: 'DUMPED', createdAt: '2026-11-04T00:00:00Z' });
    await mk('Esha Manager', { owner: 'mgr', next: null, status: 'SUCCESSFUL', createdAt: '2026-11-05T00:00:00Z' });
    // Outside the manager's team.
    await mk('Farhan Peer', { owner: 'peer', next: '2026-11-10T12:00:00Z', temp: hot.id, createdAt: '2026-11-06T00:00:00Z' });
  });

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma?.$disconnect();
  });

  it('the process clock really is UTC here', () => {
    expect(new Date('2026-11-10T18:29:00Z').getHours()).toBe(18);
  });

  describe('filters', () => {
    it('status takes one or more values', async () => {
      expect(names(await list('mgr', '?status=CONTINUED'))).toEqual(['Chitra Overdue']);
      expect(names(await list('mgr', '?status=DUMPED,SUCCESSFUL'))).toEqual(['Dev Dumped', 'Esha Manager']);
    });

    it('temperatureId and projectId', async () => {
      expect(names(await list('mgr', `?temperatureId=${ids.hot}`))).toEqual(['Asha Today']);
      expect(names(await list('mgr', `?projectId=${ids.project2}`))).toEqual(['Bala Tomorrow']);
    });

    it('filters combine', async () => {
      expect(names(await list('mgr', `?status=OPEN&projectId=${ids.project2}&temperatureId=${ids.hot}`))).toEqual([]);
      expect(names(await list('mgr', `?status=OPEN,CONTINUED&assignedToId=${ids.rep}`))).toEqual([
        'Asha Today', 'Bala Tomorrow', 'Chitra Overdue',
      ]);
    });

    it('assignedToId never widens the caller\'s team scope', async () => {
      expect(names(await list('mgr', `?assignedToId=${ids.peer}`))).toEqual([]);
      expect(names(await list('rep', `?assignedToId=${ids.peer}`))).toEqual([]);
      expect(names(await list('rep', `?assignedToId=${ids.mgr}`))).toEqual([]);
    });
  });

  describe('search', () => {
    it('matches applicant name, case-insensitively', async () => {
      expect(names(await list('mgr', '?search=chitra'))).toEqual(['Chitra Overdue']);
    });

    it('matches email', async () => {
      expect(names(await list('mgr', '?search=ASHA@EXAMPLE'))).toEqual(['Asha Today']);
    });

    it('matches phone digits, ignoring spaces and +91', async () => {
      const phone = ids['Bala Tomorrow:phone'];
      expect(names(await list('mgr', `?search=${phone.slice(-6)}`))).toEqual(['Bala Tomorrow']);
      expect(names(await list('mgr', `?search=${encodeURIComponent(`+91 ${phone.slice(0, 5)} ${phone.slice(5)}`)}`))).toEqual(['Bala Tomorrow']);
    });

    it('stays inside the team scope', async () => {
      expect(names(await list('mgr', '?search=Farhan'))).toEqual([]);
    });
  });

  describe('sort', () => {
    it('sorts by nextFollowupAt and createdAt', async () => {
      const byDue = await list('mgr', '?status=OPEN,CONTINUED&sortBy=nextFollowupAt&sortOrder=asc');
      expect(byDue.data.map((i: { applicant: { name: string } }) => i.applicant.name)).toEqual([
        'Chitra Overdue', 'Asha Today', 'Bala Tomorrow',
      ]);
      const byCreated = await list('mgr', '?sortBy=createdAt&sortOrder=desc');
      expect(byCreated.data[0].applicant.name).toBe('Esha Manager');
    });

    it.each(['status', 'passwordHash', 'applicant'])('sortBy=%s is a 400', async (col) => {
      await list('mgr', `?sortBy=${col}`, 400);
    });
  });

  describe('validation and permission', () => {
    it.each(['?stageId=x', '?status=LOST', '?followUp=later', '?projectId=nope', '?search=a'])('%s is a 400', async (q) => {
      await list('mgr', q, 400);
    });

    it('a role without presales.inquiry.read gets 403', async () => {
      await list('acct', '', 403);
    });
  });

  describe('IST day boundary, with the process on UTC', () => {
    async function dashboard(who: string) {
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboard')
        .set('Authorization', `Bearer ${await token(who)}`)
        .expect(200);
      return res.body;
    }
    async function myDay(who: string) {
      const res = await request(app.getHttpServer())
        .get('/api/v1/inquiries/my-day')
        .set('Authorization', `Bearer ${await token(who)}`)
        .expect(200);
      return res.body.map((i: { applicant: { name: string } }) => i.applicant.name).sort();
    }

    it('at 23:59 IST (18:29 UTC): list, dashboard and My Day agree', async () => {
      clock.current = BEFORE_IST_MIDNIGHT;
      expect(names(await list('rep', '?followUp=today'))).toEqual(['Asha Today']);
      expect(names(await list('rep', '?followUp=overdue'))).toEqual(['Chitra Overdue']);
      const d = await dashboard('rep');
      expect([d.mine.followUpsToday, d.mine.followUpsOverdue]).toEqual([1, 1]);
      expect(await myDay('rep')).toEqual(['Asha Today', 'Chitra Overdue']);
      const team = await dashboard('mgr');
      expect([team.team.followUpsToday, team.team.followUpsOverdue]).toEqual([1, 1]);
      const repRow = team.team.perReport.find((r: { userId: string }) => r.userId === ids.rep);
      expect([repRow.followUpsToday, repRow.followUpsOverdue]).toEqual([1, 1]);
    });

    it('at 00:01 IST (18:31 UTC): the new IST day has begun everywhere', async () => {
      clock.current = AFTER_IST_MIDNIGHT;
      expect(names(await list('rep', '?followUp=today'))).toEqual(['Bala Tomorrow']);
      expect(names(await list('rep', '?followUp=overdue'))).toEqual(['Asha Today', 'Chitra Overdue']);
      const d = await dashboard('rep');
      expect([d.mine.followUpsToday, d.mine.followUpsOverdue]).toEqual([1, 2]);
      expect(await myDay('rep')).toEqual(['Asha Today', 'Bala Tomorrow', 'Chitra Overdue']);
      const team = await dashboard('mgr');
      const repRow = team.team.perReport.find((r: { userId: string }) => r.userId === ids.rep);
      expect([repRow.followUpsToday, repRow.followUpsOverdue]).toEqual([1, 2]);
    });

    it('terminal statuses are never due', async () => {
      clock.current = AFTER_IST_MIDNIGHT;
      const both = [...names(await list('mgr', '?followUp=today')), ...names(await list('mgr', '?followUp=overdue'))];
      expect(both).not.toContain('Dev Dumped');
    });
  });
});
