import { Global, Module, RequestMethod, Type } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { FinancingModule } from '../financing.module';
import { CreditStore } from '../shared/credit.store';
import { CreditApplicationsService } from '../applications/credit-applications.service';
import { CreditContractsService } from '../contracts/credit-contracts.service';
import { TripCreditRepaymentWorker } from '../repayments/trip-credit-repayment.worker';
import { CreditRemindersWorker } from '../schedules/credit-reminders.worker';
import { CreditDeliveryService } from '../fulfilment/credit-delivery.service';
import { EquipmentStockService } from '../fulfilment/equipment-stock.service';
import { VehicleDocumentsService } from '../fulfilment/vehicle-documents.service';
import { S3Service } from '../../common/services/s3.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

const imports = (m: Type) =>
  (Reflect.getMetadata(MODULE_METADATA.IMPORTS, m) ?? []) as Type[];
const providers = (m: Type) =>
  (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, m) ?? []) as Type[];
const controllers = (m: Type) =>
  (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, m) ?? []) as Type[];
const graph = (): Type[] => {
  const visited = new Set<Type>();
  const visit = (m: Type) => {
    if (visited.has(m)) return;
    visited.add(m);
    imports(m).forEach(visit);
  };
  visit(FinancingModule);
  return [...visited];
};

const runtimeDataSource = {
  query: jest.fn(),
  manager: {},
  transaction: jest.fn(),
};
// External systems are unavailable deliberately: assembling modules must not do I/O.
@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      useValue: runtimeDataSource,
    },
    { provide: ConfigService, useValue: new ConfigService({}) },
    { provide: S3Service, useValue: {} },
  ],
  exports: [DataSource, ConfigService, S3Service],
})
class RuntimeDependencies {}

describe('Financing domain boundaries', () => {
  it('keeps the composition root free of controllers and business providers', () => {
    expect(providers(FinancingModule)).toEqual([]);
    expect(controllers(FinancingModule)).toEqual([]);
    expect(imports(FinancingModule)).toHaveLength(14);
  });

  it('contains no circular Nest module dependency or forwardRef escape hatch', () => {
    const walk = (m: Type, ancestors: Type[]) => {
      expect(typeof m).toBe('function');
      expect(ancestors).not.toContain(m);
      for (const child of imports(m)) walk(child, [...ancestors, m]);
    };
    walk(FinancingModule, []);
  });

  it('registers each service once, especially scheduled workers and transactional infrastructure', () => {
    const all = graph().flatMap(providers);
    expect(all.length).toBe(new Set(all).size);
    for (const provider of [
      CreditStore,
      TripCreditRepaymentWorker,
      CreditRemindersWorker,
    ]) {
      expect(all.filter((p) => p === provider)).toHaveLength(1);
    }
  });

  it('preserves every existing HTTP method/path with one authenticated controller owner', () => {
    const routes: string[] = [];
    for (const c of graph().flatMap(controllers)) {
      expect(Reflect.getMetadata(GUARDS_METADATA, c)).toContain(JwtAuthGuard);
      const prefix = Reflect.getMetadata(PATH_METADATA, c) as string;
      expect(prefix.startsWith('zwanga-pro')).toBe(true);
      for (const key of Object.getOwnPropertyNames(c.prototype)) {
        const handler = (c.prototype as Record<string, object>)[key];
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (method === undefined) continue;
        routes.push(
          `${RequestMethod[method]} ${prefix === 'zwanga-pro' ? '' : prefix.slice('zwanga-pro/'.length) + '/'}${Reflect.getMetadata(PATH_METADATA, handler) as string}`,
        );
      }
    }
    expect(routes.length).toBe(new Set(routes).size);
    expect(routes.sort()).toEqual(
      [
        'GET catalogue',
        'GET commerce/categories',
        'GET commerce/products',
        'GET commerce/products/:id',
        'GET commerce/products/:id/quote',
        'GET commerce/admin/categories',
        'POST commerce/admin/categories',
        'POST commerce/admin/products/:id',
        'GET commerce/mine/:id/settlement',
        'POST commerce/mine/:id/settlement',
        'GET commerce/mine/:id/plans',
        'POST commerce/mine/:id/plans',
        'GET mine',
        'GET applications',
        'GET applications/:id',
        'POST applications',
        'GET mine/:id',
        'POST mine/:id/accept',
        'POST mine/:id/wallet-payments',
        'GET mine/:id/receipts',
        'POST mine/:id/revoke-mandate',
        'POST reschedules/:id/consent',
        'POST attachments',
        'GET attachments/:id',
        'GET admin/catalogue',
        'GET admin/access',
        'GET admin/configuration',
        'GET admin/overview',
        'GET admin/collections/debtors',
        'GET admin/credits/:id/recovery-actions',
        'POST admin/credits/:id/recovery-actions',
        'PUT admin/parties/:id',
        'POST admin/grants',
        'POST admin/policies',
        'POST admin/products',
        'PATCH admin/products/:id',
        'GET admin/applications',
        'GET admin/applications/:id',
        'POST admin/applications/:id/review',
        'GET admin/contracts',
        'GET admin/contracts/:id',
        'GET admin/contracts/:id/receipts',
        'POST admin/stock',
        'GET admin/products/:id/stock',
        'POST admin/contracts/:id/deliver',
        'POST admin/contracts/:id/activate',
        'PATCH admin/contracts/:id/execution',
        'POST admin/contracts/:id/reschedules',
        'POST admin/reschedules/:id/approve',
      ].sort(),
    );
  });

  it('assembles the real Nest module graph with independent application, contract and delivery services', async () => {
    const app = await Test.createTestingModule({
      imports: [RuntimeDependencies, FinancingModule],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => false })
      .compile();
    try {
      for (const service of [
        CreditApplicationsService,
        CreditContractsService,
        CreditDeliveryService,
        EquipmentStockService,
        VehicleDocumentsService,
        TripCreditRepaymentWorker,
        CreditRemindersWorker,
      ]) {
        expect(app.get(service)).toBeInstanceOf(service);
      }
      expect(app.get(DataSource)).toBe(runtimeDataSource);
      expect(runtimeDataSource.query).not.toHaveBeenCalled();
      expect(runtimeDataSource.transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
