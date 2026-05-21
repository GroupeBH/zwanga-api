import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { buildTypeOrmDataSourceOptions } from './typeorm-options';

config({ path: process.env.ENV_FILE || '.env' });

export default new DataSource(buildTypeOrmDataSourceOptions(process.env));
