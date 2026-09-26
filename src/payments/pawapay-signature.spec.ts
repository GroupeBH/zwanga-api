import { generateKeyPairSync } from 'node:crypto';
import { signPawaPayRequest, verifyPawaPayCallback } from './pawapay-signature';

describe('pawaPay HTTP message signatures', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const privatePem = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const publicPem = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const url = 'https://api.sandbox.pawapay.io/v2/deposits';
  const body = Buffer.from(
    '{"depositId":"11111111-1111-4111-8111-111111111111"}',
  );

  const signed = () => {
    const headers = signPawaPayRequest(
      url,
      body.toString(),
      privatePem,
      'ZWANGA_TEST_KEY',
    );
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
  };

  it('signs exactly the JSON bytes sent and verifies the pawaPay signature base', () => {
    expect(
      verifyPawaPayCallback({
        method: 'POST',
        url,
        body,
        headers: signed(),
        publicKeyPem: publicPem,
      }),
    ).toBe('ZWANGA_TEST_KEY');
  });

  it('rejects a modified body or target path', () => {
    const headers = signed();
    expect(() =>
      verifyPawaPayCallback({
        method: 'POST',
        url,
        body: Buffer.from('{}'),
        headers,
        publicKeyPem: publicPem,
      }),
    ).toThrow();
    expect(() =>
      verifyPawaPayCallback({
        method: 'POST',
        url: `${url}/other`,
        body,
        headers,
        publicKeyPem: publicPem,
      }),
    ).toThrow();
  });

  it('rejects expired and unsigned callbacks', () => {
    const headers = signed();
    expect(() =>
      verifyPawaPayCallback({
        method: 'POST',
        url,
        body,
        headers,
        publicKeyPem: publicPem,
        now: Math.floor(Date.now() / 1000) + 301,
      }),
    ).toThrow();
    expect(() =>
      verifyPawaPayCallback({
        method: 'POST',
        url,
        body,
        headers: {},
        publicKeyPem: publicPem,
      }),
    ).toThrow();
  });
});
