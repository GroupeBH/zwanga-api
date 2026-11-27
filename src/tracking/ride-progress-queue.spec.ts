import { finishRideProgress, finishAndClaimRideProgress } from './ride-progress-queue';

describe('ride progress acknowledgement queries', () => {
  const job = { tripId: 'trip', leaseToken: 'lease', version: '7' };

  it('uses one conditional deletion when this lease and version are finished', async () => {
    const db = { query: jest.fn().mockResolvedValue([{ tripId: job.tripId }]) };
    await finishRideProgress(db, job, false);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('AND NOT $4::boolean AND o.version=$3::bigint'),
      [job.tripId, job.leaseToken, job.version, false, 1000],
    );
  });

  it('releases only the same lease when a newer GPS version survives deletion', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    await finishRideProgress(db, job, false);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining('AND ($4::boolean OR o.version<>$3::bigint)'),
      [job.tripId, job.leaseToken, job.version, false, 1000],
    );
  });

  it('does not delete failed work and preserves the five-second backoff', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    await finishRideProgress(db, job, true);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE ride_progress_jobs'),
      [job.tripId, job.leaseToken, job.version, true, 5000],
    );
  });

  it('keeps the shorter history-recovery backoff and locks only the owned row', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    await finishRideProgress(db, job, true, 1000);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE "tripId"=$1 AND "leaseToken"=$2 FOR UPDATE'),
      [job.tripId, job.leaseToken, job.version, true, 1000],
    );
  });

  it('propagates a failed deletion instead of releasing a job with unknown state', async () => {
    const error = new Error('database unavailable');
    const db = { query: jest.fn().mockRejectedValue(error) };
    await expect(finishRideProgress(db, job, false)).rejects.toBe(error);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it('finishes and transfers a single slot in one statement with a fresh lease', async () => {
    const next = { tripId: 'next', version: '1', leaseToken: 'new-lease' };
    const db = { query: jest.fn().mockResolvedValue([next]) };
    expect(await finishAndClaimRideProgress(db, job, false)).toBe(next);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('LIMIT 1 FOR UPDATE OF j SKIP LOCKED');
    expect(sql).toContain('j."tripId"<>$1 AND EXISTS (SELECT 1 FROM settled)');
    expect(params.slice(0, 5)).toEqual([job.tripId, job.leaseToken, job.version, false, 1000]);
    expect(params[5]).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('returns no successor for an empty handoff and propagates failures without retry', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('unavailable')) };
    expect(await finishAndClaimRideProgress(db, job, true, 1000)).toBeUndefined();
    await expect(finishAndClaimRideProgress(db, job, true)).rejects.toThrow('unavailable');
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][1][4]).toBe(5000);
  });
});
