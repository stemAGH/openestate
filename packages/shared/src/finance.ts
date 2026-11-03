import { z } from 'zod';

// ── Enums (mirror the Prisma schema) ────────────────────────

export const BOOKING_STATUS = {
  APPLICATION: 'APPLICATION',
  BOOKED: 'BOOKED',
  ALLOTTED: 'ALLOTTED',
  REGISTERED: 'REGISTERED',
  CANCELLED: 'CANCELLED',
  SURRENDERED: 'SURRENDERED',
  TRANSFERRED_OUT: 'TRANSFERRED_OUT',
} as const;
export type BookingStatusValue = (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

export const LEDGER_ENTRY_TYPE = {
  CHARGE: 'CHARGE',
  EXTRA_CHARGE: 'EXTRA_CHARGE',
  RECEIPT_ALLOC: 'RECEIPT_ALLOC',
  INTEREST: 'INTEREST',
  INTEREST_WAIVER: 'INTEREST_WAIVER',
  BOUNCE_REVERSAL: 'BOUNCE_REVERSAL',
  BOUNCE_CHARGE: 'BOUNCE_CHARGE',
  REFUND_APPROVED: 'REFUND_APPROVED',
  REFUND_BOUNCE_REVERSAL: 'REFUND_BOUNCE_REVERSAL',
  TRANSFER_CARRY_OUT: 'TRANSFER_CARRY_OUT',
  TRANSFER_CARRY_IN: 'TRANSFER_CARRY_IN',
  TRANSFER_FEE: 'TRANSFER_FEE',
  CANCELLATION_SETTLEMENT: 'CANCELLATION_SETTLEMENT',
  CANCELLATION_DEDUCTION: 'CANCELLATION_DEDUCTION',
  TDS_RECEIVABLE: 'TDS_RECEIVABLE',
  TDS_CERT_ADJUSTMENT: 'TDS_CERT_ADJUSTMENT',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type LedgerEntryTypeValue = (typeof LEDGER_ENTRY_TYPE)[keyof typeof LEDGER_ENTRY_TYPE];

/**
 * Entry types that represent charges the COMPANY levies (fees/deductions
 * retained by the company), as opposed to money moving between the customer
 * and their property liability. The transfer/cancellation "money invariant"
 * tests exclude these when asserting that total money across ledgers is
 * conserved — a fee is legitimately new money, not a conservation breach.
 */
export const COMPANY_LEVY_ENTRY_TYPES: readonly LedgerEntryTypeValue[] = [
  LEDGER_ENTRY_TYPE.TRANSFER_FEE,
  LEDGER_ENTRY_TYPE.CANCELLATION_DEDUCTION,
  LEDGER_ENTRY_TYPE.BOUNCE_CHARGE,
];

export const RECEIPT_MODE = {
  CASH: 'CASH',
  CHEQUE: 'CHEQUE',
  DD: 'DD',
  NEFT: 'NEFT',
  RTGS: 'RTGS',
  UPI: 'UPI',
  CARD: 'CARD',
} as const;
export type ReceiptModeValue = (typeof RECEIPT_MODE)[keyof typeof RECEIPT_MODE];

export const CHEQUE_CLEARANCE_STATUS = {
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  RECEIVED: 'RECEIVED',
  DEPOSITED: 'DEPOSITED',
  CLEARED: 'CLEARED',
  BOUNCED: 'BOUNCED',
} as const;
export type ChequeClearanceStatusValue =
  (typeof CHEQUE_CLEARANCE_STATUS)[keyof typeof CHEQUE_CLEARANCE_STATUS];

export const INSTALLMENT_STATUS = {
  UNPAID: 'UNPAID',
  PART_PAID: 'PART_PAID',
  PAID: 'PAID',
} as const;
export type InstallmentStatusValue = (typeof INSTALLMENT_STATUS)[keyof typeof INSTALLMENT_STATUS];

/**
 * DATE_LINKED: due at bookingDate + dueOffsetDays (original behaviour).
 * STAGE_LINKED: no due date until a staff user raises the construction
 * stage it represents. See docs/plans/construction-linked-demand-fix.md —
 * this distinction is the fix for a real correctness bug where every
 * milestone previously behaved as DATE_LINKED regardless of what it was
 * actually meant to represent.
 */
export const MILESTONE_TYPE = {
  DATE_LINKED: 'DATE_LINKED',
  STAGE_LINKED: 'STAGE_LINKED',
} as const;
export type MilestoneTypeValue = (typeof MILESTONE_TYPE)[keyof typeof MILESTONE_TYPE];

export const COST_LINE_KIND = {
  BASE: 'BASE',
  PLC: 'PLC',
  PARKING: 'PARKING',
  CLUB: 'CLUB',
  MAINTENANCE: 'MAINTENANCE',
  OTHER: 'OTHER',
} as const;
export type CostLineKindValue = (typeof COST_LINE_KIND)[keyof typeof COST_LINE_KIND];

export const REFUND_STATUS = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  PAID: 'PAID',
  REJECTED: 'REJECTED',
} as const;
export type RefundStatusValue = (typeof REFUND_STATUS)[keyof typeof REFUND_STATUS];

export const CANCELLATION_TYPE = { CANCEL: 'CANCEL', SURRENDER: 'SURRENDER' } as const;
export type CancellationTypeValue = (typeof CANCELLATION_TYPE)[keyof typeof CANCELLATION_TYPE];

export const TRANSFER_TYPE = { UNIT: 'UNIT', APPLICANT: 'APPLICANT' } as const;
export type TransferTypeValue = (typeof TRANSFER_TYPE)[keyof typeof TRANSFER_TYPE];

export const VOUCHER_STATUS = { ISSUED: 'ISSUED', CLEARED: 'CLEARED', BOUNCED: 'BOUNCED' } as const;
export type VoucherStatusValue = (typeof VOUCHER_STATUS)[keyof typeof VOUCHER_STATUS];
export const VOUCHER_STATUS_ISSUED = VOUCHER_STATUS.ISSUED;

export const INTEREST_RATE_TYPE = { SIMPLE: 'SIMPLE', COMPOUND: 'COMPOUND' } as const;
export type InterestRateTypeValue = (typeof INTEREST_RATE_TYPE)[keyof typeof INTEREST_RATE_TYPE];

// ── Financial-year label ────────────────────────────────────

/**
 * Indian financial-year label for a date, e.g. 1-Jun-2026 with fyStartMonth=4
 * → "2026-27"; 1-Feb-2027 → "2026-27". Used to scope the gap-free
 * receipt-number sequence per company per FY.
 */
export function financialYearLabel(date: Date, fyStartMonth = 4): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 1-12
  const startYear = m >= fyStartMonth ? y : y - 1;
  const endYY = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYY}`;
}

/** Format an allocated receipt number, e.g. RCP/2026-27/000123. */
export function formatReceiptNumber(fyLabel: string, seq: number): string {
  return `RCP/${fyLabel}/${String(seq).padStart(6, '0')}`;
}

/** Format a booking number, e.g. BKG/2026-27/000045. */
export function formatBookingNumber(fyLabel: string, seq: number): string {
  return `BKG/${fyLabel}/${String(seq).padStart(6, '0')}`;
}

// ── GST place-of-supply ─────────────────────────────────────

/**
 * Intra-state (CGST+SGST) when the supplier's GST state code equals the
 * place-of-supply state code; otherwise inter-state (IGST). For immovable
 * property the place of supply is the PROPERTY location (IGST Act §12(3)(a)),
 * snapshotted on the booking — not the customer's residential state.
 *
 * THROWS if either state code is missing, rather than defaulting to
 * intra-state. A silent intra-state default previously meant any company
 * whose gstStateCode was never configured (every install created before
 * the column existed, or any install where an admin simply hasn't visited
 * Company Config yet) got CGST+SGST on every booking regardless of whether
 * the property's actual place of supply was in a different state — wrong
 * tax on a real invoice, with no error to notice it by. A blocked booking
 * is a worse UX than a silently wrong one only if you never find out;
 * here you always find out.
 */
export function isIntraStateSupply(
  companyStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined,
): boolean {
  if (!companyStateCode) {
    throw new Error(
      "Cannot determine GST treatment: the company's GST state code is not set " +
        '(CompanyConfig.gstStateCode). Set it in Company Config before booking or ' +
        'adding charges — GST treatment must never silently default to intra-state.',
    );
  }
  if (!placeOfSupplyStateCode) {
    throw new Error(
      'Cannot determine GST treatment: the place-of-supply state code is not set ' +
        "(no explicit override, and the property's project has no Area Location " +
        'state code). Set the Area Location state code, or pass an explicit ' +
        'place-of-supply state code — GST treatment must never silently default to intra-state.',
    );
  }
  return companyStateCode === placeOfSupplyStateCode;
}

// ── Phase 5 hand-off: commission clawback contract ──────────

/**
 * Emitted (as a typed record; no logic yet) when a booking is cancelled or
 * surrendered, so Phase 5's commission engine can claw back any commission
 * already accrued/paid to a broker on that booking. Stable contract only.
 */
export interface BookingCancelledEvent {
  type: 'bookingCancelled';
  companyId: string;
  bookingId: string;
  cancellationType: CancellationTypeValue;
  cancelledAt: string; // ISO
  /** Broker attribution is added in Phase 5 when bookings carry a brokerId. */
  brokerId?: string | null;
}

// ── Zod schemas (API DTOs) ──────────────────────────────────

const paise = () => z.coerce.bigint().min(0n);
const isoDate = () => z.coerce.date();

export const bookingCostLineInputSchema = z
  .object({
    kind: z.nativeEnum(COST_LINE_KIND),
    chargeTypeId: z.string().uuid().optional(),
    label: z.string().min(1).max(255),
    baseAmountPaise: paise(),
    gstRateId: z.string().uuid().optional(),
  })
  .strict();
export type BookingCostLineInput = z.infer<typeof bookingCostLineInputSchema>;

export const createBookingSchema = z
  .object({
    unitId: z.string().uuid(),
    primaryApplicantId: z.string().uuid(),
    coApplicantIds: z.array(z.string().uuid()).max(5).default([]),
    bookingDate: isoDate(),
    /** Overrides the default (project location) place-of-supply at creation. */
    placeOfSupplyStateCode: z.string().length(2).optional(),
    paymentPlanTemplateId: z.string().uuid().optional(),
    costLines: z.array(bookingCostLineInputSchema).min(1),
  })
  .strict();
export type CreateBookingDto = z.infer<typeof createBookingSchema>;

export const installmentInputSchema = z
  .object({
    label: z.string().min(1).max(255),
    dueDate: isoDate(),
    amountPaise: paise().optional(),
    milestonePercent: z.coerce.number().min(0).max(100).optional(),
  })
  .strict()
  .refine((d) => d.amountPaise != null || d.milestonePercent != null, {
    message: 'Each installment needs amountPaise or milestonePercent',
  });
export type InstallmentInput = z.infer<typeof installmentInputSchema>;

export const createPaymentPlanSchema = z
  .object({
    name: z.string().min(1).max(255),
    isCustom: z.boolean().default(true),
    installments: z.array(installmentInputSchema).min(1),
  })
  .strict();
export type CreatePaymentPlanDto = z.infer<typeof createPaymentPlanSchema>;

/** Bulk-raise a STAGE_LINKED milestone for every eligible booking in one
 * project. See docs/plans/construction-linked-demand-fix.md §1.5-1.6. */
export const raiseStageSchema = z
  .object({
    templateId: z.string().uuid(),
    milestoneSeq: z.coerce.number().int().min(1),
    stageCompletedOn: isoDate(),
  })
  .strict();
export type RaiseStageDto = z.infer<typeof raiseStageSchema>;

export const receiptAllocationInputSchema = z
  .object({
    installmentId: z.string().uuid(),
    amountPaise: z.coerce.bigint().min(1n),
  })
  .strict();

export const createReceiptSchema = z
  .object({
    bookingId: z.string().uuid(),
    receiptDate: isoDate(),
    mode: z.nativeEnum(RECEIPT_MODE),
    grossAmountPaise: z.coerce.bigint().min(1n),
    allocations: z.array(receiptAllocationInputSchema).min(1),
    receiptTypeId: z.string().uuid().optional(),
    bankId: z.string().uuid().optional(),
    instrumentNumber: z.string().max(50).optional(),
    instrumentDate: isoDate().optional(),
    utr: z.string().max(50).optional(),
    /** TDS withheld by the buyer on this receipt (194-IA). 0/omitted = none. */
    tdsDeductedPaise: z.coerce.bigint().min(0n).default(0n),
  })
  .strict();
export type CreateReceiptDto = z.infer<typeof createReceiptSchema>;

export const chequeEventSchema = z
  .object({
    status: z.enum(['DEPOSITED', 'CLEARED', 'BOUNCED']),
    eventDate: isoDate(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type ChequeEventDto = z.infer<typeof chequeEventSchema>;

export const reverseReceiptSchema = z
  .object({ reason: z.string().min(1).max(500) })
  .strict();
export type ReverseReceiptDto = z.infer<typeof reverseReceiptSchema>;

export const extraChargeSchema = z
  .object({
    chargeTypeId: z.string().uuid().optional(),
    label: z.string().min(1).max(255),
    baseAmountPaise: paise(),
    gstRateId: z.string().uuid().optional(),
    effectiveDate: isoDate().optional(),
  })
  .strict();
export type ExtraChargeDto = z.infer<typeof extraChargeSchema>;

export const interestWaiverSchema = z
  .object({
    amountPaise: z.coerce.bigint().min(1n),
    reason: z.string().min(1).max(500),
    effectiveDate: isoDate().optional(),
  })
  .strict();
export type InterestWaiverDto = z.infer<typeof interestWaiverSchema>;

/** PUT /bookings/:id/interest-rule. null removes the rule. */
export const setBookingInterestRuleSchema = z
  .object({ interestRuleId: z.string().uuid().nullable() })
  .strict();
export type SetBookingInterestRuleDto = z.infer<typeof setBookingInterestRuleSchema>;

export const tdsCertificateSchema = z
  .object({
    certificateNumber: z.string().min(1).max(50),
    certificateDate: isoDate(),
  })
  .strict();
export type TdsCertificateDto = z.infer<typeof tdsCertificateSchema>;

export const createTransferSchema = z
  .object({
    transferType: z.nativeEnum(TRANSFER_TYPE),
    /** For UNIT transfer: the destination unit. */
    toUnitId: z.string().uuid().optional(),
    /** For APPLICANT transfer: the new primary applicant. */
    toApplicantId: z.string().uuid().optional(),
    transferFeeRuleId: z.string().uuid().optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type CreateTransferDto = z.infer<typeof createTransferSchema>;

export const cancellationSchema = z
  .object({
    cancellationType: z.nativeEnum(CANCELLATION_TYPE),
    cancellationRuleId: z.string().uuid().optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type CancellationDto = z.infer<typeof cancellationSchema>;

export const requestRefundSchema = z
  .object({
    amountPaise: z.coerce.bigint().min(1n),
    mode: z.nativeEnum(RECEIPT_MODE).optional(),
  })
  .strict();
export type RequestRefundDto = z.infer<typeof requestRefundSchema>;

export const payRefundSchema = z
  .object({
    mode: z.nativeEnum(RECEIPT_MODE),
    bankId: z.string().uuid().optional(),
    instrumentNumber: z.string().max(50).optional(),
    instrumentDate: isoDate().optional(),
  })
  .strict();
export type PayRefundDto = z.infer<typeof payRefundSchema>;
