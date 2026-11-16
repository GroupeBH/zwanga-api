import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  normalizeZoneGeometry,
  advanceZoneMonitor,
  usableZoneObservation,
} from './zones.policy';
import { SaveZoneDto, ZonePageDto, ZoneSettingsDto } from './zones.dto';
import { ZonesController } from './zones.controller';
import { UserRole } from '../users/entities/user.entity';
import { ROLES_KEY } from '../common/guards/roles.guard';

describe('Operational zone safety policy', () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [15, -4],
        [16, -4],
        [16, -3],
        [15, -4],
      ],
    ],
  };
  it('normalizes Polygon without modifying coordinates', () => {
    expect(normalizeZoneGeometry(geometry)).toEqual({
      type: 'MultiPolygon',
      coordinates: [geometry.coordinates],
    });
  });
  it.each([
    null,
    {},
    { type: 'Point', coordinates: [15, -4] },
    { type: 'Polygon', coordinates: [] },
    {
      type: 'Polygon',
      coordinates: [
        [
          [15, -4],
          [16, -4],
          [16, -3],
        ],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [181, -4],
          [16, -4],
          [16, -3],
          [181, -4],
        ],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [15, NaN],
          [16, -4],
          [16, -3],
          [15, NaN],
        ],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [Array.from({ length: 5001 }, () => [15, -4])],
    },
  ])('rejects invalid / unbounded input %p', (value) =>
    expect(() => normalizeZoneGeometry(value)).toThrow(),
  );
  it('requires three distinct fixes over 20s and never counts a replay', () => {
    let state = advanceZoneMonitor({}, 10000, true).state;
    expect(advanceZoneMonitor(state, 10000, true).state).toEqual(state);
    state = advanceZoneMonitor(state, 20000, true).state;
    const result = advanceZoneMonitor(state, 30000, true);
    expect(result.event).toBe('outside');
    expect(advanceZoneMonitor(result.state, 40000, true).event).toBeUndefined();
    state = advanceZoneMonitor(result.state, 50000, false).state;
    state = advanceZoneMonitor(state, 60000, false).state;
    expect(advanceZoneMonitor(state, 70000, false).event).toBe('returned');
  });
  it('resets the candidate after interrupted GPS or a return inside', () => {
    let state = advanceZoneMonitor({}, 10000, true).state;
    state = advanceZoneMonitor(state, 20000, true).state;
    expect(advanceZoneMonitor(state, 60000, true)).toEqual({
      state: {
        outside: false,
        lastAt: 60000,
        candidate: true,
        since: 60000,
        count: 1,
      },
    });
    expect(
      advanceZoneMonitor(state, 30000, false).state.candidate,
    ).toBeUndefined();
  });
  it.each([null, 36, -1, NaN, Infinity])(
    'ignores inaccurate or unknown GPS accuracy %s',
    (accuracy) => {
      expect(
        usableZoneObservation(
          {
            recordedAt: new Date(10000).toISOString(),
            latitude: -4,
            longitude: 15,
            accuracyMeters: accuracy,
          },
          20000,
        ),
      ).toBe(false);
    },
  );
  it('ignores delayed and future fixes', () => {
    const point = {
      recordedAt: new Date(10000).toISOString(),
      latitude: -4,
      longitude: 15,
      accuracyMeters: 10,
    };
    expect(usableZoneObservation(point, 20000)).toBe(true);
    expect(usableZoneObservation(point, 60000)).toBe(false);
    expect(usableZoneObservation(point, 0)).toBe(false);
  });
  it('validates bounded pagination and strict booleans', async () => {
    expect(
      await validate(plainToInstance(ZonePageDto, { limit: '100' })),
    ).toHaveLength(0);
    expect(
      await validate(plainToInstance(ZonePageDto, { limit: '101' })),
    ).not.toHaveLength(0);
    expect(
      await validate(
        plainToInstance(
          SaveZoneDto,
          {
            name: 'Gombe',
            geometry,
            active: 'false',
          },
          { enableImplicitConversion: true },
        ),
      ),
    ).not.toHaveLength(0);
  });
  it('restricts configuration writes to super admins and reads to admins', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ZonesController)).toEqual([
      UserRole.ADMIN,
    ]);
    for (const method of ['create', 'update', 'settings'])
      expect(
        Reflect.getMetadata(ROLES_KEY, ZonesController.prototype[method]),
      ).toEqual([UserRole.SUPER_ADMIN]);
  });
  it('requires a real boolean and a version for runtime changes', async () => {
    for (const dto of [
      { enabled: 'false', version: 1 },
      { enabled: true },
      { enabled: false, version: 0 },
    ]) {
      expect(
        await validate(
          plainToInstance(ZoneSettingsDto, dto, {
            enableImplicitConversion: true,
          }),
        ),
      ).not.toHaveLength(0);
    }
    expect(
      await validate(
        plainToInstance(
          ZoneSettingsDto,
          { enabled: false, version: 1 },
          { enableImplicitConversion: true },
        ),
      ),
    ).toHaveLength(0);
  });
});
