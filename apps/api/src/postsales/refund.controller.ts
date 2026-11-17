import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { requestRefundSchema, payRefundSchema, PERMISSIONS, hasNoNul, NO_NUL_MESSAGE } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { RefundService } from './refund.service';

class RequestRefundDto extends createZodDto(requestRefundSchema) {}
class PayRefundDto extends createZodDto(payRefundSchema) {}
export const rejectRefundSchema = z.object({ reason: z.string().trim().min(3).max(500).refine(hasNoNul, NO_NUL_MESSAGE) }).strict();
class RejectRefundDto extends createZodDto(rejectRefundSchema) {}

@ApiTags('Refunds')
@Controller()
export class RefundController {
  constructor(private readonly refunds: RefundService) {}

  @Post('bookings/:bookingId/refunds')
  @RequirePermissions(PERMISSIONS.POSTSALES_REFUND_REQUEST)
  @ApiOperation({ summary: 'Request a refund' })
  request(@Param('bookingId') bookingId: string, @Body() dto: RequestRefundDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.refunds.request(u.companyId, bookingId, dto, u.sub);
  }

  @Post('refunds/:id/approve')
  @RequirePermissions(PERMISSIONS.POSTSALES_REFUND_APPROVE)
  @ApiOperation({ summary: 'Approve a refund (posts REFUND_APPROVED debit)' })
  approve(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.refunds.approve(u.companyId, id, u.sub);
  }

  @Post('refunds/:id/reject')
  @RequirePermissions(PERMISSIONS.POSTSALES_REFUND_APPROVE)
  @ApiOperation({ summary: 'Reject a requested refund (posts nothing; the reason is audited)' })
  reject(@Param('id') id: string, @Body() dto: RejectRefundDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.refunds.reject(u.companyId, id, dto.reason, u.sub);
  }

  @Post('refunds/:id/pay')
  @RequirePermissions(PERMISSIONS.POSTSALES_REFUND_PAY)
  @ApiOperation({ summary: 'Pay a refund (records a payment voucher outflow)' })
  pay(@Param('id') id: string, @Body() dto: PayRefundDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.refunds.pay(u.companyId, id, dto, u.sub);
  }

  @Post('payment-vouchers/:id/bounced')
  @RequirePermissions(PERMISSIONS.POSTSALES_REFUND_PAY)
  @ApiOperation({ summary: 'Mark a refund cheque bounced (re-opens the obligation)' })
  voucherBounced(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.refunds.voucherBounced(u.companyId, id, u.sub);
  }
}
