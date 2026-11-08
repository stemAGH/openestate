import { Prisma } from '@prisma/client';
import { RESTRICTED_FIELDS } from '@openestate/shared';
import {
  tenantTxContext,
  getCurrentUserId,
  getCurrentIpAddress,
} from './tenant-context';

const AUDITED_MODELS = new Set([
  'User',
  'Role',
  'RolePermission',
  'Company',
  'CompanyConfig',
  'CustomFieldDefinition',
  'InquirySource',
  'InquiryType',
  'FollowUpType',
  'CommunicationType',
  'AreaLocation',
  'ProjectType',
  'DocumentType',
  'LetterTemplate',
  'Bank',
  'ReceiptType',
  'RegistrationType',
  'ChargeType',
  'GstRate',
  'TdsRule',
  'InterestRule',
  'TransferFeeRule',
  'PaymentPlanTemplate',
  'UnitType',
  'PlcType',
  'Project',
  'Tower',
  'Floor',
  'Unit',
  'UnitPlc',
  'UnitCharge',
  'UnitRateRevision',
  'UnitStatusChange',
  'Applicant',
  'ApplicantConsent',
  'ApplicantMerge',
  'InquiryTemperature',
  'Inquiry',
  'InquiryAssignment',
  'ProjectAssignmentPool',
  'FollowUp',
  'SmsTemplate',
  'CommunicationLog',
  // Phase 4: audit the high-level financial ENTITIES. The low-level ledger
  // mechanism rows (LedgerEntry, ReceiptAllocation, BookingCostLine,
  // InterestAccrual, ChequeStatusEvent, TdsDeduction, NumberSequence) are
  // intentionally NOT audited here — they ARE the append-only financial
  // record (DB-trigger-enforced), so mirroring each into audit_logs is pure
  // noise and would balloon under the property tests.
  'CancellationRule',
  'ApplicantAddress',
  'ApplicantDocument',
  'Booking',
  'BookingCoApplicant',
  'PaymentPlan',
  'Receipt',
  'Transfer',
  'Cancellation',
  'Refund',
  'PaymentVoucher',
  'ExtraCharge',
  'TdsCertificate',
  'PaymentPlanMilestone',
  'GeneratedDocument',
  'DocumentDispatch',
  // Phase 5: audit the high-level broker/commission ENTITIES (same split
  // as Phase 4's ledger mechanism vs. entity distinction above).
  // CommissionLedgerEntry is NOT audited — it IS the append-only
  // financial record (DB-trigger-enforced), mirroring it would be pure
  // noise, same reasoning as LedgerEntry. BrokerBookingCommission is NOT
  // audited either — it's a system-computed snapshot (mechanism, like
  // NumberSequence), never edited by a human.
  'Broker',
  'BrokerBankDetail',
  'BrokerCommissionRule',
  'BrokerCommissionSlab',
  'CommissionPayment',
  'BrokerNoc',
  // Phase 6: audit the staff-accountable portal ENTITIES. TicketMessage
  // is NOT audited — same "it already IS the record of itself" reasoning
  // as ledger/message-thread mechanism rows elsewhere. PortalPasswordReset
  // is NOT audited — created by an async worker, not a staff/portal
  // action, and its tokenHash is security-sensitive metadata, not a
  // business fact.
  'ApplicantChangeRequest',
  'TicketCategory',
  'Ticket',
  'ConstructionUpdate',
  'ConstructionUpdateMedia',
  'PortalInvite',
  // Phase 7: plugin installation lifecycle is a staff-accountable
  // action, audited like any other admin config change. configCiphertext
  // is redacted below, same treatment as panCiphertext/tokenHash.
  'PluginInstallation',
  // Phase 7 commit 2: WebhookEndpoint/LeadSourceApiKey are staff CRUD
  // (audited, secrets redacted below). WebhookDelivery is audited for
  // the same reason DocumentDispatch is — it mutates status
  // (PENDING → SUCCESS|EXHAUSTED) as a record of a real event, not a
  // pure per-attempt mechanism row. WebhookDeliveryAttempt is
  // deliberately NOT audited — it IS the append-only attempt log itself
  // (same reasoning as ChequeStatusEvent/LedgerEntry above); auditing it
  // too would be redundant noise on redundant noise.
  'WebhookEndpoint',
  'WebhookDelivery',
  'LeadSourceApiKey',
]);

const SENSITIVE_FIELDS = new Set([
  'passwordHash',
  'password_hash',
  'totpSecret',
  'totp_secret',
  'recoveryCodes',
  'recovery_codes',
  // Phase 5: never let a broker's encrypted PAN land in an audit diff,
  // even in ciphertext form.
  'panCiphertext',
  'pan_ciphertext',
  // Phase 6: PortalInvite is audited (see AUDITED_MODELS) but its
  // tokenHash must never land in the diff, same reasoning as
  // passwordHash/totpSecret above.
  'tokenHash',
  'token_hash',
  // Phase 7: plugin config secrets (and, in a later commit, webhook
  // signing secrets and lead API key hashes) — same reasoning as
  // panCiphertext/tokenHash above: the encrypted blob itself is
  // redundant-but-safe to redact from audit diffs, keeps rows small and
  // honest.
  'configCiphertext',
  'config_ciphertext',
  // Phase 7 commit 2: webhook signing secret ciphertext and lead API key
  // hash — same reasoning as configCiphertext/tokenHash above.
  'secretCiphertext',
  'secret_ciphertext',
  'keyHash',
  'key_hash',
]);

