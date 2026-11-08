import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES, istDayBounds } from '@openestate/shared';

/**
 * Seeds a three-person org chart plus enough inquiry data for the
 * dashboard to have real numbers:
 *
 *   manager
 *     └── rep          (reports to manager)
 *   peer               (reports to nobody — the negative control)
 *
 * The peer exists specifically so a scoping test can prove the manager
 * does NOT see them. Users are created directly (hashed here) rather than
 * through the Add User form: these specs are about the dashboard and
 * hierarchy screens, not about user creation, and the form path costs
 * several seconds per user.
 *
 * Everything is tag-suffixed because specs share one fixture company and
 * run at `workers: 4` — an unanchored name match against another spec's
 * row is a real failure mode this suite has already hit once.
 */

export interface OrgChart {
  password: string;
  managerEmail: string;
  managerName: string;
  repEmail: string;
  repName: string;
  peerEmail: string;
  peerName: string;
}

export async function seedOrgChart(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  companyId: string,
): Promise<OrgChart> {
  // The tag is generated HERE, not passed in: two spec files each doing
  // `Date.now()` can land on the same millisecond under `workers: 4` and
  // collide on the unique role slug. The random suffix makes that
  // impossible rather than merely unlikely.
  const tag = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const password = 'OrgChartPass123';

  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  const allPerms = await prisma.permission.findMany();
  const permByKey = new Map<string, string>(
    allPerms.map((p: { key: string; id: string }) => [p.key, p.id]),
  );

  const roleWith = async (name: string, slug: string, keys: readonly string[]) => {
    const role = await prisma.role.create({
      data: { companyId, name, slug, isSystem: false },
    });
    await prisma.rolePermission.createMany({
      data: keys
        .map((k) => permByKey.get(k))
        .filter((id): id is string => !!id)
        .map((permissionId) => ({ roleId: role.id, permissionId })),
    });
    return role;
  };

  const managerRole = await roleWith(
    `E2E OrgMgr ${tag}`,
    `e2e-org-mgr-${tag}`,
    ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_MANAGER],
  );
  const repRole = await roleWith(
    `E2E OrgRep ${tag}`,
    `e2e-org-rep-${tag}`,
    ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE],
  );

  const passwordHash = await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id });
  const mkUser = async (email: string, name: string, roleId: string) =>
    prisma.user.create({
      data: { companyId, email, passwordHash, name, roleId, forcePasswordChange: false },
    });

  const managerName = `E2E OrgChart Manager ${tag}`;
  const repName = `E2E OrgChart Rep ${tag}`;
  const peerName = `E2E OrgChart Peer ${tag}`;
  const managerEmail = `e2e-org-mgr-${tag}@test.com`;
  const repEmail = `e2e-org-rep-${tag}@test.com`;
  const peerEmail = `e2e-org-peer-${tag}@test.com`;

  const manager = await mkUser(managerEmail, managerName, managerRole.id);
  const rep = await mkUser(repEmail, repName, repRole.id);
  const peer = await mkUser(peerEmail, peerName, repRole.id);

  await prisma.user.update({ where: { id: rep.id }, data: { managerId: manager.id } });

  // Inquiry data: one due today and one overdue for the rep, plus one for
  // the peer that must never show up in the manager's figures.
  // Noon on the IST calendar day ("due today" is an IST day).
  const today = new Date(istDayBounds(new Date()).startOfToday.getTime() + 12 * 3_600_000);
  const overdue = new Date(Date.now() - 3 * 86_400_000);

  let seq = 0;
  const mkInquiry = async (assignedToId: string, nextFollowupAt: Date) => {
    // Digits only, and independent of `tag` (which now carries letters) —
    // a phone doubles as a portal login identifier and must stay unique.
    const phone = `9${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 900) + 100)}`.slice(0, 10);
    const applicant = await prisma.applicant.create({
      data: {
        companyId,
        name: `E2E OrgChart Applicant ${tag}-${seq}`,
        primaryPhone: phone,
        primaryPhoneNormalized: phone,
      },
    });
    await prisma.inquiry.create({
      data: {
        companyId,
        applicantId: applicant.id,
        assignedToId,
        status: 'OPEN',
        nextFollowupAt,
      },
    });
  };

  await mkInquiry(rep.id, today);
  await mkInquiry(rep.id, overdue);
  await mkInquiry(peer.id, today);

  return { password, managerEmail, managerName, repEmail, repName, peerEmail, peerName };
}
