import { Module } from '@nestjs/common';
import { z } from 'zod';
import { createMasterModule } from './master.factory';
import { INTEREST_RULE_MASTER } from './interest-rule.master';
import { GstRateModule } from './gst-rate/gst-rate.module';
import { TdsRuleModule } from './tds-rule/tds-rule.module';
import { SmsTemplateModule } from './sms-template/sms-template.module';
import { LetterTemplateModule } from './letter-template/letter-template.module';
import { LeadStageModule } from './lead-stage/lead-stage.module';

const SIMPLE_MASTERS = [
  { modelName: 'UnitType', routePath: 'unit-types', apiTag: 'Unit Types' },
  { modelName: 'PlcType', routePath: 'plc-types', apiTag: 'PLC Types' },
  { modelName: 'InquirySource', routePath: 'inquiry-sources', apiTag: 'Inquiry Sources' },
  // No seeded defaults, deliberately — see DumpReason's own schema doc
  // comment (docs/plans/followup-spec-gap-analysis.md gap #2): the SOP
  // gives no canonical reason list to seed from, unlike LeadStage.
  { modelName: 'DumpReason', routePath: 'dump-reasons', apiTag: 'Dump Reasons' },
  { modelName: 'InquiryType', routePath: 'inquiry-types', apiTag: 'Inquiry Types' },
  { modelName: 'InquiryTemperature', routePath: 'inquiry-temperatures', apiTag: 'Inquiry Temperatures' },
  { modelName: 'FollowUpType', routePath: 'follow-up-types', apiTag: 'Follow-Up Types' },
  { modelName: 'CommunicationType', routePath: 'communication-types', apiTag: 'Communication Types' },
  { modelName: 'ProjectType', routePath: 'project-types', apiTag: 'Project Types' },
  { modelName: 'ReceiptType', routePath: 'receipt-types', apiTag: 'Receipt Types' },
  { modelName: 'RegistrationType', routePath: 'registration-types', apiTag: 'Registration Types' },
  // stateCode is the GST place-of-supply source for every project in this
  // location, and since v0.2.0 made place-of-supply fail loud rather than
  // silently defaulting to intra-state, an AreaLocation without one makes
  // every booking in its projects IMPOSSIBLE — the wizard rejects at the
  // final step with "Set the Area Location state code", which the admin
  // then had no way to do, because the generic master schema only ever
  // exposed name/description/isActive/sortOrder. Found on the pre-pilot
  // walkthrough: every admin-created location had state_code NULL while
  // the seeded ones were fine, so the failure only ever hit real users.
  // city/pincode are the remaining real columns from the same
  // docs/todo.md gap, exposed here at the same time.
  {
    modelName: 'AreaLocation',
    routePath: 'area-locations',
    apiTag: 'Area Locations',
    extraFields: {
      stateCode: z
        .string()
        .regex(/^\d{2}$/, 'GST state code must be exactly 2 digits (e.g. 09 for Uttar Pradesh)')
        .optional(),
      city: z.string().max(100).optional(),
      state: z.string().max(100).optional(),
      pincode: z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits').optional(),
    },
  },
  // DocumentType.entityType is a required Prisma column (free-text label,
  // not read by any business logic — confirmed by grep — so no enum to
  // validate against beyond "non-empty").
  { modelName: 'DocumentType', routePath: 'document-types', apiTag: 'Document Types', extraFields: { entityType: z.string().min(1).max(50) } },
  // ifscPrefix is a real, optional Prisma column the generic schema never
  // exposed (docs/todo.md's "AreaLocation/Bank have real optional columns"
  // gap — AreaLocation's half was fixed above; this closes the other half).
  // Not read by any business logic (grepped) — pure reference data for
  // staff entering bank-transfer details, so no format is enforced beyond
  // the column's own VARCHAR(11) length.
  {
    modelName: 'Bank', routePath: 'banks', apiTag: 'Banks',
    extraFields: { ifscPrefix: z.string().max(11).optional() },
  },
  // gstRateId/hsnSac are real Prisma columns the generic schema never
  // exposed (docs/todo.md). GST genuinely varies by charge type (IFMS,
  // legal charges, and statutory pass-throughs don't all follow the base
  // sale rate) — see booking.service.ts's cost-line loop for how an unset
  // gstRateId here falls back to the booking's base line, never silently
  // zero-rates.
  {
    modelName: 'ChargeType', routePath: 'charge-types', apiTag: 'Charge Types',
    extraFields: {
      gstRateId: z.string().uuid().optional(),
      hsnSac: z.string().max(20).optional(),
    },
  },
  // See interest-rule.master.ts (required columns, and the rate guard).
  INTEREST_RULE_MASTER,
  // TransferFeeRule.feeType is required; TransferService reads the
  // literal 'FIXED' to decide between amountPaise/percentage.
  {
    modelName: 'TransferFeeRule', routePath: 'transfer-fee-rules', apiTag: 'Transfer Fee Rules',
    extraFields: {
      feeType: z.enum(['FIXED', 'PERCENTAGE']),
      amountPaise: z.coerce.bigint().min(0n).optional(),
      percentage: z.coerce.number().min(0).max(100).optional(),
    },
  },
  // The only SIMPLE_MASTERS model whose Prisma model actually has a
  // `description` column — see MasterModuleConfig.supportsDescription.
  { modelName: 'PaymentPlanTemplate', routePath: 'payment-plan-templates', apiTag: 'Payment Plan Templates', supportsDescription: true },
  { modelName: 'TicketCategory', routePath: 'ticket-categories', apiTag: 'Ticket Categories' },
  // LetterTemplate is NOT here — its Prisma model requires subject/body/
  // entityType with merge-field validation (not just "field present"),
  // which the generic extraFields mechanism above doesn't cover; it has
  // its own dedicated module (mirroring SmsTemplateModule's existing
  // precedent).
] as const;

const simpleMasterModules = SIMPLE_MASTERS.map((config) =>
  createMasterModule(config),
);

@Module({
  imports: [
    ...simpleMasterModules,
    GstRateModule,
    TdsRuleModule,
    SmsTemplateModule,
    LetterTemplateModule,
    LeadStageModule,
  ],
})
export class MastersModule {}
