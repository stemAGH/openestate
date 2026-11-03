import { PrismaClient, Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLES, DEFAULT_LEAD_STAGES, ROLE_PERMISSIONS } from '@openestate/shared';

/**
 * True when `err` is Prisma's foreign-key-violation error (P2003). Both
 * sync functions below list entities (companies, super_admin roles) up
 * front, then write for each one individually — if something else deletes
 * that entity between the list and the write, the write fails this way.
 * In production this is effectively impossible (companies are never
 * hard-deleted through the app); it's a real race in this monorepo's
 * shared test database, where sibling test files create and tear down
 * their own companies concurrently with these two functions' deliberately
 * unscoped, whole-table scans. Either way, one vanished entity should
 * skip itself, not abort the sync for every entity after it — but the
 * skip must be LOUD, not silent. A silently-skipped super_admin sync is
 * close to the exact pre-pilot bug this file's own doc comments already
 * describe (a company's super_admin quietly missing permissions, with no
 * error to explain why) — the caller here is a routine upgrade run,
 * exactly the place that bug hid for four releases. Both functions below
 * log every skip with the company id, so it can't hide inside a normal
 * run's output.
 */
function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

const prisma = new PrismaClient();

/**
 * Adds any PERMISSIONS constant that doesn't have a row yet — nothing
 * else. Safe to run on every upgrade of an EXISTING install, unlike the
 * rest of seed.ts:
 *
 *  - Permission has exactly two columns (id, key) and no company scope —
 *    there is nothing about a permission an admin could have customised,
 *    so upserting is unconditionally safe, on a fresh install or the
 *    thousandth upgrade of an old one.
 *  - Deliberately NOT extended to seeded masters, nor to the
 *    role_permissions of any role EXCEPT super_admin and portal roles
 *    (see the two functions below). Both
 *    are per-company data an admin may have already renamed, deactivated,
 *    or reassigned — silently injecting new rows into every existing
 *    company's live master/role lists on every upgrade would be a real
 *    correctness bug of its own, not a fix. A future release that adds a
 *    new default master type needs a deliberate, opt-in per-company
 *    decision, not an automatic sync here.
 *
 * Exists as its own script (seed.ts imports and calls it, not a
 * duplicate copy) because seed.ts's OWN permission-upsert loop is
 * unreachable on any install that already has a company — which is
 * every real install after its first boot — so seed.ts alone never
 * delivers a later release's new PERMISSIONS constants to an existing
 * install. See CLAUDE.md's v0.2.0 upgrade-path entry for the bug this
 * fixes: a release that adds a permission and ships a UI gated on it
 * upgrades cleanly and heals nothing — no role can be granted a
 * permission row that was never inserted.
 */
