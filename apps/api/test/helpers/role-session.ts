/**
 * A staff session holding exactly the given permissions, for permission and
 * scope tests: `send` makes an authenticated request as that user.
 */
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS } from '@openestate/shared';

export type Send = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, body?: unknown) => request.Test;

export async function sessionWith(
  app: INestApplication,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any,
  companyId: string,
  permissions: readonly string[],
  tag: string,
  opts: { managerId?: string } = {},
): Promise<{ send: Send; userId: string }> {
  for (const key of ALL_PERMISSIONS) await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  const perms = await systemPrisma.permission.findMany({ where: { key: { in: [...permissions] } } });
  const role = await systemPrisma.role.create({ data: { companyId, name: `Role ${tag}`, slug: `role-${tag}` } });
  if (perms.length) {
    await systemPrisma.rolePermission.createMany({ data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })) });
  }
  const email = `e2e-${tag}@test.com`;
  const password = 'StaffPass123';
  const passwordHash = await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id });
  const user = await systemPrisma.user.create({
    data: { companyId, email, name: `User ${tag}`, passwordHash, roleId: role.id, forcePasswordChange: false, managerId: opts.managerId ?? null },
  });
  const agent = request.agent(app.getHttpServer());
  const login = await agent.post('/api/v1/auth/login').send({ email, password });
  if (login.status !== 200) throw new Error(`login ${login.status}: ${JSON.stringify(login.body)}`);
  const token = login.body.accessToken;
  const csrf = /openestate_csrf=([^;]+)/.exec(([] as string[]).concat(login.headers['set-cookie'] ?? []).join(';'))![1];
  const send: Send = (method, url, body) => {
    const r = agent[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`).set('X-CSRF-Token', csrf);
    return body === undefined ? r : r.send(body as object);
  };
  return { send, userId: user.id };
}
