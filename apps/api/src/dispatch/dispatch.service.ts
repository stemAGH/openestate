import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { DISPATCH_STATUS, maskPhone, type DispatchChannelValue } from '@openestate/shared';

/** A list view: an SMS recipient is a phone number, so it shows the last 4 digits. */
function maskSmsRecipients<T extends { channel: string; recipientAddress: string }>(rows: T[]): T[] {
  return rows.map((r) => (r.channel === 'SMS' ? { ...r, recipientAddress: maskPhone(r.recipientAddress) } : r));
}
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { DISPATCH_QUEUE } from '../queues/queues.module';

/**
 * Append-only dispatch history: a DocumentDispatch row is created once and
 * never edited except by the processor's own status transition
 * (QUEUED → SENT|FAILED). A failed send is retried by creating a NEW row
 * referencing the original via attemptOfDispatchId — never by re-queuing the
 * same row — so the full attempt history for a document is always visible.
 */
@Injectable()
export class DispatchService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @InjectQueue(DISPATCH_QUEUE)
    private readonly queue: Queue,
  ) {}

  async send(
    companyId: string,
    generatedDocumentId: string,
    recipientAddress: string,
    channel: DispatchChannelValue,
    actorId: string | null,
  ) {
    const doc = await this.systemPrisma.generatedDocument.findFirst({
      where: { id: generatedDocumentId, companyId },
    });
    if (!doc) throw new NotFoundException('Generated document not found');

    const templateSnapshot = `Please find attached your ${doc.documentType.replace(/_/g, ' ').toLowerCase()} (${doc.originalName}).`;

    const dispatch = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.documentDispatch.create({
          data: {
            companyId,
            generatedDocumentId,
            bookingId: doc.bookingId,
            applicantId: doc.applicantId,
            recipientAddress,
            channel,
            templateSnapshot,
            status: DISPATCH_STATUS.QUEUED,
            createdById: actorId,
          },
        }),
      ),
    );

    // Enqueue AFTER the tx commits — Redis I/O never happens inside withTenantTx.
    await this.queue.add('send', { companyId, dispatchId: dispatch.id });

    return dispatch;
  }

  /** Retries a FAILED dispatch by creating a new attempt row, never mutating the original. */
  async retry(companyId: string, dispatchId: string, actorId: string | null) {
    const original = await this.systemPrisma.documentDispatch.findFirst({
      where: { id: dispatchId, companyId },
    });
    if (!original) throw new NotFoundException('Dispatch not found');
    if (original.status !== DISPATCH_STATUS.FAILED) {
      throw new ConflictException(`Only a FAILED dispatch can be retried (current status: ${original.status})`);
    }

    const attempt = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.documentDispatch.create({
          data: {
            companyId,
            generatedDocumentId: original.generatedDocumentId,
            bookingId: original.bookingId,
            applicantId: original.applicantId,
            recipientAddress: original.recipientAddress,
            channel: original.channel,
            templateSnapshot: original.templateSnapshot,
            status: DISPATCH_STATUS.QUEUED,
            attemptOfDispatchId: original.id,
            createdById: actorId,
          },
        }),
      ),
    );

    await this.queue.add('send', { companyId, dispatchId: attempt.id });

    return attempt;
  }

  async historyForBooking(companyId: string, bookingId: string) {
    return maskSmsRecipients(
      await this.systemPrisma.documentDispatch.findMany({
        where: { companyId, bookingId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async historyForApplicant(companyId: string, applicantId: string) {
    return maskSmsRecipients(
      await this.systemPrisma.documentDispatch.findMany({
        where: { companyId, applicantId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}
