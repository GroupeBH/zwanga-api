import { mobishastraProxy } from './mobishastra-proxy';

describe('Mobishastra dedicated proxy configuration', () => {
  it('retains direct mode explicitly when not configured', () => {
    expect(mobishastraProxy(undefined, undefined, 'production')).toBe(false);
    expect(mobishastraProxy(' ', 'false', 'production')).toBe(false);
  });

  it.each(['10.42.0.123', '172.16.0.1', '172.31.255.254', '192.168.1.4'])(
    'accepts the operator-configured private IPv4 %s',
    (host) => {
      expect(
        mobishastraProxy(`http://${host}:3128`, 'true', 'production'),
      ).toEqual({ protocol: 'http', host, port: 3128 });
    },
  );

  it('permits an SSM loopback tunnel only in explicit local/test environments', () => {
    expect(
      mobishastraProxy('http://127.0.0.1:13128', true, 'development'),
    ).toEqual({ protocol: 'http', host: '127.0.0.1', port: 13128 });
    expect(() =>
      mobishastraProxy('http://127.0.0.1:13128', true, 'production'),
    ).toThrow();
    expect(() =>
      mobishastraProxy('http://127.0.0.1:13128', true, undefined),
    ).toThrow();
  });

  it.each([
    '',
    'http://169.254.169.254:80',
    'http://1.1.1.1:3128',
    'http://172.32.0.1:3128',
    'http://0.0.0.0:3128',
    'http://localhost:3128',
    'http://attacker.invalid:3128',
    'http://10.42.0.1:3128/path',
    'http://user:password@10.42.0.1:3128',
    'http://10.42.0.1:3128?secret=1',
    'http://10.42.0.1:3128#fragment',
    'http://10.42.0.1:0',
    'http://10.42.0.1:65536',
    'http://10.42.0.1',
    'http://10.1:3128',
    'http://010.0.0.1:3128',
    'http://[::1]:3128',
    'socks5://10.42.0.1:3128',
    'https://10.42.0.1:3128',
    'http://10.42.0.1\n:3128',
  ])('fails closed without exposing invalid configuration %j', (url) => {
    expect(() => mobishastraProxy(url, true, 'production')).toThrow(
      'Le service SMS est momentanément indisponible.',
    );
  });

  it('does not silently accept a misspelled required flag', () => {
    expect(() => mobishastraProxy(undefined, 'tru', 'production')).toThrow();
  });
});
