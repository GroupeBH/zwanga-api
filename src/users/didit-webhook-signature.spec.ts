import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { DiditKycService } from './didit-kyc.service';

// Synthetic keys and payloads only; never loads .env, a database or a provider.
describe('Didit signed timestamp boundary', () => {
  const secret = 'synthetic-webhook-test-key';
  const now = 1_792_848_000;
  const body = {
    session_id: 'session-1',
    status: 'Approved',
    webhook_type: 'status.updated',
  };
  let service: DiditKycService;
  const sign = (value: string, encoding: 'hex' | 'base64' = 'hex') =>
    createHmac('sha256', secret).update(value).digest(encoding);
  const canonical = (value: unknown): string => {
    const sort = (input: any): any =>
      Array.isArray(input)
        ? input.map(sort)
        : input && typeof input === 'object'
          ? Object.fromEntries(
              Object.keys(input)
                .sort()
                .filter((key) => input[key] !== undefined)
                .map((key) => [key, sort(input[key])]),
            )
          : input;
    return JSON.stringify(sort(value));
  };
  const headers = (
    method: 'v2' | 'simple',
    payload: any,
    timestamp = String(now),
  ) => {
    const event = payload.data ?? payload;
    return {
      'x-timestamp': timestamp,
      [`x-signature-${method}`]: sign(
        method === 'v2'
          ? canonical(payload)
          : `${event.timestamp ?? payload.timestamp}:${event.session_id}:${event.status}:${event.webhook_type}`,
      ),
    };
  };
  const verify = (input: Record<string, string>, payload: any) =>
    (service as any).verifyWebhookSignature(input, payload);

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now * 1000);
    service = new DiditKycService(
      null as any,
      null as any,
      {
        get: (key: string) =>
          key === 'DIDIT_WEBHOOK_SECRET' ? secret : undefined,
      } as any,
      null as any,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  describe.each(['v2', 'simple'] as const)('%s', (method) => {
    it.each([now, String(now), now * 1000, new Date(now * 1000).toISOString()])(
      'accepts a fresh authenticated timestamp %j',
      (timestamp) => {
        const payload = { ...body, timestamp };
        expect(verify(headers(method, payload), payload)).toEqual({ method });
      },
    );
    it.each([-86400, 86400])(
      'rejects a signed body offset by %s seconds with a refreshed header',
      (offset) => {
        const payload = { ...body, timestamp: now + offset };
        expect(() => verify(headers(method, payload), payload)).toThrow(
          UnauthorizedException,
        );
        expect(() =>
          verify(headers(method, payload, String(now + offset)), payload),
        ).toThrow(UnauthorizedException);
      },
    );
    it('rejects different timestamps even when both are inside the tolerance', () => {
      const payload = { ...body, timestamp: now - 10 };
      expect(() => verify(headers(method, payload), payload)).toThrow(
        UnauthorizedException,
      );
    });
    it.each([
      undefined,
      null,
      '',
      ' ',
      false,
      [],
      {},
      'invalid',
      Infinity,
      -1,
      1.5,
    ])('rejects a missing or malformed signed timestamp %j', (timestamp) => {
      const payload = { ...body, timestamp };
      expect(() => verify(headers(method, payload), payload)).toThrow(
        UnauthorizedException,
      );
    });
    it('accepts a freshly re-signed legitimate retry', () => {
      const payload = {
        ...body,
        event_id: 'unchanged-event',
        created_at: now - 86400,
        timestamp: now,
      };
      expect(verify(headers(method, payload), payload)).toEqual({ method });
    });
    it('accepts wrapped bodies without trusting an unsigned timestamp header', () => {
      const payload = { data: { ...body, timestamp: now } };
      expect(verify(headers(method, payload), payload)).toEqual({ method });
    });
    it('accepts the signed envelope timestamp for a wrapped legacy body', () => {
      const payload = { timestamp: now, data: body };
      expect(verify(headers(method, payload), payload)).toEqual({ method });
    });
    it('rejects conflicting envelope and nested timestamps', () => {
      const payload = {
        timestamp: now - 86400,
        data: { ...body, timestamp: now },
      };
      expect(() => verify(headers(method, payload), payload)).toThrow(
        UnauthorizedException,
      );
    });
    it('rejects a tampered status even with a fresh timestamp', () => {
      const payload = { ...body, timestamp: now };
      expect(() =>
        verify(headers(method, payload), { ...payload, status: 'Declined' }),
      ).toThrow(UnauthorizedException);
    });
  });

  it('still accepts the existing V2 base64 signature format', () => {
    const payload = { ...body, timestamp: now };
    expect(
      verify(
        {
          'x-timestamp': String(now),
          'x-signature-v2': sign(canonical(payload), 'base64'),
        },
        payload,
      ),
    ).toEqual({ method: 'v2' });
  });
  it('does not downgrade an invalid V2 signature to a valid Simple signature', () => {
    const payload = { ...body, timestamp: now };
    expect(() =>
      verify(
        { ...headers('simple', payload), 'x-signature-v2': 'invalid' },
        payload,
      ),
    ).toThrow(UnauthorizedException);
  });
});
