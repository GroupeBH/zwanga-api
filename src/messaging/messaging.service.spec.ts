import { NEVER, of, throwError } from 'rxjs';
import { MessagingService } from './messaging.service';

describe('bounded provider messaging', () => {
  function fixture() {
    const post = jest.fn();
    const settings = {
      WHATSAPP_ENABLED: 'false',
      KECCEL_TOKEN: 'test',
      KECCEL_FROM: 'test',
    };
    return {
      post,
      service: new MessagingService(
        { post } as any,
        { get: (key) => settings[key] } as any,
      ),
    };
  }
  it('times out a stalled provider and never retries an ambiguous delivery', async () => {
    jest.useFakeTimers();
    try {
      const { post, service } = fixture();
      post.mockReturnValue(NEVER);
      const result = service.sendMessage('+243000000000', 'test');
      await jest.advanceTimersByTimeAsync(5501);
      expect(await result).toBe(false);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.objectContaining({ timeout: 5000 }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
  it.each([401, 429, 500, undefined])(
    'does not replay a POST on provider/network failure %s',
    async (status) => {
      const { post, service } = fixture();
      post.mockReturnValue(
        throwError(() => ({ response: status ? { status } : undefined })),
      );
      expect(await service.sendMessage('+243000000000', 'test')).toBe(false);
      expect(post).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves the encoding fallback on an explicit unsupported-format rejection', async () => {
    const { post, service } = fixture();
    post
      .mockReturnValueOnce(throwError(() => ({ response: { status: 415 } })))
      .mockReturnValueOnce(of({ data: { status: 'SENT' } }));
    expect(await service.sendMessage('+243000000000', 'test')).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
