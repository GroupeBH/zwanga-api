import { ConfigService } from '@nestjs/config';
import { reserveOtpSend, OTP_SEND_BUDGET_SCRIPT } from './otp-send-budget';
import { OtpService } from './otp.service';

describe('OTP send budgets', () => {
  it('reserves phone and global budgets in one atomic call without exposing the phone', async () => {
    const evaluate = jest.fn().mockResolvedValue(0);
    await reserveOtpSend({ getClient: () => ({ eval: evaluate }) } as never, new ConfigService(), '243000000000');
    expect(evaluate).toHaveBeenCalledWith(OTP_SEND_BUDGET_SCRIPT, {
      keys: expect.arrayContaining([expect.stringContaining('otp:{send-budget}:cooldown:'), 'otp:{send-budget}:global-day']),
      arguments: ['30000', '5', '10', '10000'],
    });
    expect(JSON.stringify(evaluate.mock.calls)).not.toContain('243000000000');
  });
  it('returns 429 and keeps the previous code when a resend is denied', async () => {
    const redis = { getClient: () => ({ set: async () => 'OK', eval: async () => 29999 }),
      consumeIfValueMatches: jest.fn(), del: jest.fn() };
    const provider = { sendOtp: jest.fn() };
    const service = new OtpService(new ConfigService(), redis as never, provider as never);
    await expect(service.sendOtp('+243891234567')).rejects.toMatchObject({ status: 429 });
    expect(redis.del).not.toHaveBeenCalled();
    expect(provider.sendOtp).not.toHaveBeenCalled();
    expect(redis.consumeIfValueMatches).toHaveBeenCalledTimes(1);
  });
  it('fails closed on Redis errors and invalid configuration', async () => {
    const redis = { getClient: () => ({ eval: async () => { throw new Error('offline'); } }) };
    await expect(reserveOtpSend(redis as never, new ConfigService(), 'synthetic')).rejects.toMatchObject({ status: 503 });
    await expect(reserveOtpSend(redis as never, new ConfigService({ OTP_SEND_COOLDOWN_SECONDS: 0 }), 'synthetic'))
      .rejects.toMatchObject({ status: 503 });
  });
});
