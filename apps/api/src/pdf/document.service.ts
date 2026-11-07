import * as fs from 'node:fs';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  GENERATED_DOCUMENT_TYPE,
  NOTIFICATION_EVENT,
  formatInr,
  resolveMergeFields,
  type GeneratedDocumentTypeValue,
  type MergeContext,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { UploadService } from '../inventory/upload.service';
import { LedgerService } from '../postsales/ledger.service';
import { NotificationService } from '../notifications/notification.service';
import { PdfService } from './pdf.service';
import {
  buildReceiptDocDefinition,
  buildStatementDocDefinition,
  buildBrokerStatementDocDefinition,
  buildLetterDocDefinition,
  type ReceiptPdfContext,
  type StatementPdfContext,
  type BrokerStatementPdfContext,
} from './document-templates';

/** Which portal principal is asking for a stored document (see
 * getDocumentBytesForPortal). */
export type PortalDocumentSession = { kind: 'customer' } | { kind: 'broker'; brokerId: string };

/** The document types each portal exposes. The list endpoint and the download
 * endpoint both read these, so what can be fetched by ID always equals what
 * is listed. Allotment/reminder letters stay staff-only surfaces. */
const CUSTOMER_PORTAL_DOCUMENT_TYPES = [
  GENERATED_DOCUMENT_TYPE.STATEMENT,
  GENERATED_DOCUMENT_TYPE.RECEIPT,
  GENERATED_DOCUMENT_TYPE.DEMAND_LETTER,
] as const;
const BROKER_PORTAL_DOCUMENT_TYPES = [GENERATED_DOCUMENT_TYPE.BROKER_STATEMENT] as const;

