import { z } from 'zod';

// ── Clock (injectable "now" for deterministic ageing/escalation) ──

export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

// ── Phone / email normalization ─────────────────────────────
//
// Phone: strip Indian country/trunk prefixes (+91/91/0) and normalize
// ONLY if the result is a 10-digit number starting 6-9 (a valid Indian
// mobile). Anything else (NRI numbers, landlines, malformed input) is
// stored as-is (trimmed only) and matched by exact string equality —
// never digit-stripped, never guessed at. See CLAUDE.md Phase 3 decisions.

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return digits;
  }

  return trimmed;
}

/**
 * Digits for a wa.me link: an Indian mobile in any stored form (+91…, 91…,
 * 0…, 10 digits) becomes 91 + the 10 digits, exactly once. Another number
 * is used only when stored with its own "+country" prefix; anything else
 * returns null (no link), since its country can't be known.
 */
export function whatsAppNumber(raw: string): string | null {
  const indian = normalizePhone(raw);
  if (/^[6-9]\d{9}$/.test(indian)) return `91${indian}`;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  return trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Canonical (a, b) ordering for ApplicantDistinctPair, lexicographic on
 *  the UUID string — the pair is always stored applicantAId < applicantBId
 *  so a lookup never needs to check both orderings. */
export function orderApplicantPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

// ── Ageing / overdue calculations (pure, testable with injected `now`) ──

export const AGEING_BUCKETS = ['0-7', '8-30', '31-90', '90+'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export function computeAgeingBucket(createdAt: Date, now: Date): AgeingBucket {
  const ageDays = Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000);
  if (ageDays <= 7) return '0-7';
  if (ageDays <= 30) return '8-30';
  if (ageDays <= 90) return '31-90';
  return '90+';
}

export function isFollowUpOverdue(nextFollowupAt: Date | null | undefined, now: Date): boolean {
  return !!nextFollowupAt && nextFollowupAt.getTime() < now.getTime();
}

/** An inquiry is eligible for (re-)escalation if it has never been escalated,
 *  or its last escalation predates the currently-overdue nextFollowupAt
 *  (i.e. the follow-up date was pushed forward and has lapsed again). */
export function isEscalationEligible(
  nextFollowupAt: Date | null | undefined,
  lastEscalatedAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!isFollowUpOverdue(nextFollowupAt, now)) return false;
  if (!lastEscalatedAt) return true;
  return lastEscalatedAt.getTime() < (nextFollowupAt as Date).getTime();
}

// ── Inquiry status / follow-up outcome / communication enums ──

export const INQUIRY_STATUS = {
  OPEN: 'OPEN',
  CONTINUED: 'CONTINUED',
  DUMPED: 'DUMPED',
  SUCCESSFUL: 'SUCCESSFUL',
} as const;
export type InquiryStatusValue = (typeof INQUIRY_STATUS)[keyof typeof INQUIRY_STATUS];

/** An inquiry counts as "actively worked" — the axis overdueOnly filters
 *  and escalation eligibility both key off — whenever status is one of
 *  these. An OPEN lead with a slipped follow-up and a CONTINUED lead with
 *  a slipped follow-up are equally overdue; DUMPED/SUCCESSFUL are terminal
 *  and never overdue regardless of nextFollowupAt. */
export const ACTIVE_INQUIRY_STATUSES = [INQUIRY_STATUS.OPEN, INQUIRY_STATUS.CONTINUED] as const;

/** What staff see for each status; the enum value never reaches the screen. */
export const INQUIRY_STATUS_LABELS: Record<InquiryStatusValue, string> = {
  OPEN: 'Open',
  CONTINUED: 'Continued',
  DUMPED: 'Dumped',
  SUCCESSFUL: 'Successful',
};

/** Seeded default pipeline — India-first per CLAUDE.md, matches the set
 *  the requester approved for Phase 0 of the lead-stage foundation.
 *  "New" is the isDefault stage. Order is the seeded sortOrder. */
export const DEFAULT_LEAD_STAGES = [
  'New',
  'Contacted',
  'Site Visit Scheduled',
  'Site Visit Done',
  'Negotiation',
  'Documentation',
] as const;

export const FOLLOW_UP_OUTCOME = {
  COMPLETED: 'COMPLETED',
  NO_RESPONSE: 'NO_RESPONSE',
  RESCHEDULED: 'RESCHEDULED',
  NOT_INTERESTED: 'NOT_INTERESTED',
  CONVERTED: 'CONVERTED',
} as const;
export type FollowUpOutcomeValue = (typeof FOLLOW_UP_OUTCOME)[keyof typeof FOLLOW_UP_OUTCOME];

