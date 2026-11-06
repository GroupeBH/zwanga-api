import express from 'express';
import request from 'supertest';
import { trustedProxyCidrs } from './trusted-proxy';

describe('explicit trusted proxy topology', () => {
  it('defaults to no trust', () => expect(trustedProxyCidrs()).toBe(false));
  it.each([
    'true',
    '*',
    '1',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.1/33',
    '::1/129',
    '10.0.0.1/-1',
  ])('rejects %s', (value) => {
    expect(() => trustedProxyCidrs(value)).toThrow('TRUSTED_PROXY_CIDRS');
  });
  it('preserves only explicit addresses/subnets', () => {
    expect(trustedProxyCidrs(' 10.1.0.0/24,::1/128 ')).toEqual([
      '10.1.0.0/24',
      '::1/128',
    ]);
  });
  it('ignores spoofed forwarded addresses from an untrusted peer', async () => {
    const app = express();
    app.set('trust proxy', trustedProxyCidrs('10.1.0.0/24'));
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    const response = await request(app)
      .get('/')
      .set('X-Forwarded-For', '198.51.100.1');
    expect(response.body.ip).not.toBe('198.51.100.1');
  });
  it('uses the last untrusted hop, not the forged first XFF value', async () => {
    const app = express();
    app.set('trust proxy', trustedProxyCidrs('127.0.0.1/32,::1/128'));
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    expect(
      (
        await request(app)
          .get('/')
          .set('X-Forwarded-For', '192.0.2.7,198.51.100.9')
      ).body.ip,
    ).toBe('198.51.100.9');
  });
});
