import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { PrismaClient } from '@openestate/db';
import {
  createReceiptSchema,
  chequeEventSchema,
  reverseReceiptSchema,
  tdsCertificateSchema,
  PERMISSIONS,
  CHEQUE_CLEARANCE_STATUS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { SYSTEM_PRISMA } from '../database/database.module';
import { ReceiptService } from './receipt.service';
import { z } from 'zod';

// An unknown status is a 400 from the validation pipe. Unvalidated, it reached
// Prisma's enum filter and came back as a 500. Empty means "no filter", as the
// Cheque Queue screen's "All" tab and an omitted status always have.
export const chequeQueueQuerySchema = z.object({
  status: z.union([z.nativeEnum(CHEQUE_CLEARANCE_STATUS), z.literal('')]).optional(),
});

class ChequeQueueQueryDto extends createZodDto(chequeQueueQuerySchema) {}
class CreateReceiptDto extends createZodDto(createReceiptSchema) {}
class ChequeEventDto extends createZodDto(chequeEventSchema) {}
class ReverseReceiptDto extends createZodDto(reverseReceiptSchema) {}
class TdsCertificateDto extends createZodDto(tdsCertificateSchema) {}

@ApiTags('Receipts')
@Controller('receipts')
export class ReceiptController {
  constructor(
    private readonly receipts: ReceiptService,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  @Get('cheque-queue')
  @RequirePermissions(PERMISSIONS.POSTSALES_CHEQUE_VERIFY)
  @ApiOperation({ summary: 'Cheque/DD receipts awaiting clearance (RECEIVED/DEPOSITED), oldest first' })
  chequeQueue(@Query() query: ChequeQueueQueryDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    const status = query.status || undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      companyId: u.companyId,
      mode: { in: ['CHEQUE', 'DD'] },
      clearanceStatus: status ? status : { in: ['RECEIVED', 'DEPOSITED'] },
    };
    // Bounced receipts are now correctly isReversed:true (recordChequeEvent
    // sets it alongside the ledger reversal) — excluding isReversed here
    // unconditionally would make the BOUNCED tab always empty.
    if (status !== CHEQUE_CLEARANCE_STATUS.BOUNCED) {
      where.isReversed = false;
    }
    return this.systemPrisma.receipt.findMany({
      where,
      include: {
        booking: { select: { id: true, bookingNumber: true, primaryApplicant: { select: { name: true } } } },
        chequeEvents: { orderBy: { eventDate: 'asc' } },
      },
      orderBy: { receiptDate: 'asc' },
    });
  }

  @Post()
  @RequirePermissions(PERMISSIONS.POSTSALES_RECEIPT_CREATE)
  @ApiOperation({ summary: 'Create a receipt (gap-free number; posts credits; TDS receivable)' })
  create(@Body() dto: CreateReceiptDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.receipts.createReceipt(u.companyId, dto, u.sub);
  }

  @Post(':id/cheque-event')
  @RequirePermissions(PERMISSIONS.POSTSALES_CHEQUE_VERIFY)
  @ApiOperation({ summary: 'Record a cheque lifecycle event (deposit/clear/bounce)' })
  chequeEvent(@Param('id') id: string, @Body() dto: ChequeEventDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.receipts.recordChequeEvent(u.companyId, id, dto, u.sub);
  }

  @Post(':id/reverse')
  @RequirePermissions(PERMISSIONS.POSTSALES_RECEIPT_CANCEL)
  @ApiOperation({ summary: 'Cancel a receipt (append-only reversal + reason)' })
  reverse(@Param('id') id: string, @Body() dto: ReverseReceiptDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.receipts.reverseReceipt(u.companyId, id, dto.reason, u.sub);
  }

  @Post(':id/reprint')
  @RequirePermissions(PERMISSIONS.POSTSALES_RECEIPT_READ)
  @ApiOperation({ summary: 'Flag a reprint (renders DUPLICATE on the PDF)' })
  reprint(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.receipts.markReprint(u.companyId, id);
  }

  @Post('tds/:tdsDeductionId/certificate')
  @RequirePermissions(PERMISSIONS.POSTSALES_TDS_CERTIFICATE)
  @ApiOperation({ summary: 'Record a TDS certificate (zeroes the TDS receivable)' })
  tdsCert(@Param('tdsDeductionId') tdsDeductionId: string, @Body() dto: TdsCertificateDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.receipts.recordTdsCertificate(u.companyId, tdsDeductionId, dto, u.sub);
  }
}
