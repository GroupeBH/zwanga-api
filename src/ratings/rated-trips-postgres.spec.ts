import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { Rating } from './entities/rating.entity';
import { RatingsService } from './ratings.service';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('rated trips on isolated PostgreSQL', () => {
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource, service: RatingsService;
  const account = randomUUID(),
    other = randomUUID(),
    first = randomUUID(),
    second = randomUUID(),
    legacy = randomUUID();
  beforeAll(async () => {
    db = await cluster.start();
    // Minimal mapping for the existing ratings columns; no application DB or secrets.
    db.setOptions({
      entities: [
        new EntitySchema({
          name: 'RatingLookupFixture',
          tableName: 'ratings',
          columns: {
            id: { type: 'uuid', primary: true },
            raterId: { type: 'uuid' },
            ratedUserId: { type: 'uuid' },
            tripId: { type: 'uuid' },
            verificationVersion: { type: 'smallint' },
            rating: { type: 'int' },
          },
        }),
      ],
    });
    await (
      db as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
    await db.query(`CREATE TABLE ratings(id uuid PRIMARY KEY, "raterId" uuid, "ratedUserId" uuid,
      "tripId" uuid, "verificationVersion" smallint, rating int);
      CREATE UNIQUE INDEX "UQ_ratings_verified_interaction" ON ratings("raterId","ratedUserId","tripId") WHERE "verificationVersion"=1`);
    service = new RatingsService(
      db.getRepository<Rating>('RatingLookupFixture'),
      {} as never,
    );
    for (const [rater, target, trip, version, stars] of [
      [account, other, first, 1, 1],
      [account, randomUUID(), first, 1, 5],
      [other, account, second, 1, 5],
      [account, other, legacy, 0, 5],
    ])
      await db.query('INSERT INTO ratings VALUES ($1,$2,$3,$4,$5,$6)', [
        randomUUID(),
        rater,
        target,
        trip,
        version,
        stars,
      ]);
  }, 60000);
  afterAll(async () => {
    await cluster.stop();
  });
  it('returns only the current author’s verified submitted trips, not received or legacy ratings', async () => {
    expect(await service.ratedTrips(account, [first, second, legacy])).toEqual({
      userId: account,
      ratedTripIds: [first],
    });
    expect(await service.ratedTrips(other, [first, second])).toEqual({
      userId: other,
      ratedTripIds: [second],
    });
  });
  it('deduplicates multiple rated passengers and does not gate the store prompt on a positive score', async () => {
    await db.query('DELETE FROM ratings WHERE "raterId"=$1 AND rating=5', [
      account,
    ]);
    expect(await service.ratedTrips(account, [first])).toEqual({
      userId: account,
      ratedTripIds: [first],
    });
  });
  it('does not disclose reviewed trips outside the supplied bounded set', async () => {
    expect(await service.ratedTrips(account, [randomUUID()])).toEqual({
      userId: account,
      ratedTripIds: [],
    });
  });
});