@Injectable()
export class DocumentService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly pdfService: PdfService,
    private readonly uploadService: UploadService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationService,
  ) {}

  // ── RECEIPT ────────────────────────────────────────────────

  /** Idempotent: an already-generated (non-duplicate) receipt PDF is never re-rendered. */
  async generateReceiptPdf(companyId: string, receiptId: string, actorId: string | null) {
    const existing = await this.systemPrisma.generatedDocument.findFirst({
      where: { companyId, receiptId, documentType: GENERATED_DOCUMENT_TYPE.RECEIPT, isDuplicate: false },
    });
    if (existing) return existing;

    const ctx = await this.buildReceiptContext(companyId, receiptId, false);
    const docDefinition = buildReceiptDocDefinition(ctx);
    const buffer = await this.pdfService.render(docDefinition);

    return this.store(companyId, buffer, {
      documentType: GENERATED_DOCUMENT_TYPE.RECEIPT,
      bookingId: ctx.__bookingId,
      applicantId: ctx.__applicantId,
      receiptId,
      originalName: `${ctx.receiptNumber}.pdf`,
      createdById: actorId,
    });
  }

  /** A reprint is always a NEW, separately-stored, watermarked artifact. */
  async reprintReceiptPdf(companyId: string, receiptId: string, actorId: string | null) {
    const original =
      (await this.systemPrisma.generatedDocument.findFirst({
        where: { companyId, receiptId, documentType: GENERATED_DOCUMENT_TYPE.RECEIPT, isDuplicate: false },
      })) ?? (await this.generateReceiptPdf(companyId, receiptId, actorId));

    const ctx = await this.buildReceiptContext(companyId, receiptId, true);
    const docDefinition = buildReceiptDocDefinition(ctx);
    const buffer = await this.pdfService.render(docDefinition);

    const stored = await this.store(companyId, buffer, {
      documentType: GENERATED_DOCUMENT_TYPE.RECEIPT,
      bookingId: ctx.__bookingId,
      applicantId: ctx.__applicantId,
      receiptId,
      originalName: `${ctx.receiptNumber}-DUPLICATE.pdf`,
      isDuplicate: true,
      sourceDocumentId: original.id,
      createdById: actorId,
    });

    // Keep Receipt.reprintCount in sync (existing Phase 4 service, unmodified).
    await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.receipt.update({ where: { id: receiptId }, data: { reprintCount: { increment: 1 } } }),
      ),
    );

    return stored;
  }

  private async buildReceiptContext(
    companyId: string,
    receiptId: string,
    isDuplicate: boolean,
  ): Promise<ReceiptPdfContext & { __bookingId: string; __applicantId: string }> {
    const receipt = await this.systemPrisma.receipt.findFirst({
      where: { id: receiptId, companyId },
      include: {
        booking: { include: { primaryApplicant: { omit: { panCiphertext: true, panKeyVersion: true } }, company: true } },
        allocations: { include: { installment: true } },
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');

    return {
      __bookingId: receipt.bookingId,
      __applicantId: receipt.booking.primaryApplicantId,
      receiptNumber: receipt.receiptNumber,
      receiptDate: receipt.receiptDate.toISOString().slice(0, 10),
      bookingNumber: receipt.booking.bookingNumber,
      applicantName: receipt.booking.primaryApplicant.name,
      mode: receipt.mode,
      instrumentNumber: receipt.instrumentNumber ?? undefined,
      allocations: receipt.allocations.map((a: { installment: { label: string }; amountPaise: bigint }) => ({
        label: a.installment.label,
        amountFormatted: formatInr(a.amountPaise),
      })),
      grossAmountFormatted: formatInr(receipt.grossAmountPaise),
      companyName: receipt.booking.company.name,
      companyAddress: '',
      isDuplicate,
    };
  }

  // ── STATEMENT ──────────────────────────────────────────────

  /** Always a fresh snapshot (the ledger is live) — never reuses an old statement. */
  async generateStatementPdf(companyId: string, bookingId: string, actorId: string | null) {
    const booking = await this.systemPrisma.booking.findFirst({
      where: { id: bookingId, companyId },
      include: {
        primaryApplicant: { omit: { panCiphertext: true, panKeyVersion: true } },
        company: true,
        unit: { include: { project: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const entries = await this.systemPrisma.ledgerEntry.findMany({
      where: { companyId, bookingId },
      orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
    });

    let running = 0n;
    const rows = entries.map((e: { effectiveDate: Date; entryType: string; reason: string | null; signedAmountPaise: bigint }) => {
      running += e.signedAmountPaise;
      const debit = e.signedAmountPaise > 0n ? e.signedAmountPaise : 0n;
      const credit = e.signedAmountPaise < 0n ? -e.signedAmountPaise : 0n;
      return {
        date: e.effectiveDate.toISOString().slice(0, 10),
        type: e.entryType,
        reason: e.reason ?? '',
        debitFormatted: debit > 0n ? formatInr(debit) : '',
        creditFormatted: credit > 0n ? formatInr(credit) : '',
        balanceFormatted: formatInr(running),
      };
    });

    const ctx: StatementPdfContext = {
      bookingNumber: booking.bookingNumber,
      applicantName: booking.primaryApplicant.name,
      projectName: booking.unit.project.name,
      unitNumber: booking.unit.number,
      statementDate: new Date().toISOString().slice(0, 10),
      entries: rows,
      openingBalanceFormatted: formatInr(0n),
      closingBalanceFormatted: formatInr(running),
      companyName: booking.company.name,
      companyAddress: '',
    };

    const buffer = await this.pdfService.render(buildStatementDocDefinition(ctx));
    return this.store(companyId, buffer, {
      documentType: GENERATED_DOCUMENT_TYPE.STATEMENT,
      bookingId,
      applicantId: booking.primaryApplicantId,
      originalName: `statement-${booking.bookingNumber}-${ctx.statementDate}.pdf`,
      createdById: actorId,
    });
  }

  // ── BROKER STATEMENT (Phase 5 commit 3) ────────────────────

  /** Always a fresh snapshot (the commission ledger is live), same discipline as generateStatementPdf. */
  async generateBrokerStatementPdf(companyId: string, brokerId: string, actorId: string | null) {
    const broker = await this.systemPrisma.broker.findFirst({ where: { id: brokerId, companyId } });
    if (!broker) throw new NotFoundException('Broker not found');

    const entries = await this.systemPrisma.commissionLedgerEntry.findMany({
      where: { companyId, brokerId },
      orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
    });
    const bookingIds = [...new Set(entries.map((e: { bookingId: string }) => e.bookingId))];
    const bookings = await this.systemPrisma.booking.findMany({ where: { companyId, id: { in: bookingIds } }, select: { id: true, bookingNumber: true } });
    const bookingNumbers = new Map(bookings.map((b: { id: string; bookingNumber: string }) => [b.id, b.bookingNumber]));

    let running = 0n;
    const rows = entries.map(
      (e: { effectiveDate: Date; bookingId: string; entryType: string; reason: string | null; signedAmountPaise: bigint }) => {
        running += e.signedAmountPaise;
        const debit = e.signedAmountPaise > 0n ? e.signedAmountPaise : 0n;
        const credit = e.signedAmountPaise < 0n ? -e.signedAmountPaise : 0n;
        return {
          date: e.effectiveDate.toISOString().slice(0, 10),
          bookingNumber: (bookingNumbers.get(e.bookingId) as string) ?? e.bookingId,
          type: e.entryType,
          reason: e.reason ?? '',
          debitFormatted: debit > 0n ? formatInr(debit) : '',
          creditFormatted: credit > 0n ? formatInr(credit) : '',
          balanceFormatted: formatInr(running),
        };
      },
    );

    const ctx: BrokerStatementPdfContext = {
      brokerName: broker.name,
      brokerPhone: broker.phone,
      reraAgentNo: broker.reraAgentNo ?? undefined,
      statementDate: new Date().toISOString().slice(0, 10),
      entries: rows,
      closingBalanceFormatted: formatInr(running),
      companyName: (await this.systemPrisma.company.findFirst({ where: { id: companyId } }))?.name ?? '',
      companyAddress: '',
    };

    const buffer = await this.pdfService.render(buildBrokerStatementDocDefinition(ctx));
    return this.store(companyId, buffer, {
      documentType: GENERATED_DOCUMENT_TYPE.BROKER_STATEMENT,
      brokerId,
      originalName: `broker-statement-${broker.name.replace(/\s+/g, '-')}-${ctx.statementDate}.pdf`,
      createdById: actorId,
    });
  }

  async listForBroker(companyId: string, brokerId: string) {
    return this.systemPrisma.generatedDocument.findMany({
      where: { companyId, brokerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Merge-field-driven letters ─────────────────────────────

  async generateLetterPdf(
    companyId: string,
    documentType: Exclude<GeneratedDocumentTypeValue, 'RECEIPT' | 'STATEMENT'>,
    bookingId: string,
    templateId: string,
    actorId: string | null,
    installmentId?: string,
  ) {
    const booking = await this.systemPrisma.booking.findFirst({
      where: { id: bookingId, companyId },
      include: {
        primaryApplicant: { omit: { panCiphertext: true, panKeyVersion: true } },
        company: true,
        unit: { include: { project: true, floor: { include: { tower: true } } } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const template = await this.systemPrisma.letterTemplate.findFirst({ where: { id: templateId, companyId } });
    if (!template) throw new NotFoundException('Letter template not found');

    const context = await this.buildLetterContext(companyId, documentType, booking, installmentId);
    // resolveMergeFields throws a plain Error (not an HttpException) on a
    // token not in that document type's registry — e.g. a template built
    // for DEMAND_LETTER passed to the allotment-letter endpoint. Left
    // uncaught, that was a raw 500 "Internal server error" instead of a
    // clean explanation of the actual mismatch.
    let subject: string, body: string;
    try {
      subject = resolveMergeFields(template.subject, documentType, context);
      body = resolveMergeFields(template.body, documentType, context);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Template body has an unknown merge field');
    }

    const buffer = await this.pdfService.render(
      buildLetterDocDefinition({ subject, body, companyName: booking.company.name, companyAddress: '' }),
    );

    const doc = await this.store(companyId, buffer, {
      documentType,
      bookingId,
      applicantId: booking.primaryApplicantId,
      templateId,
      originalName: `${documentType.toLowerCase()}-${booking.bookingNumber}.pdf`,
      createdById: actorId,
    });

    // Notification only for DEMAND_LETTER — ALLOTMENT_LETTER/REMINDER_LETTER
    // share this method but aren't in the 5 triggered events. Fired AFTER
    // store()'s withTenantTx commits (CLAUDE.md Phase 1 rule: no external
    // I/O inside a tenant transaction).
    if (documentType === GENERATED_DOCUMENT_TYPE.DEMAND_LETTER && booking.primaryApplicantId) {
      await this.notifications.notify(
        companyId,
        NOTIFICATION_EVENT.DEMAND_LETTER_ISSUED,
        { applicantId: booking.primaryApplicantId },
        subject,
        body,
      );
    }

    return doc;
  }

  private async buildLetterContext(
    companyId: string,
    documentType: GeneratedDocumentTypeValue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    booking: any,
    installmentId?: string,
  ): Promise<MergeContext<GeneratedDocumentTypeValue>> {
    const base = {
      applicantName: booking.primaryApplicant.name,
      bookingNumber: booking.bookingNumber,
      projectName: booking.unit.project.name,
      unitNumber: booking.unit.number,
      towerName: booking.unit.floor?.tower.name ?? '',
      floorLabel: booking.unit.floor?.name ?? '',
      agreedPriceFormatted: formatInr(booking.agreedPricePaise),
      allotmentDate: booking.allotmentDate ? booking.allotmentDate.toISOString().slice(0, 10) : '',
      companyName: booking.company.name,
      companyAddress: '',
    };

    if (documentType === GENERATED_DOCUMENT_TYPE.DEMAND_LETTER || documentType === GENERATED_DOCUMENT_TYPE.REMINDER_LETTER) {
      if (!installmentId) throw new BadRequestException(`${documentType} requires installmentId`);
      const installment = await this.systemPrisma.installment.findFirst({
        where: { id: installmentId, companyId, bookingId: booking.id },
      });
      if (!installment) throw new NotFoundException('Installment not found');
      // Defense in depth: the frontend picker already excludes unraised
      // (dueDate === null) installments, but this endpoint must not trust
      // that — an unraised installment has nothing to demand payment
      // against yet. See internal plan construction-linked-demand-fix.md §2.
      if (installment.dueDate === null) {
        throw new BadRequestException(
          'This installment has not been raised — it has no due date to demand payment against',
        );
      }
      const dueAmountPaise = installment.amountPaise - installment.allocatedPaise;
      const overdueDays = Math.max(
        0,
        Math.floor((Date.now() - installment.dueDate.getTime()) / 86_400_000),
      );
      return {
        ...base,
        installmentLabel: installment.label,
        dueDate: installment.dueDate.toISOString().slice(0, 10),
        dueAmountFormatted: formatInr(dueAmountPaise),
        overdueDays: String(overdueDays),
      } as unknown as MergeContext<GeneratedDocumentTypeValue>;
    }

    return base as unknown as MergeContext<GeneratedDocumentTypeValue>;
  }

  // ── Read / list ────────────────────────────────────────────

  async getDocumentBytes(companyId: string, id: string): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    const doc = await this.systemPrisma.generatedDocument.findFirst({ where: { id, companyId } });
    if (!doc) throw new NotFoundException('Document not found');
    const filePath = this.uploadService.pathFor('document', doc.storedName);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mimeType: doc.mimeType, originalName: doc.originalName };
  }

  /**
   * Portal counterpart to getDocumentBytes(). The lookup goes through the
   * TENANT client under withTenantTx instead of the RLS-bypassing system
   * client — generated_documents_portal_scope (Phase 6 RLS) is what
   * actually restricts this to documents the ambient portal scope can see,
   * the same "RLS is the primary IDOR defense" discipline as every other
   * portal read. Never regenerates: same stored bytes as the staff path.
   */
  async getDocumentBytesForPortal(
    companyId: string,
    id: string,
    session: PortalDocumentSession,
  ): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    // Per-session-type allow-list, the same set the matching list endpoint
    // returns, so a document the portal never lists can't be fetched by ID
    // either (customer: statement/receipt/demand letter; broker: own
    // commission statements only). A broker is also filtered by its own
    // brokerId here as defence in depth behind the RLS policy; a customer's
    // ownership (primary applicant or co-applicant) is decided by RLS alone,
    // since a co-applicant's documents carry the primary's applicantId.
    const where =
      session.kind === 'broker'
        ? { id, brokerId: session.brokerId, documentType: { in: [...BROKER_PORTAL_DOCUMENT_TYPES] } }
        : { id, documentType: { in: [...CUSTOMER_PORTAL_DOCUMENT_TYPES] } };
    const doc = await withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.generatedDocument.findFirst({ where }),
    );
    if (!doc) throw new NotFoundException('Document not found');
    const filePath = this.uploadService.pathFor('document', doc.storedName);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mimeType: doc.mimeType, originalName: doc.originalName };
  }

  /** Portal-scoped list (RLS-restricted), filtered to the 3 self-service
   * document types the customer portal exposes (statement, receipt,
   * demand letter) — allotment/reminder letters stay staff-only surfaces.
   * Broker statements have their own portal-scoped list, listForBrokerPortal
   * below (Phase 6 commit 3), rather than being folded into this one — the
   * two portal principals (applicant, broker) never share a document type. */
  async listForPortal(companyId: string, applicantId: string) {
    return withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.generatedDocument.findMany({
        where: {
          applicantId,
          documentType: { in: [...CUSTOMER_PORTAL_DOCUMENT_TYPES] },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** Broker-portal counterpart to listForPortal — same withTenantTx/RLS
   * discipline, explicit brokerId filter, restricted to BROKER_STATEMENT
   * (the only document type the broker portal exposes). Download reuses
   * getDocumentBytesForPortal unchanged (already broker-safe — see
   * generated_documents_portal_scope's broker branch, CLAUDE.md Phase 6
   * commit 2 decisions). */
  async listForBrokerPortal(companyId: string, brokerId: string) {
    return withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.generatedDocument.findMany({
        where: { brokerId, documentType: { in: [...BROKER_PORTAL_DOCUMENT_TYPES] } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async listForBooking(companyId: string, bookingId: string) {
    return this.systemPrisma.generatedDocument.findMany({
      where: { companyId, bookingId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForApplicant(companyId: string, applicantId: string) {
    return this.systemPrisma.generatedDocument.findMany({
      where: { companyId, applicantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── storage helper ─────────────────────────────────────────

  private async store(
    companyId: string,
    buffer: Buffer,
    opts: {
      documentType: GeneratedDocumentTypeValue;
      bookingId?: string;
      applicantId?: string;
      receiptId?: string;
      brokerId?: string;
      templateId?: string;
      originalName: string;
      isDuplicate?: boolean;
      sourceDocumentId?: string;
      createdById: string | null;
    },
  ) {
    const uploaded = await this.uploadService.validateAndStore(
      { buffer, originalname: opts.originalName, size: buffer.length },
      'document',
    );

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.generatedDocument.create({
          data: {
            companyId,
            bookingId: opts.bookingId,
            applicantId: opts.applicantId,
            receiptId: opts.receiptId,
            brokerId: opts.brokerId,
            documentType: opts.documentType,
            templateId: opts.templateId,
            storedName: uploaded.storageName,
            originalName: opts.originalName,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.size,
            isDuplicate: opts.isDuplicate ?? false,
            sourceDocumentId: opts.sourceDocumentId,
            createdById: opts.createdById,
          },
        }),
      ),
    );
  }
}
