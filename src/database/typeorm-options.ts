import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import type { DataSourceOptions } from 'typeorm';
import { typeOrmEntities } from './entities';
import { databaseMigrations } from './migrations';

type ConfigReader = {
  get<T = string>(key: string): T | undefined;
};

type EnvironmentReader = NodeJS.ProcessEnv;

function shouldSynchronize(nodeEnv?: string, synchronize?: string): boolean {
  return (nodeEnv || 'development') !== 'production' && synchronize === 'true';
}

function buildBaseOptions(params: {
  databaseUrl?: string;
  databaseHost?: string;
  databasePort?: number;
  databaseUser?: string;
  databasePassword?: string;
  databaseName?: string;
  nodeEnv?: string;
  typeormSynchronize?: string;
}): DataSourceOptions {
  const baseConfig = {
    type: 'postgres' as const,
    entities: typeOrmEntities,
    migrations: databaseMigrations,
    migrationsTableName: 'typeorm_migrations',
    synchronize: shouldSynchronize(
      params.nodeEnv,
      params.typeormSynchronize,
    ),
    migrationsRun: false,
    logging: false,
  };

  if (params.databaseUrl) {
    const sslDisabled = params.databaseUrl.includes('sslmode=disable');
    return {
      ...baseConfig,
      url: params.databaseUrl,
      ssl: sslDisabled
        ? undefined
        : {
            rejectUnauthorized: false,
          },
      extra: sslDisabled ? undefined : { sslmode: 'require' },
    };
  }

  return {
    ...baseConfig,
    host: params.databaseHost,
    port: params.databasePort,
    username: params.databaseUser,
    password: params.databasePassword,
    database: params.databaseName,
  };
}

export function buildTypeOrmModuleOptions(
  configService: ConfigReader,
): TypeOrmModuleOptions {
  return buildBaseOptions({
    databaseUrl: configService.get<string>('DATABASE_URL'),
    databaseHost: configService.get<string>('DATABASE_HOST'),
    databasePort: configService.get<number>('DATABASE_PORT'),
    databaseUser: configService.get<string>('DATABASE_USER'),
    databasePassword: configService.get<string>('DATABASE_PASSWORD'),
    databaseName: configService.get<string>('DATABASE_NAME'),
    nodeEnv: configService.get<string>('NODE_ENV'),
    typeormSynchronize: configService.get<string>('TYPEORM_SYNCHRONIZE'),
  }) as TypeOrmModuleOptions;
}

export function buildTypeOrmDataSourceOptions(
  env: EnvironmentReader = process.env,
): DataSourceOptions {
  return buildBaseOptions({
    databaseUrl: env.DATABASE_URL,
    databaseHost: env.DATABASE_HOST,
    databasePort: env.DATABASE_PORT ? Number(env.DATABASE_PORT) : undefined,
    databaseUser: env.DATABASE_USER,
    databasePassword: env.DATABASE_PASSWORD,
    databaseName: env.DATABASE_NAME,
    nodeEnv: env.NODE_ENV,
    typeormSynchronize: env.TYPEORM_SYNCHRONIZE,
  });
}
