import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { RedisService } from '../common/services/redis.service';
import { KeccelOtpService } from '../keccel-otp/keccel-otp.service';
import { MobishastraSmsService } from './mobishastra-sms.service';
import { MobishastraOtpService } from './mobishastra-otp.service';
import { OtpService } from './otp.service';
import { OtpModule } from './otp.module';
import { Test } from '@nestjs/testing';

describe('Locally generated phone OTP', () => {
  it('wires the Mobishastra providers into the existing Nest module without contacting Redis or SMS', async () => {
    const module = await Test.createTestingModule({ imports: [OtpModule] })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({}))
      .useMocker((token) => (token === RedisService ? {} : undefined))
      .compile();
    try {
      expect(module.get(OtpService)).toBeInstanceOf(OtpService);
      expect(module.get(MobishastraOtpService)).toBeInstanceOf(
        MobishastraOtpService,
      );
      expect(module.get(MobishastraSmsService)).toBeInstanceOf(
        MobishastraSmsService,
      );
    } finally {
      await module.close();
    }
  });
  const secret = 'test-only-secret-not-used-by-any-environment';
  const phone = '243900000000';
  function fixture() {
    const config = new ConfigService({
      OTP_PROVIDER: 'mobishastra',
      OTP_CODE_HMAC_SECRET: secret,
    });
    const client = {
      eval: jest.fn().mockResolvedValue(899000),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const redis = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      getClient: () => client,
      consumeIfValueMatches: jest.fn().mockResolvedValue(true),
    };
    const sms = { assertConfigured: jest.fn(), sendCode: jest.fn() };
    const local = new MobishastraOtpService(
      config,
      redis as unknown as RedisService,
      sms as unknown as MobishastraSmsService,
    );
    const keccel = {
      sendOtp: jest.fn().mockResolvedValue({ success: true }),
      verifyOtp: jest.fn(),
    };
    const otp = new OtpService(
      config,
      redis as unknown as RedisService,
      keccel as unknown as KeccelOtpService,
      local,
    );
    return { config, client, redis, sms, local, keccel, otp };
  }

  it('generates five unpredictable digits and stores only a purpose-bound HMAC for 900 seconds', async () => {
    const f = fixture();
    const result = await f.local.send(phone, 'challenge-key');
    const code = f.sms.sendCode.mock.calls[0][1] as string;
    expect(code).toMatch(/^[1-9]\d{4}$/);
    const stored = f.redis.set.mock.calls[0][1];
    expect(f.redis.set).toHaveBeenCalledWith(
      'challenge-key',
      expect.objectContaining({
        provider: 'mobishastra',
        state: 'pending',
        attemptsRemaining: 5,
      }),
      900,
    );
    expect(stored.codeHash).toBe(
      createHmac('sha256', secret)
        .update(
          JSON.stringify(['phone_verification', phone, stored.requestId, code]),
        )
        .digest('hex'),
    );
    expect(stored).not.toHaveProperty('code');
    expect(stored).not.toHaveProperty('phone');
    expect(result).toMatchObject({
      success: true,
      codeLength: 5,
      expiresInSeconds: 899,
    });
    expect(JSON.stringify(result)).not.toContain(code);
    expect(f.redis.set.mock.invocationCallOrder[0]).toBeLessThan(
      f.sms.sendCode.mock.invocationCallOrder[0],
    );
  });

  it('does not send if Redis cannot store the pending challenge', async () => {
    const f = fixture();
    f.redis.set.mockRejectedValue(new Error('storage down'));
    await expect(f.local.send(phone, 'key')).rejects.toMatchObject({
      status: 503,
    });
    expect(f.sms.sendCode).not.toHaveBeenCalled();
  });

  it('deletes only its own pending challenge on ambiguous SMS failure, without fallback', async () => {
    const f = fixture();
    f.sms.sendCode.mockRejectedValue(new Error('timeout'));
    await expect(f.local.send(phone, 'key')).rejects.toMatchObject({
      status: 503,
    });
    expect(f.redis.consumeIfValueMatches).toHaveBeenCalledWith(
      'key',
      f.redis.set.mock.calls[0][1],
    );
    expect(f.client.eval).not.toHaveBeenCalled();
    expect(f.keccel.sendOtp).not.toHaveBeenCalled();
  });

  it('refuses a missing/short dedicated hashing secret', () => {
    const f = fixture();
    f.config.set('OTP_CODE_HMAC_SECRET', 'short');
    expect(() => f.local.assertConfigured()).toThrow('Configuration OTP');
    expect(f.sms.assertConfigured).not.toHaveBeenCalled();
  });

  it('keeps Keccel PIN reset/admin unchanged and opts in only phone verification', async () => {
    const f = fixture();
    f.client.eval.mockResolvedValue(0); // send budget accepted
    const sending = jest
      .spyOn(f.local, 'send')
      .mockResolvedValue({ success: true, message: 'sent' });
    await f.otp.sendOtp(`+${phone}`);
    expect(sending).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('phone_verification'),
    );
    expect(f.keccel.sendOtp).not.toHaveBeenCalled();
    await f.otp.sendOtp(`+${phone}`, 'pin_reset');
    await f.otp.sendOtp(`+${phone}`, 'admin_bootstrap');
    expect(f.keccel.sendOtp.mock.calls.map((call) => call.slice(2))).toEqual([
      [6, 300],
      [6, 300],
    ]);
  });

  it('validates the stored provider even after switching back to Keccel', async () => {
    const f = fixture();
    f.config.set('OTP_PROVIDER', 'keccel');
    f.redis.get.mockResolvedValue({
      provider: 'mobishastra',
      requestId: 'id',
      state: 'sent',
      attemptsRemaining: 5,
    });
    expect(await f.otp.verifyOtp(`+${phone}`, '12345')).toMatchObject({
      valid: true,
      verificationToken: expect.any(String),
    });
    expect(f.keccel.verifyOtp).not.toHaveBeenCalled();
    expect(
      await f.otp.verifyOtp(`+${phone}`, '12345', 'pin_reset'),
    ).toMatchObject({ valid: false });
    expect(f.keccel.verifyOtp).not.toHaveBeenCalled();
  });

  it('returns invalid on failed verification and never returns a proof', async () => {
    const f = fixture();
    f.client.eval.mockResolvedValue(0);
    expect(
      await f.local.verify(phone, '12345', 'key', {
        provider: 'mobishastra',
        requestId: 'id',
        state: 'sent',
        attemptsRemaining: 5,
      }),
    ).toEqual({ valid: false, status: 'INVALID' });
  });
});
