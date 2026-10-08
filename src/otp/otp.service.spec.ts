import {
  BadRequestException,
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/services/redis.service';
import { KeccelOtpService } from '../keccel-otp/keccel-otp.service';
import { OTP_SMS_MESSAGES } from '../keccel-otp/otp-messages';
import { DiditOtpService, DiditSendCodeResult } from './didit-otp.service';
import { OtpService } from './otp.service';

describe('OtpService provider routing', () => {
  const phone = '+243891234567';
  let values: Map<string, string>;
  let redis: {
    get: jest.Mock;
    set: jest.Mock;
    consumeIfValueMatches: jest.Mock;
  };
  let keccel: { sendOtp: jest.Mock; verifyOtp: jest.Mock };
  let didit: {
    sendCode: jest.Mock<Promise<DiditSendCodeResult>, [string, string, string]>;
    verifyCode: jest.Mock<Promise<boolean>, [string, string, string, string]>;
  };

  const serviceFor = (provider?: string) =>
    new OtpService(
      {
        get: jest.fn((key: string) =>
          key === 'OTP_PROVIDER' ? provider : undefined,
        ),
      } as unknown as ConfigService,
      redis as unknown as RedisService,
      keccel as unknown as KeccelOtpService,
      didit as unknown as DiditOtpService,
    );

  afterEach(() => jest.useRealTimers());

  beforeEach(() => {
    values = new Map();
    redis = {
      get: jest.fn((key: string) => {
        const value = values.get(key);
        return Promise.resolve(value ? (JSON.parse(value) as unknown) : null);
      }),
      set: jest.fn((key: string, value: unknown) => {
        values.set(key, JSON.stringify(value));
        return Promise.resolve();
      }),
      consumeIfValueMatches: jest.fn((key: string, value: unknown) => {
        if (values.get(key) !== JSON.stringify(value))
          return Promise.resolve(false);
        values.delete(key);
        return Promise.resolve(true);
      }),
    };
    keccel = {
      sendOtp: jest.fn().mockResolvedValue({ success: true, status: 'SENT' }),
      verifyOtp: jest.fn().mockResolvedValue({ valid: true, status: 'VALID' }),
    };
    didit = {
      sendCode: jest
        .fn<Promise<DiditSendCodeResult>, [string, string, string]>()
        .mockResolvedValue({
          requestId: 'e39cb057-92fc-4b59-b84e-02fec29a0f24',
          status: 'Success',
        }),
      verifyCode: jest
        .fn<Promise<boolean>, [string, string, string, string]>()
        .mockResolvedValue(true),
    };
  });

  it('keeps Keccel as the safe fallback for existing five- and six-digit flows', async () => {
    const service = serviceFor();
    await service.sendOtp(phone);
    await service.sendOtp(phone, 'pin_reset');
    await service.sendOtp(phone, 'admin_bootstrap');

    expect(keccel.sendOtp).toHaveBeenNthCalledWith(
      1,
      phone,
      OTP_SMS_MESSAGES.verification,
      5,
      300,
    );
    expect(keccel.sendOtp).toHaveBeenNthCalledWith(
      2,
      phone,
      OTP_SMS_MESSAGES.pinReset,
      6,
      300,
    );
    expect(keccel.sendOtp).toHaveBeenNthCalledWith(
      3,
      phone,
      OTP_SMS_MESSAGES.adminBootstrap,
      6,
      300,
    );
    expect(didit.sendCode).not.toHaveBeenCalled();
    expect(await serviceFor('didit').verifyOtp(phone, '12345')).toEqual({
      valid: true,
      status: 'VALID',
    });
    expect(keccel.verifyOtp).toHaveBeenCalledWith(phone, '12345');
  });

  it.each([
    ['+352 26 00 00', '00352260000', '+352260000'],
    ['0032 2 000 00 00', '+3220000000', '+3220000000'],
    ['+683 4000', '006834000', '+6834000'],
    ['0900000000', '+243900000000', '+243900000000'],
  ])(
    'sends and consumes the same foreign/local Didit challenge for %s',
    async (input, verifyPhone, canonical) => {
      const service = serviceFor('didit');
      await service.sendOtp(input);
      expect(didit.sendCode).toHaveBeenCalledWith(
        canonical,
        'phone_verification',
        expect.any(String),
      );
      expect(await service.verifyOtp(verifyPhone, '12345')).toEqual({
        valid: true,
        status: 'VALID',
      });
      expect(didit.verifyCode).toHaveBeenCalledWith(
        canonical,
        '12345',
        expect.any(String),
        expect.any(String),
      );
      expect(await service.verifyOtp(verifyPhone, '12345')).toEqual({
        valid: false,
        status: 'INVALID',
      });
    },
  );

  it('does not verify a foreign challenge against a different inferred country', async () => {
    const service = serviceFor('didit');
    await service.sendOtp('+352260000');
    expect(await service.verifyOtp('352260000', '12345')).toEqual({
      valid: false,
      status: 'INVALID',
    });
    expect(didit.verifyCode).not.toHaveBeenCalled();
    expect(
      await service.verifyOtp('+352260000', '12345', 'pin_reset'),
    ).toMatchObject({ valid: false });
    expect(didit.verifyCode).not.toHaveBeenCalled();
    expect(await service.verifyOtp('00352260000', '12345')).toMatchObject({
      valid: true,
    });
  });

  it('retains invalid challenges, rejects missing challenges and rejects malformed codes', async () => {
    const service = serviceFor('didit');
    expect(await service.verifyOtp(phone, '12345')).toMatchObject({
      valid: false,
    });
    await service.sendOtp(phone);
    didit.verifyCode.mockResolvedValueOnce(false);
    expect(await service.verifyOtp(phone, '11111')).toMatchObject({
      valid: false,
    });
    expect(await service.verifyOtp(phone, '12345')).toMatchObject({
      valid: true,
    });
    await expect(service.verifyOtp(phone, 'nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('routes Didit by configuration and verifies with the stored provider after switching', async () => {
    const diditService = serviceFor('didit');
    await diditService.sendOtp(phone);
    expect(didit.sendCode).toHaveBeenCalledWith(
      phone,
      'phone_verification',
      expect.any(String),
    );
    expect(await serviceFor('keccel').verifyOtp(phone, '12345')).toEqual({
      valid: true,
      status: 'VALID',
    });
    expect(didit.verifyCode).toHaveBeenCalledWith(
      phone,
      '12345',
      'e39cb057-92fc-4b59-b84e-02fec29a0f24',
      expect.any(String),
    );
    expect(await diditService.verifyOtp(phone, '12345')).toEqual({
      valid: false,
      status: 'INVALID',
    });
  });

  it('keeps Didit purposes separate and reuses vendor data only for same-purpose retries', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-29T12:00:00Z'));
    const service = serviceFor('didit');
    await service.sendOtp(phone, 'pin_reset');
    const firstVendorData = didit.sendCode.mock.calls[0][2];
    jest.advanceTimersByTime(120_000);
    didit.sendCode.mockResolvedValueOnce({
      requestId: 'e39cb057-92fc-4b59-b84e-02fec29a0f24',
      status: 'Retry',
    });
    await service.sendOtp(phone, 'pin_reset');
    expect(didit.sendCode.mock.calls[1][2]).toBe(firstVendorData);
    expect(redis.set).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('otp:didit:active:'),
      expect.objectContaining({ expiresAt: Date.now() + 180_000 }),
      180,
    );
    expect(redis.set).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('otp:challenge:'),
      expect.any(Object),
      180,
    );
    await expect(
      service.sendOtp(phone, 'admin_bootstrap'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(didit.sendCode).toHaveBeenCalledTimes(2);
  });

  it('does not accept a Didit OTP if its active challenge changed', async () => {
    const service = serviceFor('didit');
    await service.sendOtp(phone);
    for (const key of values.keys()) {
      if (key.startsWith('otp:didit:active:')) values.delete(key);
    }
    expect(await service.verifyOtp(phone, '12345')).toEqual({
      valid: false,
      status: 'INVALID',
    });
    expect(didit.verifyCode).not.toHaveBeenCalled();
  });

  it('rejects a Didit retry tied to a different session', async () => {
    const service = serviceFor('didit');
    await service.sendOtp(phone);
    redis.set.mockClear();
    didit.sendCode.mockResolvedValueOnce({
      requestId: '1f1de977-6e2e-4e89-9980-33b4e2a335d2',
      status: 'Retry',
    });

    await expect(service.sendOtp(phone)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider and never stores a challenge when sending fails', async () => {
    expect(() => serviceFor('unknown')).toThrow(
      'OTP_PROVIDER must be keccel or didit',
    );
    didit.sendCode.mockRejectedValueOnce(new ServiceUnavailableException());
    await expect(serviceFor('didit').sendOtp(phone)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(redis.set).not.toHaveBeenCalled();
  });
});
