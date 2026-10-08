import dns = require('dns/promises');
import https = require('https');
import { EventEmitter } from 'events';
import { KycEvidenceTransport } from './kyc-evidence.transport';

describe('bounded Didit media transport', () => {
  let lookup: jest.SpyInstance,
    get: jest.SpyInstance,
    response: any,
    options: any;
  const transport = new KycEvidenceTransport();
  beforeEach(() => {
    lookup = jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any);
    response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-type': 'image/jpeg' },
      destroy: jest.fn(),
    });
    get = jest.spyOn(https, 'get').mockImplementation(((
      url: any,
      input: any,
      callback: any,
    ) => {
      options = input;
      queueMicrotask(() => {
        callback(response);
        response.emit('data', Buffer.from('image'));
        response.emit('end');
      });
      return new EventEmitter();
    }) as any);
  });
  afterEach(() => jest.restoreAllMocks());
  it('pins the public resolved address and never sends provider credentials to media', async () => {
    expect(
      await transport.image(
        'https://media.didit.test/photo?signature=synthetic',
        ['media.didit.test'],
      ),
    ).toEqual(Buffer.from('image'));
    const callback = jest.fn();
    options.lookup('media.didit.test', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(options.headers).toEqual({
      Accept: 'image/jpeg,image/png,image/webp',
    });
    expect(options.agent).toBe(false);
  });
  it('rejects a private DNS answer before opening the connection', async () => {
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(
      transport.image('https://media.didit.test/photo', ['media.didit.test']),
    ).rejects.toThrow('MEDIA_ADDRESS_REJECTED');
    expect(get).not.toHaveBeenCalled();
  });
  it.each([301, 302, 307, 403])(
    'does not follow redirect/error %s',
    async (status) => {
      response.statusCode = status;
      response.headers.location = 'http://169.254.169.254/';
      await expect(
        transport.image('https://media.didit.test/photo', ['media.didit.test']),
      ).rejects.toThrow('MEDIA_RESPONSE_REJECTED');
      expect(get).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses oversized responses and non-image content', async () => {
    response.headers['content-length'] = String(6 * 1024 * 1024);
    await expect(
      transport.image('https://media.didit.test/photo', ['media.didit.test']),
    ).rejects.toThrow();
    response.headers = { 'content-type': 'text/html' };
    await expect(
      transport.image('https://media.didit.test/photo', ['media.didit.test']),
    ).rejects.toThrow();
  });
  it('bounds a chunked response even without content-length', async () => {
    get.mockImplementation(((url: any, input: any, callback: any) => {
      queueMicrotask(() => {
        callback(response);
        response.emit('data', Buffer.alloc(5 * 1024 * 1024 + 1));
      });
      return new EventEmitter();
    }) as any);
    await expect(
      transport.image('https://media.didit.test/photo', ['media.didit.test']),
    ).rejects.toThrow('MEDIA_TOO_LARGE');
    expect(response.destroy).toHaveBeenCalled();
  });
});
