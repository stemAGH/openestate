/**
 * Upgrade-time read-only report (printed by packages/db/prisma/sync-permissions.ts):
 * crossCompanyReferences counts stored references from a company's rows to
 * another company's rows, per company and column. Nothing is changed. Scoped
 * to this file's companies, because other test files run concurrently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeClients, seedCompany, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { crossCompanyReferences } from '../../../packages/db/prisma/sync-permissions';

const describeIf =
  process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

describeIf('upgrade report: stored references to another company’s rows', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let A: CompanyFixture;
  let B: CompanyFixture;

  beforeAll(async () => {
    ({ systemPrisma, tenantPrisma } = makeClients());
    A = await seedCompany(systemPrisma);
    B = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    // A's row points at B's project, so A goes first.
    await cleanupCompany(systemPrisma, A.companyId);
    await cleanupCompany(systemPrisma, B.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('reports none for a company whose references are all its own', async () => {
    await systemPrisma.inquiry.create({
      data: { companyId: A.companyId, applicantId: await makeApplicant(systemPrisma, A.companyId), projectId: A.projectId, status: 'OPEN' },
    });
    expect(await crossCompanyReferences(systemPrisma, { companyId: A.companyId })).toEqual([]);
  });

  it('counts a stored reference to another company’s row, per company and column, and changes nothing', async () => {
    // As an older release could have stored it: company A's inquiry naming company B's project.
    const inq = await systemPrisma.inquiry.create({
      data: { companyId: A.companyId, applicantId: await makeApplicant(systemPrisma, A.companyId), projectId: B.projectId, status: 'OPEN' },
    });
    const rows = await crossCompanyReferences(systemPrisma, { companyId: A.companyId });
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(A.companyId);
    expect(rows[0].count).toBe(1);
    expect(rows[0].columns).toEqual([{ column: 'inquiries.project_id', count: 1 }]);
    // Read-only: the row is untouched.
    expect((await systemPrisma.inquiry.findUnique({ where: { id: inq.id } })).projectId).toBe(B.projectId);
    // Company B's own rows point only at its own rows.
    expect(await crossCompanyReferences(systemPrisma, { companyId: B.companyId })).toEqual([]);
  });
});