export async function syncPermissions(client: PrismaClient = prisma): Promise<number> {
  let added = 0;
  for (const key of ALL_PERMISSIONS) {
    const before = await client.permission.findUnique({ where: { key } });
    if (!before) added++;
    await client.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  return added;
}

/**
 * Grants any permission super_admin is missing, for every company.
 *
 * This is the ONE role whose role_permissions this script touches, and
 * the exception is narrow on purpose. `ROLE_PERMISSIONS.super_admin` is
 * literally `Object.values(PERMISSIONS)` (packages/shared/src/roles.ts)
 * — "every permission that exists" IS its definition, not a default
 * someone picked. So a super_admin missing a key isn't a customisation
 * to respect, it's drift from its own contract.
 *
 * Found on a real v0.1.2 -> v0.2.3 upgrade: `permissions` had all 142
 * rows (this script's original job worked), but super_admin on
 * pre-existing companies still had only 140 — missing exactly the two
 * v0.2.0 added (`inventory.unit.plc-manage`/`charge-manage`). The PLC
 * pricing UI those gate was therefore unreachable for every company
 * that existed before that release, on every upgraded install, with no
 * error to explain why. Adding a permission and shipping a UI gated on
 * it silently did nothing for the most privileged role in the product.
 *
 * Every OTHER role (company_admin, sales_manager, custom roles) is
 * still deliberately untouched — those are genuine composition choices
 * an admin may have narrowed, and an upgrade must not widen them. An
 * admin grants new permissions to those through the Roles UI, which
 * v0.2.0 unblocked (see CLAUDE.md's RolesService.update fix).
 */
export async function syncSuperAdminPermissions(
  client: PrismaClient = prisma,
): Promise<{ granted: number; skipped: number }> {
  const roles = await client.role.findMany({
    where: { slug: SYSTEM_ROLES.SUPER_ADMIN },
    select: { id: true, companyId: true },
  });
  if (roles.length === 0) return { granted: 0, skipped: 0 };

  const permissions = await client.permission.findMany({ select: { id: true, key: true } });
  let granted = 0;
  let skipped = 0;

  for (const role of roles) {
    try {
      const existing = await client.rolePermission.findMany({
        where: { roleId: role.id },
        select: { permissionId: true },
      });
      const have = new Set(existing.map((rp) => rp.permissionId));
      const missing = permissions.filter((p) => !have.has(p.id));
      if (missing.length === 0) continue;

      await client.rolePermission.createMany({
        data: missing.map((p) => ({ roleId: role.id, permissionId: p.id })),
        skipDuplicates: true,
      });
      // The role's permissions changed, so its users' existing tokens (which
      // carry the old list) must end: same rule as an edit in the Roles screen.
      // This script cannot reach the API's Redis cache; the cached version
      // expires within 60 s (AUTHZ_VERSION_TTL_SECONDS), and the API restarts
      // after an upgrade anyway.
      await client.$executeRaw`UPDATE users SET authz_version = authz_version + 1 WHERE role_id = ${role.id}::uuid`;
      granted += missing.length;
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        skipped++;
        console.error(
          `syncSuperAdminPermissions: SKIPPED company ${role.companyId} (super_admin role ${role.id}) — ` +
            `it vanished mid-sync, so its super_admin's permissions were NOT verified or repaired this run. ` +
            `Re-run the sync once the company's expected state is confirmed.`,
        );
        continue;
      }
      throw err;
    }
  }

  if (skipped > 0) {
    console.error(
      `syncSuperAdminPermissions: SKIPPED ${skipped} of ${roles.length} compan${roles.length === 1 ? 'y' : 'ies'} ` +
        `— see the per-company warnings above. This is NOT expected in production; do not treat this run's ` +
        `"already complete" result as covering those companies.`,
    );
  }

  return { granted, skipped };
}

/**
 * Seeds the default 6-stage pipeline for any company that has never had
 * one — gated by CompanyConfig.leadStagesSeededAt, a one-time marker,
 * NOT by "does this company currently have zero LeadStage rows."
 *
 * Row count alone can't distinguish "never seeded" from "an admin
 * deleted all six after a real seeding" — inferring from count would
 * resurrect a deliberate deletion on the very next upgrade, the exact
 * class of bug this project has already been burned by for seeded
 * masters (see the sync-permissions module doc comment above). A
 * brand-new master TYPE with zero rows is a genuinely different case
 * from a brand-new ROW in an existing master's list — there is no
 * "admin already customised this" risk the first time a company sees
 * this table at all — but only the FIRST time; the marker is what
 * keeps this function honest on every run after that.
 *
 * Called from two places: seed.ts, for the single company a fresh
 * install creates; this file's own CLI entrypoint below, for every
 * existing company on an upgrade. Same function either way — not a
 * duplicate copy, matching syncPermissions' own precedent.
 */
export async function syncLeadStages(
  client: PrismaClient = prisma,
  // For tests only: the upgrade runs it unscoped. In the shared test database
  // an unscoped call reaches other test files' companies mid-cleanup.
  scope: { companyId?: string } = {},
): Promise<{ seeded: number; skipped: number }> {
  const companies = await client.company.findMany({
    where: scope.companyId ? { id: scope.companyId } : {},
    select: {
      id: true,
      config: { select: { leadStagesSeededAt: true } },
    },
  });

  let seededCompanies = 0;
  let skipped = 0;
  for (const company of companies) {
    if (company.config?.leadStagesSeededAt) continue;

    try {
      await client.$transaction(async (tx) => {
        const stages = await Promise.all(
          DEFAULT_LEAD_STAGES.map((name, i) =>
            tx.leadStage.create({
              data: { companyId: company.id, name, sortOrder: i, isDefault: i === 0 },
            }),
          ),
        );
        await tx.companyConfig.upsert({
          where: { companyId: company.id },
          update: { leadStagesSeededAt: new Date() },
          create: { companyId: company.id, leadStagesSeededAt: new Date() },
        });
        return stages;
      });
      seededCompanies++;
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        skipped++;
        console.warn(`syncLeadStages: skipped company ${company.id} — it vanished mid-sync.`);
        continue;
      }
      throw err;
    }
  }

  if (skipped > 0) {
    console.warn(`syncLeadStages: skipped ${skipped} compan${skipped === 1 ? 'y' : 'ies'} that vanished mid-sync.`);
  }

  return { seeded: seededCompanies, skipped };
}

