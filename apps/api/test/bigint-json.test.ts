import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import type { PrismaClient } from '@openestate/db';
import {
  cleanupCompany,
  makeApplicant,
  makeUnit,
  seedCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

it('serializes decimal paise exactly, including values above Number.MAX_SAFE_INTEGER', () => {
  expect(JSON.stringify({ positive: 9007199254740993n, negative: -9007199254740993n, zero: 0n }))
    .toBe('{"positive":"9007199254740993","negative":"-9007199254740993","zero":"0"}');
});

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';

describe.skipIf(!APP_URL || !SYSTEM_URL)('BigInt result under the integration bootstrap', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let events: QueueEvents;
  let fx: CompanyFixture;

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;
    process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
    process.env.REDIS_URL = REDIS_URL;
    process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
    process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
    process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
    process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
    process.env.SWAGGER_ENABLED = 'false';
    const require = createRequire(import.meta.url);
    const { AppModule } = require('../dist/app.module');
    app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    await app.init();
    prisma = app.get<PrismaClient>('SYSTEM_PRISMA');
    const queue = app.get<Queue>(getQueueToken('interest'));
    events = new QueueEvents(queue.name, { connection: queue.opts.connection });
    await events.waitUntilReady();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await events?.close();
    if (fx) await cleanupCompany(prisma, fx.companyId);
  });

  it('completes a real company-accrual job and stores its BigInt result as a string', async () => {
    fx = await seedCompany(prisma);
    const unitId = await makeUnit(prisma, fx);
    const primaryApplicantId = await makeApplicant(prisma, fx.companyId);
    const rule = await prisma.interestRule.create({
      data: { companyId: fx.companyId, name: 'Serialization fixture', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    });
    // No installments: the real processor returns 0n without posting financial entries.
    const booking = await prisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId,
        primaryApplicantId,
        bookingNumber: 'BIGINT-JSON',
        status: 'BOOKED',
        agreedPricePaise: 9007199254740993n,
        bookingDate: new Date('2026-01-01'),
        interestRuleId: rule.id,
        createdById: fx.userId,
      },
    });
    expect(JSON.stringify({ agreedPricePaise: booking.agreedPricePaise }))
      .toBe('{"agreedPricePaise":"9007199254740993"}');
    const queue = app.get<Queue>(getQueueToken('interest'));
    const job = await queue.add('company-accrual', { companyId: fx.companyId }, {
      jobId: `bigint-json-${randomUUID()}`,
      removeOnComplete: false,
      removeOnFail: false,
    });
    expect(await job.waitUntilFinished(events, 15_000)).toEqual([
      { bookingId: booking.id, postedPaise: '0', installmentsAccrued: 0 },
    ]);
    expect(await job.getState()).toBe('completed');
    expect((await queue.getJob(job.id!))?.returnvalue).toEqual([
      { bookingId: booking.id, postedPaise: '0', installmentsAccrued: 0 },
    ]);
    expect(await prisma.ledgerEntry.count({ where: { companyId: fx.companyId } })).toBe(0);
  }, 30_000);
});
