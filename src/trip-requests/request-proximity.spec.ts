import { DataSource, Raw } from 'typeorm';
import { typeOrmEntities } from '../database/entities';
import { TripRequest } from './entities/trip-request.entity';
import { nearbyRequestDriverVisibilitySql } from './request-proximity';

describe('request proximity ORM aliases', () => {
  let source: DataSource;

  beforeAll(async () => {
    // Compile the actual ORM SQL without opening a database connection.
    source = new DataSource({ type: 'postgres', entities: typeOrmEntities });
    await source['buildMetadatas']();
  });

  it.each([false, true])(
    'quotes Raw property aliases in list hydration (paged=%s)',
    (paged) => {
      const [sql, parameters] = source
        .getRepository(TripRequest)
        .createQueryBuilder('TripRequest')
        .setFindOptions({
          relations: ['passenger', 'targetDriver', 'driverOffers'],
          where: {
            id: Raw(
              (alias) =>
                `${paged ? `${alias} IN (:...requestIds) AND ` : ''}${nearbyRequestDriverVisibilitySql(alias, ':driverId')}`,
              {
                driverId: 'driver-bound-parameter',
                ...(paged ? { requestIds: ['request-bound-parameter'] } : {}),
              },
            ),
          },
        })
        .getQueryAndParameters();

      expect(sql).toContain('account_request.id = ("TripRequest"."id")');
      expect(sql).not.toMatch(/\bTripRequest\.id\b/);
      expect(sql).not.toContain('driver-bound-parameter');
      expect(parameters).toContain('driver-bound-parameter');
      if (paged) expect(parameters).toContain('request-bound-parameter');
    },
  );
});
