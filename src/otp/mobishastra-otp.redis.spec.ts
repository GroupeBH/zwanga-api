import { createClient } from 'redis';
import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/services/redis.service';
import { KeccelOtpService } from '../keccel-otp/keccel-otp.service';
import { MobishastraSmsService } from './mobishastra-sms.service';
import { MobishastraOtpService } from './mobishastra-otp.service';
import { MobishastraChallenge } from './otp.types';
import { OtpService } from './otp.service';

const enabled = Boolean(
  process.env.OTP_TEST_REDIS_PORT && process.env.OTP_TEST_REDIS_PASSWORD,
);
// Run only via test/run-otp-redis.cjs, never the application's Redis.
(enabled ? describe : describe.skip)(
  'Mobishastra OTP on disposable Redis',
  () => {
    const phone = '243900000000';
    const key = `otp:challenge:v1:phone_verification:${createHash('sha256').update(phone).digest('hex')}`;
    const budgetKey = `otp:{send-budget}:cooldown:${createHash('sha256').update(phone).digest('hex')}`;
    const client = createClient({
      socket: {
        host: '127.0.0.1',
        port: Number(process.env.OTP_TEST_REDIS_PORT),
        reconnectStrategy: false,
      },
      password: process.env.OTP_TEST_REDIS_PASSWORD,
    });
    const redis = Object.create(RedisService.prototype) as RedisService;
    Object.assign(redis, { client });
    const config = new ConfigService({
      OTP_PROVIDER: 'mobishastra',
      OTP_CODE_HMAC_SECRET: 'test-only-hmac-secret-32-bytes-minimum',
      OTP_SEND_COOLDOWN_SECONDS: 1,
    });
    const sms = {
      assertConfigured: jest.fn(),
      sendCode: jest.fn().mockResolvedValue(undefined),
    };
    const local = new MobishastraOtpService(
      config,
      redis,
      sms as unknown as MobishastraSmsService,
    );
    const keccel = { sendOtp: jest.fn(), verifyOtp: jest.fn() };
    const otp = new OtpService(
      config,
      redis,
      keccel as unknown as KeccelOtpService,
      local,
    );
    const lastCode = () => sms.sendCode.mock.calls.at(-1)![1] as string;
    const snapshot = async () =>
      (await redis.get<MobishastraChallenge>(key)) as MobishastraChallenge;
    beforeAll(async () => {
      client.on('error', () => {});
      await client.connect();
    });
    beforeEach(async () => {
      // Only known test keys in a fresh disposable server; no broad FLUSHDB.
      for await (const batch of client.scanIterator({ MATCH: 'otp:*' }))
        await client.del(batch);
      jest.clearAllMocks();
      sms.sendCode.mockResolvedValue(undefined);
    });
    afterAll(async () => {
      if (client.isOpen) await client.quit();
    });

    it('round-trips five digits, retains the original 15-minute deadline and consumes the proof once', async () => {
      expect(await otp.sendOtp(`+${phone}`)).toMatchObject({
        success: true,
        codeLength: 5,
      });
      const initialTtl = await client.pTTL(key);
      expect(initialTtl).toBeGreaterThan(890000);
      expect(initialTtl).toBeLessThanOrEqual(900000);
      const result = await otp.verifyOtp(`+${phone}`, lastCode());
      expect(result.valid).toBe(true);
      expect(result.verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await client.pTTL(key)).toBeLessThanOrEqual(initialTtl);
      expect(await snapshot()).not.toHaveProperty('codeHash');
      expect(await otp.verifyOtp(`+${phone}`, lastCode())).toEqual({
        valid: false,
        status: 'INVALID',
      });
      expect(
        await otp.consumePhoneVerificationProof(
          '+243900000001',
          result.verificationToken!,
        ),
      ).toBe(false);
      expect(
        await otp.consumePhoneVerificationProof(`+${phone}`, 'x'.repeat(43)),
      ).toBe(false);
      expect(
        await otp.consumePhoneVerificationProof(
          '0900000000',
          result.verificationToken!,
        ),
      ).toBe(true);
      expect(
        await otp.consumePhoneVerificationProof(
          `+${phone}`,
          result.verificationToken!,
        ),
      ).toBe(false);
      expect(keccel.verifyOtp).not.toHaveBeenCalled();
    });

    it('deletes the challenge after exactly five wrong attempts without extending its TTL', async () => {
      await otp.sendOtp(`+${phone}`);
      await client.pExpire(key, 30000);
      for (let attempt = 1; attempt <= 5; attempt++) {
        expect(await otp.verifyOtp(`+${phone}`, '00000')).toMatchObject({
          valid: false,
        });
        if (attempt < 5) {
          expect((await snapshot()).attemptsRemaining).toBe(5 - attempt);
          expect(await client.pTTL(key)).toBeLessThanOrEqual(30000);
        }
      }
      expect(await client.exists(key)).toBe(0);
      expect(await otp.verifyOtp(`+${phone}`, lastCode())).toMatchObject({
        valid: false,
      });
    });

    it('rejects expired codes and expired verification proofs', async () => {
      await otp.sendOtp(`+${phone}`);
      await client.pExpire(key, 0);
      expect(await otp.verifyOtp(`+${phone}`, lastCode())).toMatchObject({
        valid: false,
      });
      await client.del(budgetKey);
      await otp.sendOtp(`+${phone}`);
      const result = await otp.verifyOtp(`+${phone}`, lastCode());
      await client.pExpire(key, 0);
      expect(
        await otp.consumePhoneVerificationProof(
          `+${phone}`,
          result.verificationToken!,
        ),
      ).toBe(false);
    });

    it('denies an immediate resend without destroying the first usable code', async () => {
      await otp.sendOtp(`+${phone}`);
      const stored = await client.get(key);
      await expect(otp.sendOtp(`+${phone}`)).rejects.toMatchObject({
        status: 429,
      });
      expect(await client.get(key)).toBe(stored);
      expect(sms.sendCode).toHaveBeenCalledTimes(1);
      expect(await otp.verifyOtp(`+${phone}`, lastCode())).toMatchObject({
        valid: true,
      });
    });

    it('invalidates the old proof on resend and ignores stale verifier snapshots', async () => {
      await otp.sendOtp(`+${phone}`);
      const old = await snapshot();
      const code = lastCode();
      const proof = await otp.verifyOtp(`+${phone}`, code);
      await client.del(budgetKey);
      await otp.sendOtp(`+${phone}`);
      expect(await local.verify(phone, code, key, old)).toMatchObject({
        valid: false,
      });
      expect(
        await otp.consumePhoneVerificationProof(
          `+${phone}`,
          proof.verificationToken!,
        ),
      ).toBe(false);
      expect(await otp.verifyOtp(`+${phone}`, lastCode())).toMatchObject({
        valid: true,
      });
    });

    it('validates a challenge only once even when Lua is called concurrently by replicas', async () => {
      await otp.sendOtp(`+${phone}`);
      const stored = await snapshot();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          local.verify(phone, lastCode(), key, stored),
        ),
      );
      expect(results.filter((result) => result.valid)).toHaveLength(1);
      const proof = results.find((result) => result.valid)!.verificationToken!;
      const consumed = await Promise.all(
        Array.from({ length: 20 }, () => local.consumeProof(phone, proof, key)),
      );
      expect(consumed.filter(Boolean)).toHaveLength(1);
    });

    it('honors the five-attempt budget during concurrent brute force', async () => {
      await otp.sendOtp(`+${phone}`);
      const stored = await snapshot();
      await Promise.all(
        Array.from({ length: 20 }, () =>
          local.verify(phone, '00000', key, stored),
        ),
      );
      expect(await client.exists(key)).toBe(0);
      expect(await local.verify(phone, lastCode(), key, stored)).toMatchObject({
        valid: false,
      });
    });

    it('does not activate a pending challenge before the provider confirms the send', async () => {
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      sms.sendCode.mockImplementationOnce(async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const sending = otp.sendOtp(`+${phone}`);
      await entered;
      try {
        const pending = await snapshot();
        expect(pending.state).toBe('pending');
        expect(
          await local.verify(phone, lastCode(), key, pending),
        ).toMatchObject({ valid: false });
        await expect(
          otp.verifyOtp(`+${phone}`, lastCode()),
        ).rejects.toMatchObject({ status: 409 });
        await expect(otp.sendOtp(`+${phone}`)).rejects.toMatchObject({
          status: 409,
        });
      } finally {
        release();
        await sending;
      }
      expect(await otp.verifyOtp(`+${phone}`, lastCode())).toMatchObject({
        valid: true,
      });
    });

    it('cleans up a rejected SMS and makes no fallback call', async () => {
      sms.sendCode.mockRejectedValueOnce(new Error('no credits'));
      await expect(otp.sendOtp(`+${phone}`)).rejects.toMatchObject({
        status: 503,
      });
      expect(await client.exists(key)).toBe(0);
      expect(await otp.verifyOtp(`+${phone}`, lastCode())).toMatchObject({
        valid: false,
      });
      expect(keccel.sendOtp).not.toHaveBeenCalled();
    });
  },
);