// Recursive: a secret nested inside a write input (a nested create, a
// JSON column) is redacted too. Only plain objects and arrays are walked;
// anything else (Date, Prisma.Decimal) is left whole for JSON.stringify,
// which uses its own toJSON.
function sanitize(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(sanitize);
  if (!data || typeof data !== 'object') return data;
  const proto = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    // Restricted fields (an identifier's encrypted value and its key
    // version) are left out of the snapshot entirely, not even as a
    // placeholder; the API drops them from older rows on the way out.
    if (RESTRICTED_FIELDS.has(k)) continue;
    out[k] = SENSITIVE_FIELDS.has(k) ? '[REDACTED]' : sanitize(v);
  }
  return out;
}

function extractId(result: unknown): string {
  if (result && typeof result === 'object' && 'id' in result) {
    return String((result as Record<string, unknown>).id);
  }
  return 'unknown';
}

async function writeAuditRow(
  entityType: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  const store = tenantTxContext.getStore();
  if (!store?.tx) {
    // Log-only for now (docs/todo.md tracks whether this should throw).
    // Names the row, never its values.
    console.error(`[audit] no transaction in context: ${entityType} ${action} ${entityId} was not audited`);
    return;
  }

  // The transaction's own company: always what RLS's WITH CHECK compares
  // against, so the INSERT can't fail on a context/transaction mismatch.
  const companyId = store.companyId;
  const userId = getCurrentUserId() ?? null;
  const ipAddress = getCurrentIpAddress() ?? null;
  const beforeJson = before ? toJson(before) : null;
  const afterJson = after ? toJson(after) : null;

  // audit_logs.created_at is TIMESTAMP without time zone and the app reads every
  // such column as UTC. A bare NOW() stores the SESSION's local clock, off by the
  // zone offset (5 h 30 min on an Asia/Kolkata server), so it is converted
  // explicitly (same pattern as the TOTP lockout).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (store.tx as any).$executeRaw`
    INSERT INTO audit_logs (id, company_id, user_id, entity_type, entity_id, action, before, after, ip_address, created_at)
    VALUES (
      gen_random_uuid(),
      ${companyId}::uuid,
      ${userId}::uuid,
      ${entityType},
      ${entityId},
      ${action},
      ${beforeJson}::jsonb,
      ${afterJson}::jsonb,
      ${ipAddress},
      NOW() AT TIME ZONE 'UTC'
    )`;
}

// BigInt money values must not depend on main.ts's global
// BigInt.prototype.toJSON patch — without it JSON.stringify throws.
function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * Writes the audit row, or fails the write. Fail-closed: once the audit
 * INSERT has failed, Postgres has aborted the transaction and the business
 * write can't commit anyway — swallowing the error (as this code did
 * until v0.7.1) made Prisma's COMMIT a silent rollback, so the caller got
 * a success response, row and all, for a write that was never saved.
 * Rethrowing makes that failure visible. Any error in here — building
 * the diff or the INSERT — is rethrown: no write commits without its row.
 * The log names the row (model, action, id) and the error's code, never
 * field values: a Postgres error message can echo them.
 */
async function auditOrThrow(
  model: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  result: unknown,
  diff: () => [unknown, unknown],
): Promise<void> {
  const entityId = extractId(result);
  try {
    const [before, after] = diff();
    await writeAuditRow(model, entityId, action, before, after);
  } catch (err) {
    const e = err as { code?: string; name?: string };
    console.error(`[audit] failed to write ${model} ${action} ${entityId} (${e?.code ?? e?.name ?? 'error'}); the write is rolled back`);
    throw err;
  }
}

/**
 * Prisma extension that writes an immutable audit row for every
 * create/update/delete on audited domain models.
 *
 * Audit rows are written via the same transaction client stored in
 * `tenantTxContext` — guaranteeing atomicity with the original
 * operation and inheriting the RLS session variable. If no tenant
 * transaction is active the audit write is skipped and logged; system
 * services write their own audit rows via the system client.
 */
export function auditExtension() {
  return Prisma.defineExtension({
    query: {
      $allModels: {
        async create({ model, args, query }) {
          const result = await query(args);
          if (model && AUDITED_MODELS.has(model)) {
            await auditOrThrow(model, 'CREATE', result, () => [null, sanitize(result)]);
          }
          return result;
        },

        async update({ model, args, query }) {
          const result = await query(args);
          if (model && AUDITED_MODELS.has(model)) {
            await auditOrThrow(model, 'UPDATE', result, () => [null, sanitize(args.data)]);
          }
          return result;
        },

        async delete({ model, args, query }) {
          const result = await query(args);
          if (model && AUDITED_MODELS.has(model)) {
            await auditOrThrow(model, 'DELETE', result, () => [sanitize(result), null]);
          }
          return result;
        },
      },
    },
  });
}