/**
 * Removes every permission that doesn't start with `portal.` from every
 * portal role (isPortal), including grants an admin made on purpose.
 *
 * The second narrow exception to "never touch role composition", on the
 * same grounds as super_admin: a portal role is defined as holding portal
 * permissions only, so a staff grant on one is drift, not a customisation.
 * The Roles API refuses such grants; this clears any made before it did.
 *
 * Each affected role gets one audit row (no actor: the upgrade did it)
 * listing the keys removed, written in the same transaction as the delete.
 * `scope.companyId` exists for tests; the upgrade runs it unscoped.
 */
export async function stripStaffPermissionsFromPortalRoles(
  client: PrismaClient = prisma,
  scope: { companyId?: string } = {},
): Promise<{ removed: number; roles: number }> {
  const grants = await client.rolePermission.findMany({
    where: {
      role: { isPortal: true, ...(scope.companyId ? { companyId: scope.companyId } : {}) },
      NOT: { permission: { key: { startsWith: 'portal.' } } },
    },
    select: {
      roleId: true,
      permissionId: true,
      permission: { select: { key: true } },
      role: { select: { companyId: true, slug: true } },
    },
  });

  const byRole = new Map<string, typeof grants>();
  for (const g of grants) byRole.set(g.roleId, [...(byRole.get(g.roleId) ?? []), g]);

  let removed = 0;
  for (const [roleId, roleGrants] of byRole) {
    const { companyId, slug } = roleGrants[0].role;
    const keys = roleGrants.map((g) => g.permission.key).sort();
    const [deleted] = await client.$transaction([
      client.rolePermission.deleteMany({
        where: { roleId, permissionId: { in: roleGrants.map((g) => g.permissionId) } },
      }),
      // Ends the existing sessions of the role's users (see syncSuperAdminPermissions).
      client.$executeRaw`UPDATE users SET authz_version = authz_version + 1 WHERE role_id = ${roleId}::uuid`,
      client.auditLog.create({
        data: {
          companyId,
          userId: null,
          entityType: 'Role',
          entityId: roleId,
          action: 'PORTAL_PERMS_REMOVED',
          before: { removed: keys },
          after: { surface: 'upgrade' },
        },
      }),
    ]);
    removed += deleted.count;
    console.log(`Portal role "${slug}" (company ${companyId}): removed ${keys.join(', ')}`);
  }
  return { removed, roles: byRole.size };
}

/**
 * v0.8.4 Part I: adds permissions newly added to a system role's seed, never
 * anything an admin removed. The sync never revokes.
 *
 * For each system role other than super_admin (company_admin, sales_manager,
 * sales_executive, accounts, customer, broker), `role_seed_baselines` holds
 * the seed it was last synced to:
 *  - No baseline (every install before v0.8.4, on its first upgrade): record
 *    the current seed as the baseline and add NOTHING. Differences between
 *    the role and its seed are returned in `differences` for the upgrade to
 *    print; an admin decides in the Roles screen.
 *  - Baseline: add the keys in the seed that are neither in the baseline nor
 *    held (new to the seed since the last sync), then set the baseline to the
 *    seed. A key in the baseline that the role lacks was removed by an admin
 *    and stays removed. Keys an admin added are never touched, and keys
 *    dropped from the seed are never revoked: a release that must remove a
 *    permission ships its own migration (CLAUDE.md).
 * Each role that gains keys gets one ROLE_PERMS_CHANGED audit row (no actor)
 * and its users' sessions end, in the same transaction.
 *
 * Known edge: a key removed from the seed in one release and put back in a
 * later one counts as new and is added again, even if an admin had removed it.
 *
 * `scope.companyId` exists for tests; the upgrade runs it unscoped.
 */
