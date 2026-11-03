import { Module } from '@nestjs/common';
import { ClockProvider } from '../common/clock.provider';
import { InventoryModule } from '../inventory/inventory.module';
import { BrokersModule } from '../brokers/brokers.module';
import { CommissionModule } from '../commission/commission.module';
import { PresalesModule } from '../presales/presales.module';
import { BookingController } from './booking.controller';
import { ReceiptController } from './receipt.controller';
import { RefundController } from './refund.controller';
import { BookingDraftController } from './booking-draft.controller';
import { BookingDraftService } from './booking-draft.service';
import { PlanHistoryController } from './plan-history.controller';
import { StageRaiseController } from './stage-raise.controller';
import { NumberSequenceService } from './number-sequence.service';
import { LedgerService } from './ledger.service';
import { BookingService } from './booking.service';
import { PaymentPlanService } from './payment-plan.service';
import { StageRaiseService } from './stage-raise.service';
import { ReceiptService } from './receipt.service';
import { ExtraChargeService } from './extra-charge.service';
import { InterestService } from './interest.service';
import { BookingInterestRuleService } from './booking-interest-rule.service';
import { InterestScheduler, InterestProcessor } from './interest.scheduler';
import { TransferService } from './transfer.service';
import { CancellationService } from './cancellation.service';
import { RefundService } from './refund.service';
import { BookingCostLineVerifier } from './booking-cost-line-verifier.service';

@Module({
  imports: [InventoryModule, BrokersModule, CommissionModule, PresalesModule],
  controllers: [BookingController, ReceiptController, RefundController, BookingDraftController, PlanHistoryController, StageRaiseController],
  providers: [
    ClockProvider,
    NumberSequenceService,
    LedgerService,
    BookingService,
    PaymentPlanService,
    StageRaiseService,
    ReceiptService,
    ExtraChargeService,
    InterestService,
    BookingInterestRuleService,
    InterestScheduler,
    InterestProcessor,
    TransferService,
    CancellationService,
    RefundService,
    BookingDraftService,
    BookingCostLineVerifier,
  ],
  exports: [LedgerService, BookingService, ReceiptService, InterestService],
})
export class PostsalesModule {}
