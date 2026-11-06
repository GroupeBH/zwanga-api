import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorePlatform } from './store.types';
import { storeAwsWifSettings } from './store-aws-wif';

@Injectable()
export class StoreConfig {
  constructor(private readonly config: ConfigService) {}
  get enabled() {
    return this.config.get<string>('STORE_MANAGEMENT_ENABLED') === 'true';
  }
  get scheduled() {
    return (
      this.enabled && this.config.get<string>('STORE_SYNC_ENABLED') === 'true'
    );
  }
  value(key: string) {
    return this.config.get<string>(key)?.trim() || '';
  }
  appId(platform: StorePlatform) {
    return this.value(
      platform === 'google'
        ? 'STORE_GOOGLE_PACKAGE_NAME'
        : 'STORE_APPLE_APP_ID',
    );
  }
  missing(platform: StorePlatform) {
    if (
      platform === 'google' &&
      this.value('STORE_GOOGLE_AUTH_MODE') === 'aws_wif'
    ) {
      const missing = [
        'STORE_GOOGLE_PACKAGE_NAME',
        'STORE_GOOGLE_CLIENT_EMAIL',
        'STORE_GOOGLE_WIF_AUDIENCE',
      ].filter((key) => !this.value(key));
      if (!this.value('AWS_REGION') && !this.value('AWS_DEFAULT_REGION'))
        missing.push('AWS_REGION');
      return missing;
    }
    if (platform === 'google' && this.value('STORE_GOOGLE_AUTH_MODE') === 'adc')
      return [
        'STORE_GOOGLE_PACKAGE_NAME',
        'GOOGLE_APPLICATION_CREDENTIALS',
      ].filter((key) => !this.value(key));
    const keys =
      platform === 'google'
        ? [
            'STORE_GOOGLE_PACKAGE_NAME',
            'STORE_GOOGLE_CLIENT_EMAIL',
            'STORE_GOOGLE_PRIVATE_KEY',
          ]
        : [
            'STORE_APPLE_APP_ID',
            'STORE_APPLE_ISSUER_ID',
            'STORE_APPLE_KEY_ID',
            'STORE_APPLE_PRIVATE_KEY',
          ];
    return keys.filter((key) => !this.value(key));
  }
  assertEnabled() {
    if (!this.enabled)
      throw new ServiceUnavailableException({
        code: 'STORE_DISABLED',
        message: 'Store Management est désactivé.',
      });
  }
  assertReady(platform: StorePlatform) {
    this.assertEnabled();
    if (this.missing(platform).length)
      throw new ServiceUnavailableException({
        code: 'STORE_NOT_CONFIGURED',
        message:
          'Configurer les accès de cette plateforme avant la synchronisation.',
      });
    if (platform === 'google') {
      const mode = this.value('STORE_GOOGLE_AUTH_MODE') || 'service_account';
      if (!['service_account', 'adc', 'aws_wif'].includes(mode)) {
        throw new ServiceUnavailableException({
          code: 'STORE_INVALID_AUTH_MODE',
          message: 'Mode d’authentification Google invalide.',
        });
      }
      if (mode === 'aws_wif') storeAwsWifSettings((key) => this.value(key));
    }
    const id = this.appId(platform);
    if (
      !(platform === 'google' ? /^[a-zA-Z][\w]*(?:\.[\w]+)+$/ : /^\d+$/).test(
        id,
      )
    )
      throw new ServiceUnavailableException({
        code: 'STORE_INVALID_APP_ID',
        message: 'Identifiant de l’application invalide.',
      });
    return id;
  }
}
