import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES, ROLE_PERMISSIONS, ROLE_DISPLAY_NAMES, SEED_GST_RATES, SEED_TDS_RULES } from '@openestate/shared';
import * as argon2 from '@node-rs/argon2';
import { syncPermissions, syncLeadStages, syncSystemRoleBaselines } from './sync-permissions';

const prisma = new PrismaClient();

// Same spirit as deploy/install.sh's rand_secret() for every other
// generated credential — a hardcoded initial admin password shipped via
// this exact seed script to every self-hosted production install
// (deploy/install.sh runs it on first bring-up) is CWE-798, not a demo
// convenience. Printed once to stdout; forcePasswordChange below means
// it only works until the real admin logs in and changes it.
function generateAdminPassword(): string {
  return randomBytes(18).toString('base64url');
}

async function main() {
  console.log('Seeding permissions...');
  const added = await syncPermissions(prisma);
  console.log(`  ${added} new permissions added.`);

  const allPerms = await prisma.permission.findMany();
  const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

  const existingCompany = await prisma.company.findFirst();
  if (existingCompany) {
    console.log(`Company already exists (${existingCompany.slug}), skipping company + role seed.`);
    return;
  }

  console.log('Creating demo company...');
  const company = await prisma.company.create({
    data: {
      name: 'Demo Realty Pvt. Ltd.',
      slug: 'demo-realty',
    },
  });

  console.log('Seeding roles...');
  const roleIds: Record<string, string> = {};
  for (const slug of Object.values(SYSTEM_ROLES)) {
    const role = await prisma.role.create({
      data: {
        companyId: company.id,
        name: ROLE_DISPLAY_NAMES[slug],
        slug,
        isSystem: true,
        isPortal: slug === SYSTEM_ROLES.CUSTOMER || slug === SYSTEM_ROLES.BROKER,
      },
    });
    roleIds[slug] = role.id;

    const perms = ROLE_PERMISSIONS[slug];
    const rolePermData = perms
      .map((key) => {
        const permId = permByKey.get(key);
        if (!permId) return null;
        return { roleId: role.id, permissionId: permId };
      })
      .filter(Boolean) as Array<{ roleId: string; permissionId: string }>;

    if (rolePermData.length > 0) {
      await prisma.rolePermission.createMany({ data: rolePermData });
    }
    console.log(`  ${slug}: ${rolePermData.length} permissions`);
  }

  console.log('Creating admin user...');
  const adminPassword = generateAdminPassword();
  const adminHash = await argon2.hash(adminPassword, { algorithm: argon2.Algorithm.Argon2id });
  await prisma.user.create({
    data: {
      companyId: company.id,
      email: 'admin@demo-realty.com',
      name: 'System Admin',
      passwordHash: adminHash,
      roleId: roleIds[SYSTEM_ROLES.SUPER_ADMIN],
      forcePasswordChange: true,
    },
  });
  console.log('');
  console.log('  ==============================================');
  console.log('   Initial admin login (save this — shown once):');
  console.log('   email:    admin@demo-realty.com');
  console.log(`   password: ${adminPassword}`);
  console.log('  ==============================================');
  console.log('');

  console.log('Seeding company config...');
  await prisma.companyConfig.create({
    data: {
      companyId: company.id,
      labelOverrides: {
        unit: 'Unit',
        project: 'Project',
        tower: 'Tower',
        floor: 'Floor',
        booking: 'Booking',
        inquiry: 'Inquiry',
      },
      enabledModules: ['presales', 'postsales', 'accounts'],
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      fyStartMonth: 4,
      dateFormat: 'DD-MM-YYYY',
    },
  });

  console.log('Seeding default lead-stage pipeline...');
  await syncLeadStages(prisma);

  // v0.8.4 Part I: the roles were just created from their seeds, so this
  // records each one's baseline (nothing to add, nothing to report).
  await syncSystemRoleBaselines(prisma);

  console.log('Seeding Indian master defaults...');

  const masters = [
    {
      model: 'unitType',
      items: ['1 BHK', '2 BHK', '3 BHK', '4 BHK', 'Studio', 'Penthouse', 'Shop', 'Office'],
    },
    {
      model: 'plcType',
      items: ['Park Facing', 'Corner', 'Road Facing', 'Garden Facing', 'Pool Facing', 'Main Road'],
    },
    {
      model: 'inquirySource',
      items: [
        'Walk-in', 'Phone Call', 'Website', 'MagicBricks', '99acres',
        'Housing.com', 'Referral', 'Broker', 'Social Media', 'Email Campaign',
      ],
    },
    {
      model: 'inquiryType',
      items: ['Fresh', 'Resale', 'Rental', 'Commercial'],
    },
    {
      model: 'inquiryTemperature',
      items: ['Cold', 'Warm', 'Hot'],
    },
    {
      model: 'followUpType',
      items: ['Phone Call', 'Site Visit', 'Email', 'WhatsApp', 'Meeting', 'Video Call'],
    },
    {
      model: 'communicationType',
      items: ['SMS', 'Email', 'WhatsApp', 'Phone Call', 'Letter', 'In-Person'],
    },
    {
      model: 'projectType',
      items: ['Residential', 'Commercial', 'Mixed Use', 'Plotted Development', 'Villa', 'Township'],
    },
    {
      model: 'receiptType',
      items: ['Booking Amount', 'Installment', 'Demand', 'Stamp Duty', 'Registration', 'GST', 'TDS', 'Other'],
    },
    {
      model: 'registrationType',
      items: ['Sale Deed', 'Agreement to Sell', 'Power of Attorney', 'Gift Deed', 'Leave & License'],
    },
    {
      model: 'areaLocation',
      items: ['Noida', 'Greater Noida', 'Gurugram', 'Mumbai', 'Pune', 'Bangalore', 'Hyderabad', 'Chennai'],
    },
    {
      model: 'documentType',
      items: ['PAN Card', 'Aadhaar (reference only)', 'Passport', 'Voter ID', 'Agreement Copy', 'Allotment Letter', 'Demand Letter', 'Receipt', 'NOC', 'Possession Letter'],
      extraFields: { entityType: 'Applicant' },
    },
    {
      model: 'chargeType',
      items: ['Basic Sale Price', 'Floor Rise', 'PLC', 'Club Membership', 'Car Parking', 'Power Backup', 'IFMS', 'Legal Charges', 'Stamp Duty', 'Registration'],
    },
    {
      model: 'bank',
      items: ['State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Punjab National Bank', 'Bank of Baroda', 'Kotak Mahindra Bank', 'Yes Bank'],
    },
    {
      model: 'paymentPlanTemplate',
      items: ['Construction-Linked Plan', 'Down Payment Plan', 'Flexi Plan', 'Subvention Plan'],
    },
    {
      model: 'ticketCategory',
      items: ['Payment Query', 'Construction Update', 'Documentation', 'General Query', 'Complaint'],
    },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const { model, items, extraFields } of masters as { model: string; items: string[]; extraFields?: Record<string, any> }[]) {
    for (let i = 0; i < items.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any)[model].create({
        data: {
          companyId: company.id,
          name: items[i],
          sortOrder: i,
          ...extraFields,
        },
      });
    }
    console.log(`  ${model}: ${items.length} entries`);
  }

  console.log('Seeding interest rules...');
  await prisma.interestRule.create({
    data: { companyId: company.id, name: 'Standard 18% p.a.', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY', sortOrder: 0 },
  });
  await prisma.interestRule.create({
    data: { companyId: company.id, name: 'Penal 24% p.a.', rateType: 'SIMPLE', ratePercent: 24, frequency: 'YEARLY', sortOrder: 1 },
  });

  console.log('Seeding transfer fee rules...');
  await prisma.transferFeeRule.create({
    data: { companyId: company.id, name: 'Standard Transfer Fee', feeType: 'PERCENTAGE', percentage: 2, sortOrder: 0 },
  });
  await prisma.transferFeeRule.create({
    data: { companyId: company.id, name: 'Mutation Charge', feeType: 'FIXED', amountPaise: BigInt(25_000_00), sortOrder: 1 },
  });

  console.log('Seeding GST rates...');
  // Data lives in seed-gst-tds-rates.ts (shared with its own round-trip
  // validation test) — see that file for why the dates are what they
  // are. Insertion order matters: GstRateService.create()'s overlap
  // check runs per row against whatever's already inserted.
  for (const rate of SEED_GST_RATES) {
    await prisma.gstRate.create({ data: { companyId: company.id, ...rate } });
  }

  console.log('Seeding TDS rules...');
  for (const rule of SEED_TDS_RULES) {
    await prisma.tdsRule.create({ data: { companyId: company.id, ...rule } });
  }

  console.log('Seeding Phase 4 financial config...');
  // Supplier GST identity + cheque bounce charge on the company config.
  await prisma.companyConfig.update({
    where: { companyId: company.id },
    data: {
      companyGstin: '09ABCDE1234F1Z5',
      gstStateCode: '09', // Uttar Pradesh
      chequeBounceChargePaise: BigInt(500_00), // ₹500
    },
  });

  // GST state codes for seeded area locations (place-of-supply defaults).
  const areaStateCodes: Record<string, string> = {
    Noida: '09',
    'Greater Noida': '09',
    Gurugram: '06',
    Mumbai: '27',
    Pune: '27',
    Bangalore: '29',
    Hyderabad: '36',
    Chennai: '33',
  };
  for (const [name, stateCode] of Object.entries(areaStateCodes)) {
    await prisma.areaLocation.updateMany({
      where: { companyId: company.id, name },
      data: { stateCode },
    });
  }

  // Cancellation rules.
  await prisma.cancellationRule.create({
    data: { companyId: company.id, name: 'Standard 10% Deduction', deductionType: 'PERCENT', deductionPercent: 10, sortOrder: 0 },
  });
  await prisma.cancellationRule.create({
    data: { companyId: company.id, name: 'Flat ₹50,000 Cancellation', deductionType: 'FLAT', deductionAmountPaise: BigInt(50_000_00), sortOrder: 1 },
  });

  // Payment-plan template milestones (percents sum to 100).
  //
  // "Construction-Linked Plan"'s stage milestones are STAGE_LINKED, not
  // DATE_LINKED — this is the fix for a real correctness bug (see
  // internal plan construction-linked-demand-fix.md): every milestone here
  // used to get a hardcoded dueOffsetDays from booking date regardless of
  // whether the underlying construction stage had actually happened,
  // which meant a customer could be shown overdue — and accrue delay
  // interest — against a stage the builder hadn't reached yet. Only "On
  // Booking" (due immediately, a real calendar fact) stays DATE_LINKED.
  // graceDaysAfterRaise (15) is the demand-notice window after a stage is
  // marked complete, not an offset from booking date — dueOffsetDays is
  // irrelevant for these rows and left at 0.
  const milestoneSets: Record<
    string,
    Array<{ label: string; percent: number; dueOffsetDays: number; milestoneType?: 'DATE_LINKED' | 'STAGE_LINKED'; graceDaysAfterRaise?: number }>
  > = {
    'Down Payment Plan': [
      { label: 'On Booking', percent: 10, dueOffsetDays: 0 },
      { label: 'Within 30 days', percent: 85, dueOffsetDays: 30 },
      { label: 'On Possession', percent: 5, dueOffsetDays: 720 },
    ],
    'Construction-Linked Plan': [
      { label: 'On Booking', percent: 10, dueOffsetDays: 0 },
      { label: 'Excavation', percent: 15, dueOffsetDays: 0, milestoneType: 'STAGE_LINKED', graceDaysAfterRaise: 15 },
      { label: 'Plinth', percent: 15, dueOffsetDays: 0, milestoneType: 'STAGE_LINKED', graceDaysAfterRaise: 15 },
      { label: 'Superstructure', percent: 30, dueOffsetDays: 0, milestoneType: 'STAGE_LINKED', graceDaysAfterRaise: 15 },
      { label: 'Finishing', percent: 20, dueOffsetDays: 0, milestoneType: 'STAGE_LINKED', graceDaysAfterRaise: 15 },
      { label: 'On Possession', percent: 10, dueOffsetDays: 0, milestoneType: 'STAGE_LINKED', graceDaysAfterRaise: 15 },
    ],
  };
  for (const [templateName, milestones] of Object.entries(milestoneSets)) {
    const template = await prisma.paymentPlanTemplate.findFirst({
      where: { companyId: company.id, name: templateName },
    });
    if (!template) continue;
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      await prisma.paymentPlanMilestone.create({
        data: {
          companyId: company.id,
          templateId: template.id,
          seq: i + 1,
          label: m.label,
          percent: m.percent,
          milestoneType: m.milestoneType ?? 'DATE_LINKED',
          dueOffsetDays: m.dueOffsetDays,
          graceDaysAfterRaise: m.graceDaysAfterRaise ?? 0,
        },
      });
    }
  }
  console.log('  company GST state, cancellation rules, plan milestones seeded.');

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
