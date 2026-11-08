// Deliberately not imported from apps/api/test/helpers/postsales-harness.ts
// or packages/db/prisma/seed.ts — neither is a published package export,
// so a cross-package relative import would reach into another package's
// private test/script directory. This mirrors their shape instead (same
// company/role/user/inventory pattern used throughout this project's test
// suite) at the small cost of some duplication.
import { createSystemPrismaClient } from '@openestate/db';
import { ALL_PERMISSIONS, SYSTEM_ROLES, ROLE_PERMISSIONS, ROLE_DISPLAY_NAMES, DEFAULT_LEAD_STAGES } from '@openestate/shared';
import * as argon2 from '@node-rs/argon2';

export interface E2eFixture {
  companyId: string;
  adminEmail: string;
  adminPassword: string;
  projectId: string;
  projectName: string;
  unitNumber: string;
  // Always set — the 0%-rate row every scenario's BookingWizard run needs
  // to resolve the base line. Exposed so a spec that explicitly selects a
  // rate (rather than relying on auto-preselect) can match its label text.
  defaultGstRateLabel: string;
  // Only set when opts.withPricingMasters is passed (scenario 4) — the
  // other scenarios have no use for a PLC type/GST-rated charge type.
  plcTypeName?: string;
  chargeTypeName?: string;
  chargeTypeGstRatePercent?: number;
  // Only set when opts.withPortalTicketSetup is passed — a portal-login-
  // capable Applicant plus a ticket category, for the customer-raises /
  // staff-replies round-trip scenario. The SAME applicant also gets a
  // second, LAND_BASED booking (landProjectName/landPlotNumber/
  // landGroupName below) — deliberately folded into this one fixture
  // rather than a separate login: the whole Playwright suite finishes in
  // under 2 minutes, so every portal login in the harness shares the same
  // 5-requests/5-minutes portal-auth throttle bucket (IP-keyed) — a
  // second standalone fixture+login tipped it over 5 and caused real,
  // intermittent 429s on unrelated spec files (found live, not guessed).
  portalIdentifier?: string;
  portalPassword?: string;
  ticketCategoryName?: string;
  landProjectName?: string;
  landPlotNumber?: string;
  landGroupName?: string;
  // Only set by seedVisualFixture (fixtures/visual.ts): role slug -> e-mail.
  roleUsers?: Record<string, string>;
}

const rnd = () => Math.random().toString(36).slice(2, 8);

