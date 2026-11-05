import { ConfigService } from '@nestjs/config';
import { StoreConfig } from './store.config';
import { StoreService } from './store.service';
import { UserRole } from '../users/entities/user.entity';

describe('Admin integration configuration status', () => {
  const status = (values: Record<string, string>) =>
    new StoreService(
      new StoreConfig(new ConfigService(values)),
      {} as any,
      {} as any,
    ).status(UserRole.SUPER_ADMIN);
  it('exposes only safe feature flags and authentication modes without credentials', () => {
    const result = status({
      STORE_MANAGEMENT_ENABLED: 'true',
      STORE_GOOGLE_AUTH_MODE: 'aws_wif',
      STORE_GOOGLE_CLIENT_EMAIL: 'private-email',
      STORE_GOOGLE_WIF_AUDIENCE: 'private-audience',
      STORE_APPLE_PRIVATE_KEY: 'private-p8',
      STORE_APPLE_KEY_ID: 'private-key-id',
      MOBILE_OPERATIONS_ENABLED: 'true',
      MOBILE_CAMPAIGNS_ENABLED: 'true',
    });
    expect(result.features).toEqual({
      mobileOperations: true,
      mobileCampaigns: true,
      reviewReplies: false,
      googleTemporaryEdits: false,
    });
    expect(
      result.platforms.find((p) => p.platform === 'google')?.authMode,
    ).toBe('aws_wif');
    expect(result.platforms.find((p) => p.platform === 'apple')?.authMode).toBe(
      'apple_team_key',
    );
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('keeps dependent operations off while their module is disabled', () => {
    const result = status({
      MOBILE_CAMPAIGNS_ENABLED: 'true',
      STORE_REVIEW_REPLIES_ENABLED: 'true',
      STORE_GOOGLE_TEMPORARY_EDITS_ENABLED: 'true',
    });
    expect(Object.values(result.features).every((v) => v === false)).toBe(true);
  });
  it('never reflects unknown environment values to the browser', () => {
    expect(
      status({ STORE_GOOGLE_AUTH_MODE: 'secret-misconfigured-value' })
        .platforms[0].authMode,
    ).toBe('invalid');
  });
});