export async function syncSystemRoleBaselines(
  client: PrismaClient = prisma,
  scope: { companyId?: string } = {},
): Promise<{ added: number; rolesChanged: number; baselined: number; differences: string[]; skipped: number }> {
  const slugs = (Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>).filter(
    (s) => s !== SYSTEM_ROLES.SUPER_ADMIN,
  );
  const roles = await client.role.findMany({
    where: { isSystem: true, slug: { in: slugs }, ...(scope.companyId ? { companyId: scope.companyId } : {}) },
    select: { id: true, companyId: true, slug: true },
    orderBy: [{ companyId: 'asc' }, { slug: 'asc' }],
  });
  const keyToId = new Map((await client.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]));

  const out = { added: 0, rolesChanged: 0, baselined: 0, differences: [] as string[], skipped: 0 };
  for (const role of roles) {
    const seed = [...new Set(ROLE_PERMISSIONS[role.slug as keyof typeof ROLE_PERMISSIONS])].sort();
    try {
      const held = new Set(
        (
          await client.rolePermission.findMany({ where: { roleId: role.id }, select: { permission: { select: { key: true } } } })
        ).map((rp) => rp.permission.key),
      );
      const base = await client.roleSeedBaseline.findUnique({ where: { roleId: role.id } });
      if (!base) {
        await client.roleSeedBaseline.create({ data: { roleId: role.id, permissionKeys: seed } });
        out.baselined++;
        const missing = seed.filter((k) => !held.has(k));
        const extra = [...held].filter((k) => !seed.includes(k)).sort();
        if (missing.length || extra.length) {
          out.differences.push(
            `${role.slug} (company ${role.companyId}): ` +
              [missing.length ? `lacks ${missing.length} seeded: ${missing.join(', ')}` : '', extra.length ? `has ${extra.length} beyond the seed: ${extra.join(', ')}` : '']
                .filter(Boolean)
                .join('; '),
          );
        }
        continue;
      }
      const baseline = new Set(base.permissionKeys);
      const toAdd = seed.filter((k) => !baseline.has(k) && !held.has(k) && keyToId.has(k));
      await client.$transaction([
        ...(toAdd.length
          ? [
              client.rolePermission.createMany({
                data: toAdd.map((k) => ({ roleId: role.id, permissionId: keyToId.get(k)! })),
                skipDuplicates: true,
              }),
              // Ends the role's users' sessions (see syncSuperAdminPermissions).
              client.$executeRaw`UPDATE users SET authz_version = authz_version + 1 WHERE role_id = ${role.id}::uuid`,
              client.auditLog.create({
                data: {
                  companyId: role.companyId,
                  userId: null,
                  entityType: 'Role',
                  entityId: role.id,
                  action: 'ROLE_PERMS_CHANGED',
                  after: { added: toAdd, surface: 'upgrade' },
                },
              }),
            ]
          : []),
        client.roleSeedBaseline.update({ where: { roleId: role.id }, data: { permissionKeys: seed, syncedAt: new Date() } }),
      ]);
      if (toAdd.length) {
        out.added += toAdd.length;
        out.rolesChanged++;
        console.log(`System role "${role.slug}" (company ${role.companyId}): added ${toAdd.join(', ')}`);
      }
    } catch (err) {
      if (isForeignKeyViolation(err) || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025')) {
        out.skipped++;
        console.warn(`syncSystemRoleBaselines: skipped role ${role.id} (company ${role.companyId}) — it vanished mid-sync.`);
        continue;
      }
      throw err;
    }
  }
  return out;
}

/**
 * v0.9: active bookings (BOOKED, ALLOTTED, REGISTERED) with no delay-interest
 * rule, per company: none set, or a rule id that no longer exists. Read-only. Printed by the CLI below so every upgrade
 * shows it, including the first upgrade to v0.9, which runs the previous
 * release's upgrade-native.sh but this release's copy of this script.
 * Nothing attaches a rule automatically: an admin attaches one per booking,
 * and interest runs only from that day. Optional companyId scope: tests only.
 */
export async function bookingsWithoutInterestRule(
  client: PrismaClient = prisma,
  scope: { companyId?: string } = {},
): Promise<Array<{ companyId: string; companyName: string; count: number }>> {
  const companyId = scope.companyId ?? null;
  const rows = await client.$queryRaw<Array<{ company_id: string; name: string; n: number }>>`
    SELECT c.id AS company_id, c.name, count(*)::int AS n
      FROM bookings b JOIN companies c ON c.id = b.company_id
     WHERE b.status IN ('BOOKED', 'ALLOTTED', 'REGISTERED')
       -- No rule: none set, or one that no longer exists (an orphan left by a
       -- NOT VALID key, which accrual treats as no rule).
       AND NOT EXISTS (SELECT 1 FROM interest_rules r WHERE r.id = b.interest_rule_id)
       AND (${companyId}::uuid IS NULL OR b.company_id = ${companyId}::uuid)
     GROUP BY c.id, c.name
     ORDER BY c.name`;
  return rows.map((r) => ({ companyId: r.company_id, companyName: r.name, count: r.n }));
}

