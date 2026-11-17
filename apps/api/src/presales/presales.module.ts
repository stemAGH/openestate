import { Module } from '@nestjs/common';
import { ClockProvider, CLOCK } from '../common/clock.provider';
import { PanEncryptionService } from '../common/pan-encryption.service';
import { QueuesModule } from '../queues/queues.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { TeamScopeModule } from '../team-scope/team-scope.module';
import { CommunicationProcessor } from '../queues/communication.processor';
import { ApplicantController } from './applicant.controller';
import { ApplicantService } from './applicant.service';
import { ApplicantContactService } from './applicant-contact.service';
import { AuthModule } from '../auth/auth.module';
import { InquiryController } from './inquiry.controller';
import { InquiryService } from './inquiry.service';
import { AssignmentPoolController } from './assignment-pool.controller';
import { AssignmentService } from './assignment.service';
import { InquiryImportController } from './inquiry-import.controller';
import { InquiryImportService } from './inquiry-import.service';
import { FollowUpController } from './follow-up.controller';
import { FollowUpService } from './follow-up.service';
import { CommunicationController } from './communication.controller';
import { CommunicationService } from './communication.service';
import { EscalationService } from './escalation.service';
import { EscalationProcessor } from './escalation.processor';
import { EscalationScheduler } from './escalation.scheduler';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { LeadStageTransitionService } from './lead-stage-transition.service';
import { InquiryDispositionTransitionService } from './inquiry-disposition-transition.service';

@Module({
  imports: [QueuesModule, CustomFieldsModule, TeamScopeModule, AuthModule],
  controllers: [
    ApplicantController,
    // Must be registered BEFORE InquiryController: both mount under
    // /inquiries, and InquiryController's GET /inquiries/:id would
    // otherwise swallow a request for the literal path
    // GET /inquiries/import-template as id="import-template" — Nest
    // registers routes with Express in controller-array order, and
    // Express's router matches the first pattern that fits, param routes
    // included.
    InquiryImportController,
    InquiryController,
    AssignmentPoolController,
    FollowUpController,
    CommunicationController,
    ReportsController,
  ],
  providers: [
    ClockProvider,
    PanEncryptionService,
    ApplicantService,
    ApplicantContactService,
    InquiryService,
    AssignmentService,
    InquiryImportService,
    FollowUpService,
    CommunicationService,
    CommunicationProcessor,
    EscalationService,
    EscalationProcessor,
    EscalationScheduler,
    ReportsService,
    LeadStageTransitionService,
    InquiryDispositionTransitionService,
  ],
  // ReportsService is exported for DashboardModule, which reuses
  // funnelByStatus rather than reimplementing the status aggregation.
  exports: [CLOCK, AssignmentService, EscalationService, ApplicantService, InquiryService, ReportsService],
})
export class PresalesModule {}