export async function seedE2eFixture(
  databaseUrlSystem: string,
  opts: {
    forcePasswordChange?: boolean;
    withPricingMasters?: boolean;
    withPortalTicketSetup?: boolean;
  } = {},
): Promise<E2eFixture> {
  const prisma = createSystemPrismaClient(databaseUrlSystem);
  const tag = `${Date.now()}-${rnd()}`;

  try {
    // Permissions are global, not company-scoped — upsert so a rerun
    // against an already-seeded disposable DB (e.g. re-running the suite
    // without tearing the test DB down between local iterations) doesn't
    // fail on the unique constraint, matching packages/db/prisma/seed.ts.
    for (const key of ALL_PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await prisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

    const company = await prisma.company.create({
      data: { name: `E2E Harness ${tag}`, slug: `e2e-harness-${tag}` },
    });

    const role = await prisma.role.create({
      data: {
        companyId: company.id,
        name: ROLE_DISPLAY_NAMES[SYSTEM_ROLES.SUPER_ADMIN],
        slug: SYSTEM_ROLES.SUPER_ADMIN,
        isSystem: true,
      },
    });
    const rolePermData = ROLE_PERMISSIONS[SYSTEM_ROLES.SUPER_ADMIN]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id)
      .map((permissionId) => ({ roleId: role.id, permissionId }));
    if (rolePermData.length > 0) {
      await prisma.rolePermission.createMany({ data: rolePermData });
    }

    const adminEmail = `admin-${tag}@e2e-harness.test`;
    const adminPassword = 'E2eHarness#Pass1';
    const adminHash = await argon2.hash(adminPassword, { algorithm: argon2.Algorithm.Argon2id });
    await prisma.user.create({
      data: {
        companyId: company.id,
        email: adminEmail,
        name: 'E2E Admin',
        passwordHash: adminHash,
        roleId: role.id,
        // Real installs always create staff users this way (see
        // packages/db/prisma/seed.ts) — only auth-2fa.spec.ts actually
        // needs to exercise the gate, so every other scenario opts out to
        // stay focused on what it's testing.
        forcePasswordChange: opts.forcePasswordChange ?? false,
      },
    });

    await prisma.companyConfig.create({
      data: {
        companyId: company.id,
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        fyStartMonth: 4,
        dateFormat: 'DD-MM-YYYY',
        // Zero, not the real-world default — isolates scenario 3's
        // before/after Collection Summary delta to the receipt amount
        // alone, with no separate bounce-charge line to account for.
        chequeBounceChargePaise: BigInt(0),
        // isIntraStateSupply() throws (not silently defaults to
        // intra-state) when either side's state code is missing — every
        // scenario here books a unit, so this must be set or every
        // booking attempt 400s. Matches
        // apps/api/test/helpers/postsales-harness.ts's own default.
        gstStateCode: '09',
        companyGstin: '09ABCDE1234F1Z5',
        leadStagesSeededAt: new Date(),
      },
    });

    // Mirrors packages/db/prisma/sync-permissions.ts's syncLeadStages —
    // not imported from it (that file lives under packages/db/prisma,
    // not @openestate/db's published src/ exports, same "mirror, don't
    // cross-import a private script" discipline this file's own header
    // comment already states for company/role/user creation). Without
    // this, a real company creation (via seed.ts or the upgrade sync)
    // seeds the default pipeline but this harness's fixture companies
    // silently wouldn't — lead-stage.spec.ts's admin-page assertions
    // would see zero stages, not the real product's actual first-boot
    // state.
    await prisma.leadStage.createMany({
      data: DEFAULT_LEAD_STAGES.map((name, i) => ({
        companyId: company.id,
        name,
        sortOrder: i,
        isDefault: i === 0,
      })),
    });

    // Minimal inventory for scenario 3's booking flow — direct Prisma
    // writes, not through the Inventory UI, since inventory creation is
    // out of scope for these three scenarios (mirrors
    // apps/api/test/helpers/postsales-harness.ts's seedCompany/makeUnit).
    // areaLocation gives the project a place-of-supply state code — the
    // other half of what isIntraStateSupply() now requires.
    const areaLocation = await prisma.areaLocation.create({
      data: { companyId: company.id, name: `E2E Area ${tag}`, stateCode: '09' },
    });
    const project = await prisma.project.create({
      data: { companyId: company.id, name: `E2E Project ${tag}`, code: `E2E-${tag}`, areaLocationId: areaLocation.id },
    });
    const tower = await prisma.tower.create({
      data: { companyId: company.id, projectId: project.id, name: 'Tower 1', code: 'T1' },
    });
    const floor = await prisma.floor.create({
      data: { companyId: company.id, towerId: tower.id, name: 'Floor 1', floorNumber: 1 },
    });
    const unitNumber = `E2E-${tag}`;
    const unit = await prisma.unit.create({
      data: {
        companyId: company.id,
        projectId: project.id,
        shape: 'HIGH_RISE',
        floorId: floor.id,
        number: unitNumber,
        status: 'AVAILABLE',
        baseRatePaise: BigInt(50_00_000_00), // ₹50,00,000 — plausible, overridden per-scenario anyway
      },
    });

    // A booking's BASE cost line now needs a real gstRateId to be created
    // at all — the base-line rate picker made an unresolvable line a hard
    // 400, not a silent 0%. One 0%-rate row here so every scenario's
    // BookingWizard run sees exactly one active option and auto-preselects
    // it (matches production's own "only one active rate ⇒ no need to
    // ask" behaviour) — except withPricingMasters, which adds a SECOND,
    // real 5% rate below and so must explicitly pick this one in the UI.
    const defaultGstRate = await prisma.gstRate.create({
      data: { companyId: company.id, rate: 0, description: 'No GST (e2e default)', effectiveFrom: new Date('2019-04-01') },
    });

    let plcTypeName: string | undefined;
    let chargeTypeName: string | undefined;
    let chargeTypeGstRatePercent: number | undefined;
    if (opts.withPricingMasters) {
      const plcType = await prisma.plcType.create({ data: { companyId: company.id, name: `Park Facing ${tag}` } });
      plcTypeName = plcType.name;

      // A GST rate distinct from the base line's (which nothing sets —
      // there's no rate picker in the wizard today) so the assigned
      // charge is taxed on ITS OWN rate, not left untaxed alongside an
      // untaxed base line — exactly the scenario that motivated exposing
      // ChargeType.gstRateId at all.
      chargeTypeGstRatePercent = 5;
      const gstRate = await prisma.gstRate.create({
        data: { companyId: company.id, rate: chargeTypeGstRatePercent, description: `GST ${chargeTypeGstRatePercent}%`, effectiveFrom: new Date('2019-04-01') },
      });
      const chargeType = await prisma.chargeType.create({
        data: { companyId: company.id, name: `IFMS ${tag}`, gstRateId: gstRate.id },
      });
      chargeTypeName = chargeType.name;
    }

    let portalIdentifier: string | undefined;
    let portalPassword: string | undefined;
    let ticketCategoryName: string | undefined;
    let landProjectName: string | undefined;
    let landPlotNumber: string | undefined;
    let landGroupName: string | undefined;
    if (opts.withPortalTicketSetup) {
      const customerRole = await prisma.role.create({
        data: {
          companyId: company.id,
          name: ROLE_DISPLAY_NAMES[SYSTEM_ROLES.CUSTOMER],
          slug: SYSTEM_ROLES.CUSTOMER,
          isSystem: true,
          isPortal: true,
        },
      });
      const customerRolePermData = ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]
        .map((key) => permByKey.get(key))
        .filter((id): id is string => !!id)
        .map((permissionId) => ({ roleId: customerRole.id, permissionId }));
      if (customerRolePermData.length > 0) {
        await prisma.rolePermission.createMany({ data: customerRolePermData });
      }

      // Phone, not email — PortalAuthService.login's identifier lookup is
      // company-unscoped and globally unique (Phase 6 decisions), so a
      // high-entropy phone avoids the exact cross-file collision class
      // CLAUDE.md's e2e-portal-throttle.test.ts entry already documents
      // for makeApplicant()-style sequential phone numbers.
      const phone = `9${String(Date.now()).slice(-9)}`;
      const applicant = await prisma.applicant.create({
        data: { companyId: company.id, name: `E2E Customer ${tag}`, primaryPhone: phone, primaryPhoneNormalized: phone },
      });
      portalIdentifier = phone;
      portalPassword = 'E2ePortal#Pass1';
      await prisma.user.create({
        data: {
          companyId: company.id,
          email: `portal-${tag}@e2e-harness.test`,
          // PortalAuthService.login's identifier lookup queries User.phone/
          // User.email directly — NOT Applicant.primaryPhone — so this has
          // to be set here too, not just on the Applicant row above.
          phone,
          name: applicant.name,
          passwordHash: await argon2.hash(portalPassword, { algorithm: argon2.Algorithm.Argon2id }),
          roleId: customerRole.id,
          applicantId: applicant.id,
          forcePasswordChange: false,
        },
      });

      const category = await prisma.ticketCategory.create({
        data: { companyId: company.id, name: `E2E Ticket Category ${tag}` },
      });
      ticketCategoryName = category.name;

      // A real booking on the fixture's own unit, linking this portal
      // applicant to fx.projectId — required for
      // portal_can_access_booking()-gated RLS (project_media, tickets are
      // applicant-direct so didn't need this, but the v0.2.2 media gallery
      // scenario needs a genuine booking to see the project at all). Raw
      // Prisma write, not through BookingService, same as
      // apps/api/test/portal-rls.test.ts's own makeBooking() helper —
      // fixture data, not a flow under test.
      await prisma.booking.create({
        data: {
          companyId: company.id,
          unitId: unit.id,
          primaryApplicantId: applicant.id,
          bookingNumber: `E2E-BOOKING-${tag}`,
          agreedPricePaise: BigInt(50_00_000_00),
          bookingDate: new Date(),
        },
      });

      // A second booking for the SAME portal applicant, against a
      // LAND_BASED plot — Phase D (plotted-farmhouse-inventory.md §14):
      // media-gallery.spec.ts's already-authenticated portal session
      // reads these fields off this SAME fixture rather than a separate
      // login, per this file's own throttle-budget comment above.
      const landProject = await prisma.project.create({
        data: {
          companyId: company.id,
          name: `E2E Land Project ${tag}`,
          code: `E2ELAND-${tag}`,
          shape: 'LAND_BASED',
          landAreaDefaultUnit: 'GUNTA',
          areaLocationId: areaLocation.id,
        },
      });
      landProjectName = landProject.name;

      const group = await prisma.inventoryGroup.create({
        data: { companyId: company.id, projectId: landProject.id, name: `Sector A ${tag}`, code: `SECA-${tag}` },
      });
      landGroupName = group.name;

      const plotNumber = `PLOT-${tag}`;
      const landUnit = await prisma.unit.create({
        data: {
          companyId: company.id,
          projectId: landProject.id,
          shape: 'LAND_BASED',
          floorId: null,
          inventoryGroupId: group.id,
          number: plotNumber,
          status: 'BOOKED',
          landAreaEntered: 0.372,
          landAreaEnteredUnit: 'ACRE',
          landAreaSqft: 16204.32,
          rateUnit: 'ACRE',
          baseRatePaise: BigInt(5_00_000_00),
        },
      });
      landPlotNumber = landUnit.number;

      await prisma.booking.create({
        data: {
          companyId: company.id,
          unitId: landUnit.id,
          primaryApplicantId: applicant.id,
          bookingNumber: `E2E-LAND-BOOKING-${tag}`,
          agreedPricePaise: BigInt(18_60_000_00),
          bookingDate: new Date(),
        },
      });
    }

    return {
      companyId: company.id,
      adminEmail,
      adminPassword,
      projectId: project.id,
      projectName: project.name,
      unitNumber,
      defaultGstRateLabel: `${defaultGstRate.rate}% — ${defaultGstRate.description}`,
      plcTypeName,
      chargeTypeName,
      chargeTypeGstRatePercent,
      portalIdentifier,
      portalPassword,
      ticketCategoryName,
      landProjectName,
      landPlotNumber,
      landGroupName,
    };
  } finally {
    await prisma.$disconnect();
  }
}
