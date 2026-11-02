import { formatPaymentLogPayload } from './payment-log.util';

describe('payment log allowlist', () => {
  it('keeps reconciliation fields without payer identities, URLs, credentials or free text', () => {
    const output = formatPaymentLogPayload({
      status: 'COMPLETED',
      amount: 500,
      currency: 'CDF',
      reference: 'synthetic-payment',
      data: {
        transaction: {
          code: '0',
          msisdn: '000000000000',
          email: 'synthetic@example.invalid',
          name: 'Synthetic Person',
          token: 'synthetic-secret',
          message: 'synthetic-sensitive',
          paymentUrl: 'https://example.invalid/?token=synthetic-secret',
        },
      },
    });
    expect(JSON.parse(output)).toMatchObject({
      status: 'COMPLETED',
      amount: 500,
      currency: 'CDF',
      reference: 'synthetic-payment',
      data: { transaction: { code: '0', redacted: true } },
    });
    for (const secret of [
      '000000000000',
      'synthetic@example.invalid',
      'Synthetic Person',
      'synthetic-secret',
      'synthetic-sensitive',
    ])
      expect(output).not.toContain(secret);
  });

  it('never falls back to raw text, including throwing accessors and cycles', () => {
    expect(formatPaymentLogPayload('synthetic-secret')).not.toContain(
      'synthetic-secret',
    );
    expect(
      formatPaymentLogPayload({
        get data() {
          throw Error('synthetic-secret');
        },
      }),
    ).toBe('"[unavailable]"');
    const item: Record<string, unknown> = {};
    item.data = item;
    expect(formatPaymentLogPayload(item)).toContain('[circular]');
    expect(
      formatPaymentLogPayload({
        status: 'ok\nsynthetic@example.invalid',
        'synthetic@example.invalid': 'secret',
      }),
    ).not.toContain('synthetic@example.invalid');
  });
});
