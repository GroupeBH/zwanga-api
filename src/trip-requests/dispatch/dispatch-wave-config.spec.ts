import { ConfigService } from '@nestjs/config';
import { SequentialDispatchService } from './sequential-dispatch.service';

describe('bounded dispatch wave configuration', () => {
  it.each([undefined, '4', 4, '999', 'invalid'])(
    'bounds the default or supplied value %s to four invitations',
    (value) => {
      const service = new SequentialDispatchService(
        {} as never,
        new ConfigService({ DRIVER_DISPATCH_WAVE_SIZE: value }),
        {} as never,
        {} as never,
        {} as never,
      );
      expect(service['waveSize']).toBe(4);
    },
  );
  it.each(['1', 1])(
    'supports the explicit single-driver fallback %s',
    (value) => {
      const service = new SequentialDispatchService(
        {} as never,
        new ConfigService({ DRIVER_DISPATCH_WAVE_SIZE: value }),
        {} as never,
        {} as never,
        {} as never,
      );
      expect(service['waveSize']).toBe(1);
    },
  );
});
