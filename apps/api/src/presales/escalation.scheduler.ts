import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ESCALATION_QUEUE } from '../queues/queues.module';

const TICK_INTERVAL_MS = 30 * 60 * 1000;

@Injectable()
export class EscalationScheduler implements OnModuleInit {
  constructor(
    @InjectQueue(ESCALATION_QUEUE)
    private readonly escalationQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.escalationQueue.add(
      'tick',
      {},
      {
        repeat: { every: TICK_INTERVAL_MS },
        jobId: 'escalation-tick',
      },
    );
    // v0.10.1: once a day, purge deleted leads past each company's retention period.
    await this.escalationQueue.add('lead-purge-tick', {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'lead-purge-tick' });
  }
}
