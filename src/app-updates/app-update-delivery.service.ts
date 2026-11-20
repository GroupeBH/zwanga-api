import { Injectable } from '@nestjs/common';
import { AppUpdateDispatchService } from './app-update-dispatch.service';
import { InstallationUpdateDispatchService } from './installation-update-dispatch.service';

export interface UpdateDispatchResult {
  state: 'prepared' | 'disabled' | 'busy' | 'retry_pending';
  queued: number;
}

@Injectable()
export class AppUpdateDeliveryService {
  constructor(private readonly accounts: AppUpdateDispatchService, private readonly installations: InstallationUpdateDispatchService) {}
  // Commit first, then prepare the outbox. Unique event keys prevent duplicate pushes.
  async prepare(releaseId: string): Promise<UpdateDispatchResult> {
    const channels = await Promise.all([this.accounts.enqueueUpdates(releaseId), this.installations.enqueue(releaseId)]);
    const state = channels.some(c => c.state === 'retry_pending') ? 'retry_pending'
      : channels.some(c => c.state === 'busy') ? 'busy'
        : channels.every(c => c.state === 'disabled') ? 'disabled' : 'prepared';
    return { state, queued: channels.reduce((sum, c) => sum + c.queued, 0) };
  }
}
