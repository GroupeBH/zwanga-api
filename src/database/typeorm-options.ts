import { existsSync, readFileSync } from 'node:fs';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import type { DataSourceOptions } from 'typeorm';
import { typeOrmEntities } from './entities';
import { databaseMigrations } from './migrations';

type ConfigReader = {
  get<T = string>(key: string): T | undefined;
};

type EnvironmentReader = NodeJS.ProcessEnv;

const DEFAULT_AWS_RDS_CA_FILE =
  '/usr/local/share/ca-certificates/aws-rds-global-bundle.crt';

function shouldSynchronize(nodeEnv?: string, synchronize?: string): boolean {
  return (nodeEnv || 'development') !== 'production' && synchronize === 'true';
}

function isTruthy(value?: string): boolean {
  return ['1', 'true', 'yes', 'y'].includes((value || '').toLowerCase());
}

function databaseUrlSslMode(databaseUrl?: string): string | undefined {
  if (!databaseUrl) {
    return undefined;
  }

  try {
    return new URL(databaseUrl).searchParams.get('sslmode') || undefined;
  } catch {
    const match = databaseUrl.match(/[?&]sslmode=([^&]+)/i);
    return match ? decodeURIComponent(match[1]) : undefined;
  }
}

function buildDatabaseSslOptions(params: {
  databaseUrl?: string;
  databaseSslCaFile?: string;
  databaseSslRejectUnauthorized?: string;
}):
  | {
      ca?: string;
      rejectUnauthorized: boolean;
    }
  | undefined {
  const sslMode = databaseUrlSslMode(params.databaseUrl)?.toLowerCase();

  if (sslMode === 'disable') {
    return undefined;
  }

  const hasExplicitRejectUnauthorized =
    params.databaseSslRejectUnauthorized !== undefined;
  const rejectUnauthorized = hasExplicitRejectUnauthorized
    ? isTruthy(params.databaseSslRejectUnauthorized)
    : true;

  if (!params.databaseUrl && !params.databaseSslCaFile) {
    return undefined;
  }

  const caFile =
    params.databaseSslCaFile ||
    process.env.DATABASE_SSL_CA_FILE ||
    process.env.NODE_EXTRA_CA_CERTS ||
    (existsSync(DEFAULT_AWS_RDS_CA_FILE) ? DEFAULT_AWS_RDS_CA_FILE : undefined);

  if (!caFile) {
    return { rejectUnauthorized };
  }

  try {
    return {
      ca: readFileSync(caFile, 'utf8'),
      rejectUnauthorized,
    };
  } catch (error) {
    throw new Error(
      `Unable to read PostgreSQL CA certificate file at ${caFile}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function buildBaseOptions(params: {
  databaseUrl?: string;
  databaseHost?: string;
  databasePort?: number;
  databaseUser?: string;
  databasePassword?: string;
  databaseName?: string;
  databaseSslCaFile?: string;
  databaseSslRejectUnauthorized?: string;
  nodeEnv?: string;
  typeormSynchronize?: string;
}): DataSourceOptions {
  const ssl = buildDatabaseSslOptions(params);
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
    return {
      ...baseConfig,
      url: params.databaseUrl,
      ssl,
      extra: ssl ? { ssl } : undefined,
    };
  }

  return {
    ...baseConfig,
    host: params.databaseHost,
    port: params.databasePort,
    username: params.databaseUser,
    password: params.databasePassword,
    database: params.databaseName,
    ssl,
    extra: ssl ? { ssl } : undefined,
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
    databaseSslCaFile: configService.get<string>('DATABASE_SSL_CA_FILE'),
    databaseSslRejectUnauthorized: configService.get<string>(
      'DATABASE_SSL_REJECT_UNAUTHORIZED',
    ),
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
    databaseSslCaFile: env.DATABASE_SSL_CA_FILE,
    databaseSslRejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
    nodeEnv: env.NODE_ENV,
    typeormSynchronize: env.TYPEORM_SYNCHRONIZE,
  });
}
