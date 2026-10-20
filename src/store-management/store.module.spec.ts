import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { CacheService } from '../common/services/cache.service';
import { StoreManagementModule } from './store-management.module';
import { StoreService } from './store.service';
import { StoreWorker } from './store.worker';
import { StoreAlertsService } from './store-alerts.service';
import { UserRole } from '../users/entities/user.entity';

describe('Store module integration without credentials or schema access', () => {
  it('resolves the real Nest providers and remains inert when disabled', async () => {
    const db = {
      options: { type: 'postgres' },
      entityMetadatas: [],
      getRepository: jest.fn(() => ({})),
      query: jest.fn(),
    };
    @Global()
    @Module({
      providers: [
        { provide: DataSource, useValue: db },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            STORE_MANAGEMENT_ENABLED: 'false',
            STORE_SYNC_ENABLED: 'false',
          }),
        },
        { provide: CacheService, useValue: {} },
      ],
      exports: [DataSource, ConfigService, CacheService],
    })
    class ExistingGlobalServices {}
    const module = await Test.createTestingModule({
      imports: [ExistingGlobalServices, StoreManagementModule],
    }).compile();
    const app = module.createNestApplication();
    try {
      await app.init();
      db.getRepository.mockClear();
      expect(app.get(StoreService).status(UserRole.ADMIN).enabled).toBe(false);
      await app.get(StoreWorker).schedule();
      await app.get(StoreWorker).tick();
      await app.get(StoreAlertsService).evaluate();
      await app.get(StoreAlertsService).retain();
      expect(db.query).not.toHaveBeenCalled();
      expect(db.getRepository).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
