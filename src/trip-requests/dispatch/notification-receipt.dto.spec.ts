import { validate } from 'class-validator';
import { NotificationReceiptDto } from './dispatch.dto';

describe('NotificationReceiptDto validation diagnostics', () => {
  const check = (values: Partial<NotificationReceiptDto>) => validate(
    Object.assign(new NotificationReceiptDto(), values),
    { whitelist: true, forbidNonWhitelisted: true },
  );

  it.each(['NATIVE_CARD_FAILED', 'NATIVE_CARD_PENDING', 'NATIVE_FALLBACK_FAILED',
    'REQUEST_CHECK_UNAVAILABLE', 'REQUEST_NO_LONGER_AVAILABLE'])(
    'accepts the bounded native reason %s', async failureCode => {
      expect(await check({ stage: 'received', source: 'native', failureCode })).toEqual([]);
    },
  );

  it('preserves legacy receipts and audio metadata', async () => {
    expect(await check({})).toEqual([]);
    expect(await check({ stage: 'displayed', audioStage: 'audio_started',
      audioReason: 'PLAYER_STARTED', audioObservedAt: '2026-11-08T10:00:00.000Z' })).toEqual([]);
  });

  it.each(['arbitrary-details', '', 'REQUEST_CHECK_UNAVAILABLE '.repeat(30)])(
    'rejects unrecognized failure codes: %s', async failureCode => {
      expect((await check({ failureCode })).map(error => error.property)).toContain('failureCode');
    },
  );
});