// Exit codes this CLI entrypoint uses, inspected by
// deploy/native/upgrade-native.sh (see its own comment at the call site):
//   0 — clean, nothing skipped.
//   1 — hard failure (the .catch below) — upgrade-native.sh treats this as
//       fatal and aborts BEFORE cutover, same as a migration failure.
//   2 — completed, but skipped 1+ entities that vanished mid-sync. This is
//       deliberately NOT exit 1: a skip is a narrow, near-impossible-in-
//       production, single-company edge case (see isForeignKeyViolation's
//       doc comment) — treating it as fatal would abort the ENTIRE upgrade,
//       for every company, before cutover, over one company's edge case.
//       upgrade-native.sh lets the rest of the sequence (cutover,
//       healthcheck) proceed on exit 2, then reports it loudly at the very
//       end so it can't be missed without holding back everyone else's
//       release.
if (require.main === module) {
  syncPermissions()
    .then(async (added) => {
      console.log(`Permissions synced: ${added} new, ${ALL_PERMISSIONS.length - added} already present.`);
      const { granted, skipped: superAdminSkipped } = await syncSuperAdminPermissions();
      console.log(
        granted === 0
          ? 'super_admin grants: already complete.'
          : `super_admin grants: ${granted} missing permission(s) restored.`,
      );
      const { seeded, skipped: leadStagesSkipped } = await syncLeadStages();
      console.log(
        seeded === 0
          ? 'Lead stages: already seeded for every company.'
          : `Lead stages: seeded the default pipeline for ${seeded} compan${seeded === 1 ? 'y' : 'ies'}.`,
      );
      const stripped = await stripStaffPermissionsFromPortalRoles();
      if (stripped.removed === 0) {
        console.log('Portal roles: hold only portal permissions.');
      } else {
        console.log('');
        console.log('='.repeat(72));
        console.log(
          `PORTAL ROLES: REMOVED ${stripped.removed} NON-PORTAL PERMISSION GRANT(S) FROM ${stripped.roles} ROLE(S).`,
        );
        console.log(
          'Portal roles (Customer, Broker) can only hold portal.* permissions. The roles and ' +
            'permissions removed are listed above and recorded in each company\'s audit log.',
        );
        console.log('='.repeat(72));
        console.log('');
      }

      const roles = await syncSystemRoleBaselines();
      if (roles.added > 0) {
        console.log(`System roles: added ${roles.added} newly seeded permission(s) to ${roles.rolesChanged} role(s) (listed above, recorded in the audit log).`);
      } else {
        console.log('System roles: no newly seeded permissions to add.');
      }
      if (roles.baselined > 0) {
        console.log(`System roles: recorded a seed baseline for ${roles.baselined} role(s) (nothing was added for them this time).`);
      }
      if (roles.differences.length > 0) {
        console.log('');
        console.log('='.repeat(72));
        console.log('SYSTEM ROLES THAT DIFFER FROM THEIR DEFAULT PERMISSIONS (nothing was changed):');
        for (const d of roles.differences) console.log(`  ${d}`);
        console.log(
          'Review these in Admin -> Roles. Later upgrades add only permissions that are new to a role; ' +
            'anything an admin removed stays removed.',
        );
        console.log('='.repeat(72));
        console.log('');
      }

      const noRule = await bookingsWithoutInterestRule();
      const noRuleTotal = noRule.reduce((sum, r) => sum + r.count, 0);
      if (noRuleTotal === 0) {
        console.log('Delay interest: no active booking is without an interest rule.');
      } else {
        console.log(
          `Delay interest: ${noRuleTotal} active booking(s) have no interest rule. Nothing was attached ` +
            "automatically; attach a rule from each booking's installment schedule (interest runs from that day).",
        );
        for (const r of noRule) console.log(`  ${r.companyName} (company ${r.companyId}): ${r.count}`);
      }

      const totalSkipped = superAdminSkipped + leadStagesSkipped + roles.skipped;
      if (totalSkipped > 0) {
        console.error('');
        console.error('='.repeat(72));
        console.error(
          `SYNC COMPLETED WITH ${totalSkipped} SKIPPED ENTIT${totalSkipped === 1 ? 'Y' : 'IES'} — SEE WARNINGS ABOVE.`,
        );
        console.error(
          `${superAdminSkipped} super_admin role(s), ${leadStagesSkipped} compan${leadStagesSkipped === 1 ? 'y' : 'ies'} ` +
            `for lead stages, ${roles.skipped} system role(s) for seed baselines. ` +
            'This should be near-impossible in production (companies ' +
            'are never hard-deleted through the app) — investigate before assuming this ' +
            'is routine, then re-run this sync once resolved.',
        );
        console.error('='.repeat(72));
        console.error('');
        // process.exitCode, not process.exit(2) — lets the event loop
        // drain naturally (including the .finally() disconnect below)
        // instead of terminating mid-cleanup.
        process.exitCode = 2;
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
