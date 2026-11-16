import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaClient } from '@openestate/db';
import { ESCALATION_QUEUE } from '../queues/queues.module';
import { SYSTEM_PRISMA } from '../database/database.module';
import { EscalationService } from './escalation.service';
import { InquiryService } from './inquiry.service';

interface CompanyEscalationJobData {
  companyId: string;
}

@Processor(ESCALATION_QUEUE)
export class EscalationProcessor extends WorkerHost {
  constructor(
    private readonly escalationService: EscalationService,
    private readonly inquiries: InquiryService,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {
    super();
  }

  async process(job: Job<CompanyEscalationJobData>): Promise<unknown> {
    if (job.name === 'tick') {
      return this.escalationService.dispatchTick();
    }
    if (job.name === 'company-escalation') {
      return this.escalationService.runForCompany(job.data.companyId);
    }
    // v0.10.1: the daily purge of deleted leads past each company's retention period.
    if (job.name === 'lead-purge-tick') {
      const companies = await this.systemPrisma.company.findMany({ where: { isActive: true }, select: { id: true } });
      let purged = 0;
      for (const c of companies) purged += (await this.inquiries.purgeDeleted(c.id)).purged;
      return { purged };
    }
    return undefined;
  }
}
