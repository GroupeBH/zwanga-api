import { DataSource } from 'typeorm';
import { AssetCredits1780000124000 } from '../src/database/migrations/1780000124000-AssetCredits';
import { EquipmentAssetCredits1780000127000 } from '../src/database/migrations/1780000127000-EquipmentAssetCredits';
import { ContractAssetCreditRates1780000129000 } from '../src/database/migrations/1780000129000-ContractAssetCreditRates';
import { AssetCreditCostDisclosure1780000130000 } from '../src/database/migrations/1780000130000-AssetCreditCostDisclosure';
import { AssetRepaymentPlans1780000133000 } from '../src/database/migrations/1780000133000-AssetRepaymentPlans';
import { ZwangaProFoundations1780000137000 } from '../src/database/migrations/1780000137000-ZwangaProFoundations';
import { ZwangaProSettlements1780000138000 } from '../src/database/migrations/1780000138000-ZwangaProSettlements';
import { ZwangaProOperations1780000139000 } from '../src/database/migrations/1780000139000-ZwangaProOperations';

export async function proFixture(db: DataSource) {
  await db.query(`CREATE EXTENSION "uuid-ossp";
    CREATE TABLE users(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),role text DEFAULT 'driver',"isDriver" boolean DEFAULT true,"isActive" boolean DEFAULT true,status text DEFAULT 'active',"createdAt" timestamptz DEFAULT now());
    CREATE TABLE kyc_documents(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"userId" uuid,status text,"createdAt" timestamptz DEFAULT now());
    CREATE TABLE partner_organizations(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"legalName" text DEFAULT 'Test legal entity',status text DEFAULT 'ACTIVE');
    CREATE TABLE partner_members(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"userId" uuid,"organizationId" uuid,status text DEFAULT 'ACTIVE');
    CREATE TABLE vehicles(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"ownerId" uuid,type text DEFAULT 'car',"isActive" boolean DEFAULT true);
    CREATE TABLE pro_service_cases(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"ownerId" uuid,"serviceCode" text DEFAULT 'documents',status text DEFAULT 'submitted');
    CREATE TABLE trips(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"driverId" uuid);
    CREATE TABLE bookings(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"tripId" uuid,"paymentMode" text DEFAULT 'electronic',"paymentStatus" text DEFAULT 'succeeded',status text DEFAULT 'completed',"paymentCurrency" text DEFAULT 'CDF',"cashReceivedAt" timestamptz,"cashReceivedAmount" numeric(12,2),"cashReceivedByDriverId" uuid);
    CREATE TABLE wallet_accounts(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"userId" uuid,type text DEFAULT 'points',balance numeric(12,2) DEFAULT 0,"withdrawableBalance" numeric(12,2) DEFAULT 0,"reservedCashCommissionBalance" numeric(12,2) DEFAULT 0,"withdrawalsBlocked" boolean DEFAULT false,currency text DEFAULT 'PTS',"updatedAt" timestamptz DEFAULT now(), UNIQUE("userId",type), CHECK(balance>=0 AND "withdrawableBalance">=0 AND "withdrawableBalance"<=balance));
    CREATE TABLE wallet_ledger_entries(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"accountId" uuid,"userId" uuid,"accountType" text,type text,amount numeric(12,2),"withdrawableAmount" numeric(12,2),"balanceAfter" numeric(12,2),currency text,"relatedEntityType" text,"relatedEntityId" uuid,description text,CONSTRAINT "CHK_wallet_ledger_type" CHECK(type IN ('top_up')));
    CREATE TABLE driver_earnings(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"driverId" uuid,"bookingId" uuid UNIQUE,"tripId" uuid,"paymentMode" text DEFAULT 'electronic',"grossAmount" numeric(12,2),"netAmount" numeric(12,2),"commissionAmount" numeric(12,2),currency text DEFAULT 'CDF',status text DEFAULT 'available',"createdAt" timestamptz DEFAULT clock_timestamp(),"updatedAt" timestamptz DEFAULT now(),CHECK("grossAmount"="netAmount"+"commissionAmount"));
    CREATE TABLE driver_payouts(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"driverId" uuid,amount numeric(12,2),status text,recoveryBlocked boolean DEFAULT false);
    CREATE TABLE notifications(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"eventKey" text UNIQUE,"userId" text,"fcmToken" text,title text,body text,data jsonb,"isAutomatic" boolean,status text,"errorMessage" text);
  `);
  for (const Migration of [
    AssetCredits1780000124000,
    EquipmentAssetCredits1780000127000,
    ContractAssetCreditRates1780000129000,
    AssetCreditCostDisclosure1780000130000,
    AssetRepaymentPlans1780000133000,
    ZwangaProFoundations1780000137000,
    ZwangaProSettlements1780000138000,
    ZwangaProOperations1780000139000,
  ]) {
    await db.transaction((m) => new Migration().up(m.queryRunner!));
  }
}
