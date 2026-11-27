import dns = require('dns/promises');
import https = require('https');
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { DiditArchiveTransport } from './didit-archive.transport';

describe('Didit full collection API contracts', () => {
  const api = new DiditArchiveTransport();
  afterEach(() => jest.restoreAllMocks());
  it('uses the fixed authenticated API origin and proper standard, enriched, user/export/PDF paths', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    await api.decision('s', 'synthetic');
    await api.decision('s', 'synthetic', true);
    await api.user('u/id', 'synthetic');
    await api.startExport('s', 'synthetic', 'stable-operation');
    await api.exportStatus('s', 'e', 'synthetic');
    await api.report('s', 'synthetic');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://verification.didit.me/v3/session/s/decision/',
      'https://verification.didit.me/v3/session/s/decision/?include=events,resubmissions',
      'https://verification.didit.me/v3/users/u%2Fid/',
      'https://verification.didit.me/v3/session/s/files-export/',
      'https://verification.didit.me/v3/session/s/files-export/e/',
      'https://verification.didit.me/v3/session/s/generate-pdf/?language=fr',
    ]);
    expect(fetchMock.mock.calls[3][1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'Idempotency-Key': 'stable-operation',
        'x-api-key': 'synthetic',
      },
    });
    for (const call of fetchMock.mock.calls)
      expect(call[1]?.redirect).toBe('error');
  });
  it('does not propagate provider error bodies or accept oversized JSON', async () => {
    const mock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('private info', { status: 403 }));
    await expect(api.user('u', 'synthetic')).rejects.toThrow(
      'PROVIDER_READ_FAILED',
    );
    mock.mockResolvedValue(new Response('x'.repeat(8 * 1024 * 1024 + 1)));
    await expect(api.decision('s', 'synthetic')).rejects.toThrow(
      'PROVIDER_TOO_LARGE',
    );
  });
  it('pins only public, allowlisted HTTPS download hosts without leaking the API key', async () => {
    jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any);
    let options: any;
    const get = jest.spyOn(https, 'get').mockImplementation(((
      _url,
      opts,
      callback,
    ) => {
      options = opts;
      queueMicrotask(() =>
        callback(
          Object.assign(Readable.from([Buffer.from('PK\x05\x06')]), {
            statusCode: 200,
            headers: {
              'content-type': 'application/zip',
              'content-length': '4',
            },
          }),
        ),
      );
      return new EventEmitter();
    }) as any);
    const stream = await api.originals(
      'https://media.didit.test/file?signature=private',
      ['media.didit.test'],
      4,
    );
    expect(options.headers).toEqual({
      Accept: 'application/zip,application/octet-stream',
    });
    const callback = jest.fn();
    options.lookup('media.didit.test', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    stream.destroy();
    await expect(
      api.originals('http://169.254.169.254/', ['media.didit.test'], 4),
    ).rejects.toThrow('MEDIA_URL_REJECTED');
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('rejects private DNS and zip size outside the bounded streaming envelope', async () => {
    jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    await expect(
      api.originals('https://media.didit.test/a', ['media.didit.test'], 5),
    ).rejects.toThrow('MEDIA_ADDRESS_REJECTED');
    await expect(
      api.originals(
        'https://media.didit.test/a',
        ['media.didit.test'],
        129 * 1024 * 1024,
      ),
    ).rejects.toThrow('ORIGINAL_FILES_TOO_LARGE');
  });
});
