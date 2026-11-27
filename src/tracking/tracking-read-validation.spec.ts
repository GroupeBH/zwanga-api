import 'reflect-metadata';
import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { TripsController } from '../trips/trips.controller';
import { BookingsController } from '../bookings/bookings.controller';

describe('REST GPS identifiers before batched SQL reads', () => {
  it.each([
    [TripsController, 'updateDriverLocation'],
    [BookingsController, 'updatePassengerLocation'],
  ] as const)('%s %s rejects malformed IDs before they can poison a SQL batch', async (controller, method) => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method);
    const id = Object.values(args).find((value: any) => value.data === 'id') as { pipes: unknown[] };
    expect(id.pipes).toContain(ParseUUIDPipe);
    const pipe = new ParseUUIDPipe();
    const metadata = { type: 'param' as const, data: 'id', metatype: String };
    await expect(pipe.transform('malformed', metadata)).rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform('8B1D5CB5-7584-4D31-AC13-2C1D993A8B96', metadata))
      .resolves.toBe('8B1D5CB5-7584-4D31-AC13-2C1D993A8B96');
  });
});