export const COMMUNICATION_CHANNEL = { EMAIL: 'EMAIL', SMS: 'SMS' } as const;
export type CommunicationChannelValue = (typeof COMMUNICATION_CHANNEL)[keyof typeof COMMUNICATION_CHANNEL];

export const ASSIGNMENT_TYPE = { MANUAL: 'manual', AUTO: 'auto' } as const;
export type AssignmentTypeValue = (typeof ASSIGNMENT_TYPE)[keyof typeof ASSIGNMENT_TYPE];

// ── Zod Schemas: Applicant ──────────────────────────────────

export const createApplicantSchema = z
  .object({
    name: z.string().min(1).max(255),
    primaryPhone: z.string().min(1).max(20),
    alternatePhones: z.array(z.string().max(20)).default([]),
    email: z.string().email().max(255).optional(),
    addressLine1: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    pincode: z.string().max(10).optional(),
    pan: z
      .string()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN format')
      .optional(),
    customFields: z.record(z.unknown()).optional(),
  })
  .strict();

export type CreateApplicantDto = z.infer<typeof createApplicantSchema>;

export const updateApplicantSchema = createApplicantSchema.partial().strict();
export type UpdateApplicantDto = z.infer<typeof updateApplicantSchema>;

export const recordConsentSchema = z
  .object({
    given: z.boolean(),
    source: z.string().max(100).optional(),
  })
  .strict();

export type RecordConsentDto = z.infer<typeof recordConsentSchema>;

/** The opposite decision from merge — "these are different people," not
 *  "these are the same." See ApplicantDistinctPair (packages/db). */
export const confirmDistinctSchema = z
  .object({
    otherApplicantId: z.string().uuid(),
  })
  .strict();

export type ConfirmDistinctDto = z.infer<typeof confirmDistinctSchema>;

// ── Zod Schemas: Inquiry ────────────────────────────────────

export const createInquirySchema = z
  .object({
    applicantId: z.string().uuid().optional(),
    applicant: createApplicantSchema.optional(),
    projectId: z.string().uuid().optional(),
    sourceId: z.string().uuid().optional(),
    inquiryTypeId: z.string().uuid().optional(),
    budgetMinPaise: z.coerce.bigint().min(0n).optional(),
    budgetMaxPaise: z.coerce.bigint().min(0n).optional(),
    preferredUnitTypeId: z.string().uuid().optional(),
    temperatureId: z.string().uuid().optional(),
    // Omitted -> InquiryService.create() resolves the company's isDefault
    // LeadStage (or leaves it null if none configured). Explicit null is
    // not accepted here — there is no "no stage" gesture at creation, only
    // "let the default apply."
    stageId: z.string().uuid().optional(),
    nextFollowupAt: z.coerce.date().optional(),
    customFields: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((d) => !!d.applicantId || !!d.applicant, {
    message: 'Either applicantId or applicant must be provided',
    path: ['applicantId'],
  });

export type CreateInquiryDto = z.infer<typeof createInquirySchema>;

/** Columns GET /inquiries can sort by; anything else is a 400. */
export const INQUIRY_SORT_COLUMNS = ['createdAt', 'nextFollowupAt'] as const;

/** GET /inquiries query: pagination plus search and filters. Strict, so an
 *  unknown or misspelt parameter is a 400 rather than silently ignored. */
export const inquiryListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.enum(INQUIRY_SORT_COLUMNS).optional(),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
    /** Applicant name, email, or phone digits. */
    search: z.string().trim().min(2).max(100).optional(),
    /** One or more statuses, comma-separated: `OPEN,CONTINUED`. */
    status: z
      .string()
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(z.nativeEnum(INQUIRY_STATUS)).min(1))
      .optional(),
    temperatureId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    assignedToId: z.string().uuid().optional(),
    /** Active leads whose next follow-up falls on today (IST) or before it. */
    followUp: z.enum(['today', 'overdue']).optional(),
  })
  .strict();

export type InquiryListQuery = z.infer<typeof inquiryListQuerySchema>;

export const updateInquirySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    sourceId: z.string().uuid().optional(),
    inquiryTypeId: z.string().uuid().optional(),
    budgetMinPaise: z.coerce.bigint().min(0n).optional(),
    budgetMaxPaise: z.coerce.bigint().min(0n).optional(),
    preferredUnitTypeId: z.string().uuid().optional(),
    temperatureId: z.string().uuid().optional(),
    // Never nullable — a lead's stage isn't unset once assigned, only
    // ever moved to a different stage. See LeadStage's own doc comment.
    stageId: z.string().uuid().optional(),
    status: z.nativeEnum(INQUIRY_STATUS).optional(),
    // Required by InquiryService.update() when status is transitioning
    // to DUMPED (SOP rule 5) — not expressible here since that's
    // conditional on the transition itself, which zod can't see. Not
    // persisted on Inquiry at all; carried through to the
    // InquiryDispositionHistory row only.
    dumpReasonId: z.string().uuid().optional(),
    dumpRemarks: z.string().max(2000).optional(),
    nextFollowupAt: z.coerce.date().nullable().optional(),
    customFields: z.record(z.unknown()).optional(),
  })
  .strict();

