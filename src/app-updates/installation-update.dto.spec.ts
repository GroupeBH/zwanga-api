import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  InstallationUpdateDto,
  UpdateCampaignDto,
} from './installation-update.dto';

describe('public installation and admin campaign input', () => {
  const input = {
    platform: 'ios',
    version: '1.0',
    build: '10',
    sequence: 1,
    enabled: false,
  };
  it.each(['true', 'false', 0, 1, null, undefined])(
    'does not turn an ambiguous consent into a grant: %p',
    async (enabled) => {
      const dto = plainToInstance(
        InstallationUpdateDto,
        { ...input, enabled },
        { enableImplicitConversion: true },
      );
      expect(
        (await validate(dto)).some((error) => error.property === 'enabled'),
      ).toBe(true);
    },
  );
  it.each([true, false])(
    'allows an explicit boolean choice: %p',
    async (enabled) => {
      const dto = plainToInstance(
        InstallationUpdateDto,
        { ...input, enabled },
        { enableImplicitConversion: true },
      );
      expect(await validate(dto)).toEqual([]);
      expect(dto.enabled).toBe(enabled);
    },
  );
  it('rejects an arbitrary external URL in an update campaign', async () => {
    const dto = plainToInstance(UpdateCampaignDto, {
      id: '00000000-0000-4000-8000-000000000001',
      releaseId: '1',
      title: 'Mise à jour',
      body: 'Voici les améliorations',
      url: 'https://invalid.example',
    });
    expect(
      (
        await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
      ).some((error) => error.property === 'url'),
    ).toBe(true);
  });
});
