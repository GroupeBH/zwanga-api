import {
  buildTypeOrmDataSourceOptions,
  buildTypeOrmModuleOptions,
} from './typeorm-options';

describe('PostgreSQL runtime budgets', () => {
  function runtime(values: Record<string, string> = {}) {
    return buildTypeOrmModuleOptions({
      get: (key: string) => values[key] as any,
    });
  }
  it('bounds runtime acquisition and queries with the existing pool size', () => {
    expect(runtime().extra).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      lock_timeout: 5000,
    });
  });
  it('keeps migrations separate and supports a dedicated owner credential', () => {
    const options = buildTypeOrmDataSourceOptions({
      DATABASE_URL: 'postgres://runtime@localhost/test?sslmode=disable',
      MIGRATION_DATABASE_URL: 'postgres://owner@localhost/test?sslmode=disable',
    });
    expect(options).toHaveProperty(
      'url',
      'postgres://owner@localhost/test?sslmode=disable',
    );
    expect(options.extra).toMatchObject({
      max: 2,
      connectionTimeoutMillis: 5000,
    });
    expect(options.extra).not.toHaveProperty('statement_timeout');
    expect(
      runtime({ MIGRATION_DATABASE_URL: 'not-used-by-api' }),
    ).not.toHaveProperty('url');
  });
  it('rejects invalid budgets instead of silently disabling them', () => {
    for (const value of ['0', '-1', 'NaN', '0.5'])
      expect(() => runtime({ DATABASE_POOL_MAX: value })).toThrow(
        'positive integer',
      );
  });
});
