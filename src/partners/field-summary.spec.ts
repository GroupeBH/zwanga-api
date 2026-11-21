import { fieldSummaryAccumulator } from './field-summary';

describe('bounded field summary accumulator', () => {
  it('separates organization counts from personal goals, funnel and eight-week activity', () => {
    const accumulator = fieldSummaryAccumulator('me', new Date('2026-11-19T12:00:00Z'));
    const createdAt = new Date('2026-11-16T12:00:00Z');
    accumulator.add({ agentId: 'me', status: 'CONTACTED', createdAt, firstTripAt: null });
    accumulator.add({ agentId: 'me', status: 'KYC_APPROVED', createdAt, firstTripAt: null });
    accumulator.add({ agentId: 'me', status: 'FIRST_TRIP', createdAt, firstTripAt: new Date('2026-11-18T12:00:00Z') });
    accumulator.add({ agentId: 'other', status: 'FIRST_TRIP', createdAt, firstTripAt: new Date('2026-11-18T12:00:00Z') });
    const result = accumulator.result();
    expect(result).toMatchObject({ period: '2026-11', achieved: 1, total: 4, counts: { all: 4, done: 2, progress: 2 },
      mine: { stages: { contacted: 3, registered: 2, kycApproved: 2, readyToDrive: 1, firstTrip: 1 } } });
    expect(result.byAgent).toEqual([{ agentId: 'me', inProgress: 2, firstTrip: 1 }, { agentId: 'other', inProgress: 0, firstTrip: 1 }]);
    expect(result.mine.weeks).toHaveLength(8);
    expect(result.mine.weeks.at(-1)).toEqual({ start: '2026-11-16', count: 3 });
  });

  it('uses Kinshasa month boundaries and excludes trips predating the lead from the goal', () => {
    const accumulator = fieldSummaryAccumulator('me', new Date('2026-10-31T23:30:00Z'));
    accumulator.add({ agentId: 'me', status: 'FIRST_TRIP', createdAt: new Date('2026-10-31T20:00:00Z'), firstTripAt: new Date('2026-10-31T23:10:00Z') });
    accumulator.add({ agentId: 'me', status: 'FIRST_TRIP', createdAt: new Date('2026-11-01T12:00:00Z'), firstTripAt: new Date('2026-11-01T10:00:00Z') });
    expect(accumulator.result()).toMatchObject({ period: '2026-11', achieved: 1, total: 2 });
  });
});