export type UpdateInquiryDto = z.infer<typeof updateInquirySchema>;

export const assignInquirySchema = z
  .object({
    toUserId: z.string().uuid(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export type AssignInquiryDto = z.infer<typeof assignInquirySchema>;

// ── Zod Schemas: Lead stage ─────────────────────────────────

export const createLeadStageSchema = z
  .object({
    name: z.string().min(1).max(255),
    sortOrder: z.number().int().min(0).default(0),
    isActive: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  })
  .strict();

export type CreateLeadStageDto = z.infer<typeof createLeadStageSchema>;

/**
 * `reassignToStageId` is required, not optional-with-a-default, whenever
 * `isActive: false` is being set on an occupied stage — enforced in
 * LeadStageService, not expressible statically here (it depends on live
 * occupancy, which zod can't see). Omitting it against an unoccupied
 * stage, or against a stage that's staying active, is fine.
 */
export const updateLeadStageSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    sortOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    reassignToStageId: z.string().uuid().optional(),
  })
  .strict();

export type UpdateLeadStageDto = z.infer<typeof updateLeadStageSchema>;

// ── Zod Schemas: Assignment pool ────────────────────────────

export const upsertAssignmentPoolSchema = z
  .object({
    isActive: z.boolean().default(true),
    pausedReason: z.string().max(100).optional(),
  })
  .strict();

export type UpsertAssignmentPoolDto = z.infer<typeof upsertAssignmentPoolSchema>;

// ── Zod Schemas: Follow-up ──────────────────────────────────

export const createFollowUpSchema = z
  .object({
    typeId: z.string().uuid().optional(),
    notes: z.string().max(5000).optional(),
    outcome: z.nativeEnum(FOLLOW_UP_OUTCOME).optional(),
    // When the interaction happened — distinct from nextActionAt (when
    // the NEXT one is due). Omitted -> FollowUpService.create() defaults
    // to the injected Clock's now(); provided -> lets a rep log a call
    // that happened earlier (yesterday, this morning) rather than only
    // "right now."
    interactionAt: z.coerce.date().optional(),
    // Required by FollowUpService.create() whenever the inquiry is
    // currently OPEN/CONTINUED (SOP rule 2) — not expressible here since
    // that depends on live inquiry state, which zod can't see.
    nextActionAt: z.coerce.date().optional(),
    scheduledAt: z.coerce.date().optional(),
    venue: z.string().max(255).optional(),
  })
  .strict();

export type CreateFollowUpDto = z.infer<typeof createFollowUpSchema>;

export const updateFollowUpSchema = createFollowUpSchema.partial().strict();
export type UpdateFollowUpDto = z.infer<typeof updateFollowUpSchema>;

// ── Zod Schemas: Communication send ─────────────────────────

export const sendCommunicationSchema = z
  .object({
    channel: z.nativeEnum(COMMUNICATION_CHANNEL),
    subject: z.string().max(500).optional(),
    body: z.string().min(1),
  })
  .strict();

export type SendCommunicationDto = z.infer<typeof sendCommunicationSchema>;

// ── Zod Schemas: SMS template (DLT fields) ──────────────────

export const createSmsTemplateSchema = z
  .object({
    name: z.string().min(1).max(255),
    dltTemplateId: z.string().min(1).max(50),
    senderId: z.string().min(1).max(11),
    headerId: z.string().max(50).optional(),
    body: z.string().min(1),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateSmsTemplateDto = z.infer<typeof createSmsTemplateSchema>;

export const updateSmsTemplateSchema = createSmsTemplateSchema.partial().strict();
export type UpdateSmsTemplateDto = z.infer<typeof updateSmsTemplateSchema>;

// ── Zod Schemas: Inquiry import row ─────────────────────────

export const importInquiryRowSchema = z.object({
  applicantName: z.string().min(1).max(255),
  primaryPhone: z.string().min(1).max(20),
  email: z.string().email().max(255).optional(),
  projectCode: z.string().max(50).optional(),
  sourceName: z.string().max(255).optional(),
  inquiryTypeName: z.string().max(255).optional(),
  budgetMinPaise: z.coerce.number().int().min(0).optional(),
  budgetMaxPaise: z.coerce.number().int().min(0).optional(),
  notes: z.string().max(2000).optional(),
});

export type ImportInquiryRow = z.infer<typeof importInquiryRowSchema>;
