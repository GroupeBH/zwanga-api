import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { RedisService } from '../common/services/redis.service';
import { KeccelOtpService } from '../keccel-otp/keccel-otp.service';
import { OTP_SMS_MESSAGES } from '../keccel-otp/otp-messages';
import { OtpService } from './otp.service';
import { OtpPurpose } from './otp.types';

describe('OtpService Keccel-only compatibility routing', () => {
  const phone = '+243891234567';
  const purposes: OtpPurpose[] = [
    'phone_verification',
    'pin_reset',
    'admin_bootstrap',
  ];
  let values: Map<string, string>;
  let redis: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    getClient: jest.Mock;
    consumeIfValueMatches: jest.Mock;
  };
  let keccel: { sendOtp: jest.Mock; verifyOtp: jest.Mock };
  const keyFor = (purpose: OtpPurpose) =>
    `otp:challenge:v1:${purpose}:${createHash('sha256').update(phone.slice(1)).digest('hex')}`;

  const serviceFor = (provider?: string, pinResetProvider?: string) =>
    new OtpService(
      new ConfigService({
        OTP_PROVIDER: provider,
        OTP_PIN_RESET_PROVIDER: pinResetProvider,
      }),
      redis as unknown as RedisService,
      keccel as unknown as KeccelOtpService,
    );

  beforeEach(() => {
    values = new Map();
    redis = {
      get: jest.fn(async (key: string) =>
        JSON.parse(values.get(key) ?? 'null'),
      ),
      set: jest.fn(async (key: string, value: unknown) => {
        values.set(key, JSON.stringify(value));
      }),
      del: jest.fn(async (key: string) => {
        values.delete(key);
      }),
      getClient: jest.fn(() => ({
        eval: jest.fn().mockResolvedValue(0),
        set: jest.fn(async (key: string, value: string) => {
          if (values.has(key)) return null;
          values.set(key, value);
          return 'OK';
        }),
      })),
      consumeIfValueMatches: jest.fn(async (key: string, value: unknown) => {
        if (values.get(key) !== JSON.stringify(value)) return false;
        values.delete(key);
        return true;
      }),
    };
    keccel = {
      sendOtp: jest.fn().mockResolvedValue({ success: true, status: 'SENT' }),
      verifyOtp: jest.fn().mockResolvedValue({ valid: true, status: 'VALID' }),
    };
  });

  it.each([undefined, '', 'keccel', 'didit', ' DIDIT ', 'unknown'])(
    'uses Keccel for every purpose despite legacy provider configuration %s',
    async (provider) => {
      for (const purpose of purposes) {
        const service = serviceFor(provider, 'didit');
        await service.sendOtp(phone, purpose);
        expect(redis.set).toHaveBeenLastCalledWith(
          keyFor(purpose),
          { provider: 'keccel', requestId: expect.any(String) },
          300,
        );
        expect(
          await service.verifyOtp(
            phone,
            purpose === 'phone_verification' ? '12345' : '123456',
            purpose,
          ),
        ).toEqual({ valid: true, status: 'VALID' });
      }
      expect(keccel.sendOtp.mock.calls).toEqual([
        [phone, OTP_SMS_MESSAGES.verification, 5, 300],
        [phone, OTP_SMS_MESSAGES.pinReset, 6, 300],
        [phone, OTP_SMS_MESSAGES.adminBootstrap, 6, 300],
      ]);
    },
  );

  it.each([
    ['+352 26 00 00', '00352260000'],
    ['0032 2 000 00 00', '+3220000000'],
    ['+683 4000', '006834000'],
    ['0900000000', '+243900000000'],
  ])(
    'finds the same challenge for international/local formats %s',
    async (input, verificationPhone) => {
      const service = serviceFor('didit');
      await service.sendOtp(input);
      expect(await service.verifyOtp(verificationPhone, '12345')).toMatchObject(
        { valid: true },
      );
      expect(await service.verifyOtp(verificationPhone, '12345')).toMatchObject(
        { valid: false },
      );
      expect(keccel.verifyOtp).toHaveBeenCalledTimes(1);
    },
  );

  it('does not verify a foreign challenge against another inferred country or purpose', async () => {
    const service = serviceFor('didit');
    await service.sendOtp('+352260000');
    expect(await service.verifyOtp('352260000', '12345')).toMatchObject({
      valid: false,
    });
    expect(
      await service.verifyOtp('+352260000', '12345', 'pin_reset'),
    ).toMatchObject({ valid: false });
    expect(keccel.verifyOtp).not.toHaveBeenCalled();
    expect(await service.verifyOtp('00352260000', '12345')).toMatchObject({
      valid: true,
    });
  });

  it('retains invalid challenges and rejects missing, expired, malformed and replayed codes', async () => {
    const service = serviceFor('didit');
    expect(await service.verifyOtp(phone, '12345')).toMatchObject({
      valid: false,
    });
    await service.sendOtp(phone);
    keccel.verifyOtp.mockResolvedValueOnce({ valid: false });
    expect(await service.verifyOtp(phone, '00000')).toMatchObject({
      valid: false,
    });
    expect(values.has(keyFor('phone_verification'))).toBe(true);
    expect(await service.verifyOtp(phone, ' 12345 ')).toMatchObject({
      valid: true,
    });
    expect(keccel.verifyOtp).toHaveBeenLastCalledWith(phone, '12345');
    expect(await service.verifyOtp(phone, '12345')).toMatchObject({
      valid: false,
    });
    await expect(service.verifyOtp(phone, 'nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await service.sendOtp(phone);
    values.clear(); // Redis TTL expiration.
    expect(await service.verifyOtp(phone, '12345')).toMatchObject({
      valid: false,
    });
    expect(keccel.verifyOtp).toHaveBeenCalledTimes(2);
  });

  it.each(purposes)(
    'rejects a historical Didit %s code without invoking any provider; resend restores service',
    async (purpose) => {
      values.set(
        keyFor(purpose),
        JSON.stringify({
          provider: 'didit',
          requestId: 'old',
          vendorData: 'old',
        }),
      );
      const service = serviceFor('didit');
      expect(await service.verifyOtp(phone, '123456', purpose)).toMatchObject({
        valid: false,
      });
      expect(keccel.verifyOtp).not.toHaveBeenCalled();
      await service.sendOtp(phone, purpose);
      expect(await service.verifyOtp(phone, '123456', purpose)).toMatchObject({
        valid: true,
      });
    },
  );

  it('accepts an unambiguous Keccel challenge issued by the previous backend', async () => {
    values.set(keyFor('pin_reset'), JSON.stringify({ provider: 'keccel' }));
    expect(
      await serviceFor('didit').verifyOtp(phone, '123456', 'pin_reset'),
    ).toMatchObject({ valid: true });
  });

  it('requires a resend if old replicas issued ambiguous Keccel purposes', async () => {
    values.set(keyFor('pin_reset'), JSON.stringify({ provider: 'keccel' }));
    values.set(
      keyFor('phone_verification'),
      JSON.stringify({ provider: 'keccel' }),
    );
    const service = serviceFor();
    expect(await service.verifyOtp(phone, '123456', 'pin_reset')).toMatchObject(
      { valid: false },
    );
    expect(keccel.verifyOtp).not.toHaveBeenCalled();
    await service.sendOtp(phone, 'pin_reset');
    expect(await service.verifyOtp(phone, '123456', 'pin_reset')).toMatchObject(
      { valid: true },
    );
  });

  it('allows only the latest successful purpose, so a phone code never proves PIN recovery', async () => {
    const service = serviceFor('didit');
    await service.sendOtp(phone, 'pin_reset');
    await service.sendOtp(phone, 'phone_verification');
    expect(await service.verifyOtp(phone, '12345', 'pin_reset')).toMatchObject({
      valid: false,
    });
    expect(keccel.verifyOtp).not.toHaveBeenCalled();
    expect(await service.verifyOtp(phone, '12345')).toMatchObject({
      valid: true,
    });
  });

  it('does not consume a replacement challenge after an old verification completes', async () => {
    const service = serviceFor();
    await service.sendOtp(phone, 'pin_reset');
    keccel.verifyOtp.mockImplementationOnce(async () => {
      values.set(
        keyFor('pin_reset'),
        JSON.stringify({ provider: 'keccel', requestId: 'new-request' }),
      );
      return { valid: true };
    });
    expect(await service.verifyOtp(phone, '123456', 'pin_reset')).toMatchObject(
      { valid: false },
    );
    expect(JSON.parse(values.get(keyFor('pin_reset'))!).requestId).toBe(
      'new-request',
    );
  });

  it('serializes requests for the same phone across replicas, but not different phones', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    keccel.sendOtp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ success: true });
          entered();
        }),
    );
    const service = serviceFor();
    const sending = service.sendOtp(phone, 'pin_reset');
    await started;
    await expect(serviceFor().sendOtp('00243891234567')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      serviceFor().verifyOtp(phone, '123456', 'pin_reset'),
    ).rejects.toBeInstanceOf(ConflictException);
    await service.sendOtp('+243899999999');
    finish();
    await sending;
    expect(
      await serviceFor().verifyOtp(phone, '123456', 'pin_reset'),
    ).toMatchObject({ valid: true });
  });

  it.each(['rejected', 'unsuccessful'])(
    'stores no challenge after a %s send and releases the lock for retry',
    async (failure) => {
      if (failure === 'rejected')
        keccel.sendOtp.mockRejectedValueOnce(new ServiceUnavailableException());
      else keccel.sendOtp.mockResolvedValueOnce({ success: false });
      const service = serviceFor('didit');
      await expect(service.sendOtp(phone)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(redis.set).not.toHaveBeenCalled();
      expect(values.size).toBe(0);
      await service.sendOtp(phone);
      expect(keccel.sendOtp).toHaveBeenCalledTimes(2);
    },
  );

  it('invalidates old purposes on failed send because a timeout may occur after Keccel generated a code', async () => {
    const service = serviceFor();
    await service.sendOtp(phone, 'pin_reset');
    keccel.sendOtp.mockRejectedValueOnce(new ServiceUnavailableException());
    await expect(service.sendOtp(phone)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(values.has(keyFor('pin_reset'))).toBe(false);
    expect(await service.verifyOtp(phone, '123456', 'pin_reset')).toMatchObject(
      { valid: false },
    );
    expect(keccel.verifyOtp).not.toHaveBeenCalled();
  });

  it('makes no provider call if Redis cannot protect the challenge', async () => {
    redis.getClient.mockImplementation(() => {
      throw new Error('Redis unavailable');
    });
    await expect(serviceFor().sendOtp(phone)).rejects.toThrow(
      'Redis unavailable',
    );
    expect(keccel.sendOtp).not.toHaveBeenCalled();
  });

  it.each(purposes)(
    'fails %s closed with 503 when Keccel is unconfigured',
    async (purpose) => {
      const config = new ConfigService({
        OTP_PROVIDER: 'didit',
        KECCEL_TOKEN: '',
        KECCEL_FROM: '',
      });
      const http = { post: jest.fn(), request: jest.fn() };
      const service = new OtpService(
        config,
        redis as unknown as RedisService,
        new KeccelOtpService(http as unknown as HttpService, config),
      );
      await expect(service.sendOtp(phone, purpose)).rejects.toMatchObject({
        status: 503,
      });
      expect(http.post).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(values.size).toBe(0);
    },
  );
});
