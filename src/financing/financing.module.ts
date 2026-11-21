import { Module } from '@nestjs/common';
import { CreditPartnersModule } from './partners/credit-partners.module';
import { CreditPoliciesModule } from './policies/credit-policies.module';
import { CreditCatalogueModule } from './catalogue/credit-catalogue.module';
import { CreditEligibilityModule } from './eligibility/credit-eligibility.module';
import { CreditApplicationsModule } from './applications/credit-applications.module';
import { CreditContractsModule } from './contracts/credit-contracts.module';
import { CreditLedgerModule } from './ledger/credit-ledger.module';
import { CreditRepaymentsModule } from './repayments/credit-repayments.module';
import { CreditFulfilmentModule } from './fulfilment/credit-fulfilment.module';
import { CreditEvidenceModule } from './evidence/credit-evidence.module';
import { CreditSchedulesModule } from './schedules/credit-schedules.module';
import { CreditReportingModule } from './reporting/credit-reporting.module';
import { CommerceModule } from './commerce/commerce.module';

/** Composition only: business logic belongs to the imported domain modules. */
@Module({
  imports: [
    CreditPartnersModule,
    CreditPoliciesModule,
    CreditCatalogueModule,
    CreditEligibilityModule,
    CreditApplicationsModule,
    CreditContractsModule,
    CreditLedgerModule,
    CreditRepaymentsModule,
    CreditFulfilmentModule,
    CreditEvidenceModule,
    CreditSchedulesModule,
    CreditReportingModule,
    CommerceModule,
  ],
})
export class FinancingModule {}
