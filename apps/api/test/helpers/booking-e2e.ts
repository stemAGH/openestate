/**
 * Shared through-the-wire setup for the booking tests: the compiled app,
 * a staff user holding exactly the permissions a test asks for, and
 * `bookLikeTheWizard`, which sends the same requests the booking wizard
 * sends. Requires the compiled dist/ (rebuild apps/api first).
 */
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS } from '@openestate/shared';

export const STAFF_PASSWORD = 'StaffPass123';

// main.ts patches this; e2e files bootstrap AppModule directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

export async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  process.env.DATABASE_URL_SYSTEM = process.env.DATABASE_URL_TEST_SYSTEM;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
  process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
  process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
  process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
  process.env.CORS_ALLOWLIST ??= 'http://localhost:5174';
  process.env.SWAGGER_ENABLED = 'false';
  const require = createRequire(import.meta.url);
  const { AppModule } = require('../../dist/app.module');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  return app;
}

let userSeq = 0;
/** A staff user in `companyId` whose role holds exactly `keys`; returns the email. */
export async function makeStaff(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  companyId: string,
  keys: string[],
): Promise<string> {
  for (const key of ALL_PERMISSIONS) {
    await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  const perms = await systemPrisma.permission.findMany({ where: { key: { in: keys } } });
  const tag = `${Date.now()}-${userSeq++}-${Math.random().toString(36).slice(2, 8)}`;
  const role = await systemPrisma.role.create({
    data: { companyId, name: `bk-${tag}`, slug: `bk-${tag}`, isSystem: false },
  });
  if (perms.length) {
    await systemPrisma.rolePermission.createMany({
      data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })),
    });
  }
  const email = `bk-${tag}@test.com`;
  await systemPrisma.user.create({
    data: {
      companyId,
      email,
      name: 'Booking test',
      roleId: role.id,
      forcePasswordChange: false,
      passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
    },
  });
  return email;
}

export interface Session {
  agent: ReturnType<typeof request.agent>;
  auth: Record<string, string>;
}

export async function login(app: INestApplication, email: string): Promise<Session> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const csrf = cookies.map((c) => /openestate_csrf=([^;]+)/.exec(c)?.[1]).find(Boolean);
  if (!csrf) throw new Error('no CSRF cookie');
  return { agent, auth: { Authorization: `Bearer ${res.body.accessToken}`, 'X-CSRF-Token': csrf } };
}

export interface WizardInput {
  unitId: string;
  primaryApplicantId: string;
  bookingDate: string;
  basePricePaise: bigint;
  gstRateId: string;
  installments: Array<{ label: string; dueDate: string; amountPaise: bigint }>;
}

export function costLinesFor(input: WizardInput) {
  return [
    { kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: input.basePricePaise.toString(), gstRateId: input.gstRateId },
  ];
}

/**
 * The request the booking wizard sends for a custom plan: one POST
 * /bookings/with-plan (the booking and its plan in one transaction).
 * Returns its status and body.
 */
export async function bookLikeTheWizard(
  s: Session,
  input: WizardInput,
): Promise<{ status: number; body: { id?: string; message?: string } }> {
  const res = await s.agent
    .post('/api/v1/bookings/with-plan')
    .set(s.auth)
    .send({
      unitId: input.unitId,
      primaryApplicantId: input.primaryApplicantId,
      coApplicantIds: [],
      bookingDate: input.bookingDate,
      costLines: costLinesFor(input),
      plan: {
        mode: 'custom',
        name: 'Custom Plan',
        installments: input.installments.map((i) => ({ ...i, amountPaise: i.amountPaise.toString() })),
      },
    });
  return { status: res.status, body: res.status === 201 ? { id: res.body.booking.id } : res.body };
}
