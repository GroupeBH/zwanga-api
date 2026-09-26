import { AddDriverPublicationPhotoPolicy1780000044000 } from './migrations/1780000044000-AddDriverPublicationPhotoPolicy';
import { AddExplicitDriverActivation1780000043000 } from './migrations/1780000043000-AddExplicitDriverActivation';
import { databaseMigrations } from './migrations';

describe('publication photo migration contract (no live database)', () => {
  const migration = new AddDriverPublicationPhotoPolicy1780000044000();
  it('runs after the driver activation migration', () => {
    expect(databaseMigrations.indexOf(AddDriverPublicationPhotoPolicy1780000044000))
      .toBeGreaterThan(databaseMigrations.indexOf(AddExplicitDriverActivation1780000043000));
  });
  it('backfills all surviving public history without filtering by status or deleting data', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await migration.up({ query } as any);
    const [ddl, backfill] = query.mock.calls.map(args => args[0]);
    expect(ddl).toContain('boolean NOT NULL DEFAULT false');
    expect(backfill).toContain('t."driverId" = u.id');
    expect(backfill).toContain('t."isPrivate" = false');
    expect(backfill).not.toMatch(/status|DELETE|DROP/i);
  });
  it('does not silently erase the durable allowance on rollback', async () => {
    await expect(migration.down()).rejects.toThrow('trace des publications');
  });
});
