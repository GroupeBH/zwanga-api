import axios from 'axios';
import { lookup } from 'node:dns/promises';
import { StoreHttp } from './store.http';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

describe('Store signed report transport', () => {
  beforeEach(() => jest.mocked(lookup).mockReset());
  afterEach(() => jest.restoreAllMocks());

  it('pins the validated address with IPv4 semantics and never forwards credentials', async () => {
    jest
      .mocked(lookup)
      .mockResolvedValue([{ address: '17.253.144.10', family: 4 }] as any);
    const download = jest
      .spyOn(axios, 'get')
      .mockImplementation(async (_url, options) => {
        const agent = options!.httpsAgent;
        expect(agent.options.family).toBe(4);
        const callback = jest.fn();
        agent.options.lookup('reports.apple.com', { family: 4 }, callback);
        expect(callback).toHaveBeenCalledWith(null, '17.253.144.10', 4);
        expect(options!.headers).toEqual({
          Accept: 'application/octet-stream',
        });
        expect(options!.maxRedirects).toBe(0);
        expect(options!.proxy).toBe(false);
        return { data: Buffer.from('report') };
      });
    expect(
      await new StoreHttp().report(
        'https://reports.apple.com/report?signature=test',
        ['reports.apple.com'],
        AbortSignal.timeout(1000),
      ),
    ).toEqual(Buffer.from('report'));
    expect(lookup).toHaveBeenCalledWith('reports.apple.com', {
      all: true,
      family: 4,
    });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254'])(
    'rejects a signed host resolving to %s before HTTP',
    async (address) => {
      jest.mocked(lookup).mockResolvedValue([{ address, family: 4 }] as any);
      const download = jest.spyOn(axios, 'get');
      await expect(
        new StoreHttp().report(
          'https://reports.apple.com/report',
          ['reports.apple.com'],
          AbortSignal.timeout(1000),
        ),
      ).rejects.toThrow('REPORT_ADDRESS_REJECTED');
      expect(download).not.toHaveBeenCalled();
    },
  );
});
