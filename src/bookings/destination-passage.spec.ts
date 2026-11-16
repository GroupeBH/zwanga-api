import { hasRecentDestinationPassage } from './destination-passage';

describe('observed destination passage', () => {
  const now = new Date('2026-11-16T10:00:00Z');
  const destination = { type: 'Point' as const, coordinates: [15.3, -4.3] };
  const sample = (meters: number, age = 0, accuracy = 5) => ({
    latitude: -4.3 + meters / 111195,
    longitude: 15.3,
    recordedAt: new Date(now.getTime() - age).toISOString(),
    accuracyMeters: accuracy,
    speedMetersPerSecond: null,
    headingDegrees: null,
  });
  const history = (a = sample(-50, 8000), b = sample(50)) => ({
    previous: a,
    current: b,
    samples: [a, b],
  });
  it('recognizes crossing between two accurate fixes without a fix inside 25m', () => {
    expect(hasRecentDestinationPassage(history(), destination, now)).toBe(true);
  });
  it.each([
    history(sample(-200, 8000), sample(200)),
    history(sample(-50, 100000), sample(50, 92000)),
    history(sample(-50, 8000), sample(50, -1000)),
    history(sample(-50, 8000, 71), sample(50)),
    history(sample(-50, 1000), sample(50)),
    history(sample(-100, 8000), sample(-50)),
  ])(
    'rejects long, old, future, inaccurate, impossible or noncrossing segments',
    (h) => {
      expect(hasRecentDestinationPassage(h, destination, now)).toBe(false);
    },
  );
  it('does not reuse a passage before pickup', () => {
    expect(
      hasRecentDestinationPassage(
        history(),
        destination,
        now,
        new Date(now.getTime() - 4000),
      ),
    ).toBe(false);
  });
});
