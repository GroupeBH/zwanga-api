import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
@Injectable()
export class MobileConfig {
  constructor(private readonly config: ConfigService) {}
  get enabled() {
    return this.config.get('MOBILE_OPERATIONS_ENABLED') === 'true';
  }
  get campaignsEnabled() {
    return (
      this.enabled && this.config.get('MOBILE_CAMPAIGNS_ENABLED') === 'true'
    );
  }
  get retentionDays() {
    const n = Number(
      this.config.get('MOBILE_INSTALLATION_RETENTION_DAYS') ?? 180,
    );
    return Number.isInteger(n) && n >= 90 && n <= 730 ? n : 180;
  }
  assertEnabled() {
    if (!this.enabled)
      throw new ServiceUnavailableException({
        code: 'MOBILE_OPERATIONS_DISABLED',
        message: 'Supervision mobile non activée.',
      });
  }
}
