/**
 * v0.7.1 regression tests for the audit extension.
 *
 * Found in v0.8.0 work: a `withTenantTx` callback that RETURNS a Prisma
 * query without awaiting it — `(tx) => tx.model.create(...)` — wrote no
 * audit row. A Prisma query is a lazy thenable; it only ran after
 * `tenantTxContext.run()` had already exited, so the audit hook found no
 * transaction in context and silently returned. 53 write call sites in
 * apps/api used that form. Separately, a bare `runWithTenant({ companyId
 * })` shadowed the request's userId and IP, so rows that were written had
 * no actor.
 *
 * Requires DATABASE_URL_TEST / DATABASE_URL_TEST_SYSTEM; skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createTenantPrismaClient,
  createSystemPrismaClient,
  withTenantTx,
  runWithTenant,
  tenantTxContext,
} from '../src/index';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describeIf('audit extension', () => {
  let systemPrisma: PrismaClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let companyId: string;
  let otherCompanyId: string;
  let userId: string;
  let seq = 0;
  const tag = Date.now();

  beforeAll(async () => {
    systemPrisma = createSystemPrismaClient(SYSTEM_URL!);
    tenantPrisma = createTenantPrismaClient(APP_URL!);
    companyId = (await systemPrisma.company.create({ data: { name: `Audit ${tag}`, slug: `audit-${tag}` } })).id;
    otherCompanyId = (await systemPrisma.company.create({ data: { name: `Audit B ${tag}`, slug: `audit-b-${tag}` } })).id;
    const role = await systemPrisma.role.create({ data: { companyId, name: 'r', slug: `r-${tag}` } });
    userId = (
      await systemPrisma.user.create({
        data: { companyId, email: `audit-${tag}@test`, name: 'Auditor', passwordHash: 'x', roleId: role.id },
      })
    ).id;
  });

  afterAll(async () => {
    const ids = [companyId, otherCompanyId];
    await systemPrisma.auditLog.deleteMany({ where: { companyId: { in: ids } } });
    await systemPrisma.customFieldDefinition.deleteMany({ where: { companyId: { in: ids } } });
    await systemPrisma.tdsRule.deleteMany({ where: { companyId: { in: ids } } });
    await systemPrisma.user.deleteMany({ where: { companyId: { in: ids } } });
    await systemPrisma.role.deleteMany({ where: { companyId: { in: ids } } });
    await deleteCompaniesSafely(systemPrisma, ids);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  const fieldData = (cid: string) => ({
    companyId: cid,
    entityType: 'APPLICANT',
    key: `k_${tag}_${seq++}`,
    label: 'L',
    fieldType: 'TEXT',
  });
  const rowsFor = (entityId: string) =>
    systemPrisma.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

  it('a concise callback that returns the query un-awaited writes an audit row', async () => {
    const created = await runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx as any).customFieldDefinition.create({ data: fieldData(companyId) }),
      ),
    );
    const rows = await rowsFor(created.id);
    expect(rows.map((r) => r.action)).toEqual(['CREATE']);
  });

  it('an async callback writes an audit row (already worked; guards against regressions)', async () => {
    const created = await runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (tx as any).customFieldDefinition.create({ data: fieldData(companyId) });
      }),
    );
    expect((await rowsFor(created.id)).map((r) => r.action)).toEqual(['CREATE']);
  });

  it('a concise callback on the nested-reuse branch writes an audit row', async () => {
    const created = await runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, async () =>
        withTenantTx(tenantPrisma, companyId, (tx) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tx as any).customFieldDefinition.create({ data: fieldData(companyId) }),
        ),
      ),
    );
    expect((await rowsFor(created.id)).map((r) => r.action)).toEqual(['CREATE']);
  });

  it("a service's bare runWithTenant({ companyId }) keeps the request's actor and IP", async () => {
    // Outer store: what TenantContextInterceptor sets for a staff request.
    const created = await runWithTenant({ companyId, userId, ipAddress: '203.0.113.7' }, () =>
      // Inner: what almost every service does.
      runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, async (tx) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return await (tx as any).customFieldDefinition.create({ data: fieldData(companyId) });
        }),
      ),
    );
    const [row] = await rowsFor(created.id);
    expect(row.userId).toBe(userId);
    expect(row.ipAddress).toBe('203.0.113.7');
  });

  it('the actor is NOT inherited across companies', async () => {
    const created = await runWithTenant({ companyId, userId, ipAddress: '203.0.113.7' }, () =>
      runWithTenant({ companyId: otherCompanyId }, () =>
        withTenantTx(tenantPrisma, otherCompanyId, async (tx) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return await (tx as any).customFieldDefinition.create({ data: fieldData(otherCompanyId) });
        }),
      ),
    );
    const [row] = await rowsFor(created.id);
    expect(row.userId).toBeNull();
    expect(row.ipAddress).toBeNull();
  });

  it('an explicit actor on the inner store is kept, not overwritten by the ambient one', async () => {
    const created = await runWithTenant({ companyId, userId: undefined, ipAddress: '203.0.113.7' }, () =>
      runWithTenant({ companyId, userId, ipAddress: '198.51.100.9' }, () =>
        withTenantTx(tenantPrisma, companyId, async (tx) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return await (tx as any).customFieldDefinition.create({ data: fieldData(companyId) });
        }),
      ),
    );
    const [row] = await rowsFor(created.id);
    expect(row.userId).toBe(userId);
    expect(row.ipAddress).toBe('198.51.100.9');
  });

  it('the portal guardrail still refuses to widen a portal scope', () => {
    expect(() =>
      runWithTenant({ companyId, userId, portalApplicantId: '00000000-0000-4000-8000-000000000001' }, () =>
        runWithTenant({ companyId }, () => 1),
      ),
    ).toThrow(/refusing to widen an active portal scope/);
  });

  it('a business write that rolls back leaves no audit row behind', async () => {
    const data = fieldData(companyId);
    await expect(
      runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, async (tx) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (tx as any).customFieldDefinition.create({ data });
          throw new Error('business rule failed after the write');
        }),
      ),
    ).rejects.toThrow('business rule failed');
    expect(await systemPrisma.customFieldDefinition.count({ where: { companyId, key: data.key } })).toBe(0);
    expect(await systemPrisma.auditLog.count({ where: { companyId, entityType: 'CustomFieldDefinition', after: { path: ['key'], equals: data.key } } })).toBe(0);
  });

  it('a failed audit INSERT rolls the business write back and is logged (fail-closed), naming no field values', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = fieldData(companyId);
    try {
      // A userId with no users row: the audit INSERT fails its foreign key.
      await expect(
        runWithTenant({ companyId, userId: '00000000-0000-4000-8000-00000000dead' }, () =>
          withTenantTx(tenantPrisma, companyId, async (tx) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await (tx as any).customFieldDefinition.create({ data });
          }),
        ),
      ).rejects.toThrow();
      expect(await systemPrisma.customFieldDefinition.count({ where: { companyId, key: data.key } })).toBe(0);
      const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toMatch(/\[audit\].*CustomFieldDefinition.*CREATE/);
      expect(logged).not.toContain(data.key);
    } finally {
      spy.mockRestore();
    }
  });

  it('a write with no transaction in context is logged, not silently skipped', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const created = await runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, async (tx) =>
          // exit() hides the transaction store: the same state the
          // un-awaited-query bug produced. The write itself still runs in
          // the transaction.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tenantTxContext.exit(async () => await (tx as any).customFieldDefinition.create({ data: fieldData(companyId) })),
        ),
      );
      const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toMatch(new RegExp(`\\[audit\\].*CustomFieldDefinition.*CREATE.*${created.id}`));
      expect(logged).not.toContain(created.key);
    } finally {
      spy.mockRestore();
    }
  });

  it('BigInt values serialize without a global BigInt.prototype.toJSON patch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = BigInt.prototype as any;
    const saved = proto.toJSON;
    delete proto.toJSON;
    try {
      const rule = await runWithTenant({ companyId }, () =>
        withTenantTx(tenantPrisma, companyId, async (tx) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return await (tx as any).tdsRule.create({
            data: { companyId, section: `T${seq++}`, ratePercent: 1, thresholdPaise: 5_000_000_00n, effectiveFrom: new Date('2020-01-01') },
          });
        }),
      );
      const [row] = await rowsFor(rule.id);
      expect(row?.after).toMatchObject({ thresholdPaise: '500000000' });
      // A Prisma.Decimal survives the recursive sanitizer as its own
      // string form, not as the object's internal fields.
      expect((row?.after as Record<string, unknown>).ratePercent).toBe('1');
      expect((row?.after as Record<string, unknown>).effectiveFrom).toBe('2020-01-01T00:00:00.000Z');
    } finally {
      if (saved) proto.toJSON = saved;
    }
  });

  it('a secret nested inside a write input is redacted, not written to the audit row', async () => {
    // Nested inputs aren't used by any audited call site today; the
    // sanitizer must not depend on that staying true.
    const created = await runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = await (tx as any).customFieldDefinition.create({ data: fieldData(companyId) });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (tx as any).customFieldDefinition.update({
          where: { id: d.id },
          data: { options: { nested: { passwordHash: 'must-not-appear', keep: 'ok' } } },
        });
        return d;
      }),
    );
    const rows = await rowsFor(created.id);
    const update = rows.find((r) => r.action === 'UPDATE');
    expect(JSON.stringify(update?.after)).not.toContain('must-not-appear');
    expect(JSON.stringify(update?.after)).toContain('"keep":"ok"');
  });

  // v0.10.1: UPDATE rows record the previous values of the fields written.
  it('an UPDATE row records the previous values of exactly the fields written', async () => {
    const created = await runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = await (tx as any).customFieldDefinition.create({ data: { ...fieldData(companyId), label: 'Old label' } });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (tx as any).customFieldDefinition.update({ where: { id: d.id }, data: { label: 'New label', isRequired: true } });
        return d;
      }),
    );
    const update = (await rowsFor(created.id)).find((r) => r.action === 'UPDATE');
    expect(update?.before).toEqual({ label: 'Old label', isRequired: false });
    expect(update?.after).toMatchObject({ label: 'New label', isRequired: true });
  });

  it('a secret in the previous values is redacted, as in the new values', async () => {
    await runWithTenant({ companyId }, () =>
      withTenantTx(tenantPrisma, companyId, async (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx as any).user.update({ where: { id: userId }, data: { passwordHash: 'new-hash-must-not-appear' } }),
      ),
    );
    const update = (await rowsFor(userId)).filter((r) => r.action === 'UPDATE').pop();
    expect(update?.before).toEqual({ passwordHash: '[REDACTED]' });
    expect(JSON.stringify(update)).not.toContain('new-hash-must-not-appear');
  });
});
