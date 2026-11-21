import { Injectable, ConflictException } from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { CreditCatalogService } from '../catalogue/credit-catalogue.service';
import { CreditLedgerService } from '../ledger/credit-ledger.service';
import { CreditWalletPaymentDto } from './credit-wallet-payments.dto';
import { minor } from '../shared/money';
import type { ProductRow, IdRow } from '../shared/credit.rows';

@Injectable()
export class CreditWalletPaymentsService {
  constructor(
    private readonly store: CreditStore,
    private readonly catalog: CreditCatalogService,
    private readonly ledger: CreditLedgerService,
  ) {}

  async wallet(driverId: string, id: string, dto: CreditWalletPaymentDto) {
    const amount = minor(dto.amountMinor, false);
    try {
      return await this.store.mutation(
        driverId,
        dto.mutationId,
        'wallet',
        { id, ...dto },
        async (m) => {
          await this.store.driverLock(m, driverId);
          await m.query(
            'SELECT id FROM wallet_accounts WHERE "userId"=$1 AND type=\'points\' FOR UPDATE',
            [driverId],
          );
          await this.store.creditLock(m, driverId);
          const c = await this.store.contract(m, id, driverId, true);
          let walletEntryId: string;
          if (dto.purpose === 'deposit') {
            const [product] = await m.query<ProductRow[]>(
              'SELECT * FROM pro_credit_products WHERE id=$1 FOR SHARE',
              [c.productId],
            );
            await this.catalog.gate(m, product);
            if (
              c.status !== 'accepted' ||
              amount > BigInt(c.depositMinor) - BigInt(c.depositPaidMinor)
            )
              throw new ConflictException(
                'Acompte supérieur au montant restant ou contrat non accepté.',
              );
            [{ id: walletEntryId }] = await m.query<IdRow[]>(
              'SELECT zwanga_asset_wallet_debit($1,$2,$3,$4) AS id',
              [driverId, amount.toString(), id, dto.mutationId],
            );
            await m.query(
              'UPDATE pro_credit_contracts SET "depositPaidMinor"="depositPaidMinor"+$2 WHERE "creditId"=$1',
              [id, amount.toString()],
            );
          } else {
            if (
              c.status !== 'active' ||
              amount > BigInt(c.principalMinor) - BigInt(c.paidMinor)
            )
              throw new ConflictException(
                'Remboursement supérieur au solde restant ou financement inactif.',
              );
            await m.query('SELECT zwanga_asset_wallet_repay($1,$2,$3,$4)', [
              id,
              driverId,
              amount.toString(),
              dto.mutationId,
            ]);
            const [entry] = await m.query<{ walletEntryId: string }[]>(
              'SELECT "walletEntryId" FROM asset_credit_entries WHERE "creditId"=$1 AND "sourceKey"=$2',
              [id, `wallet:${dto.mutationId}`],
            );
            walletEntryId = entry.walletEntryId;
          }
          const receiptId = await this.ledger.journal(
            m,
            c,
            `wallet:${dto.mutationId}`,
            'wallet_clearing',
            dto.purpose === 'deposit'
              ? 'deposit_liability'
              : 'credit_receivable',
            amount,
            {
              purpose: dto.purpose,
              status: 'CONFIRMED',
              walletEntryId,
              mutationId: dto.mutationId,
            },
          );
          await this.store.audit(
            m,
            driverId,
            `${dto.purpose}_confirmed`,
            { receiptId },
            id,
          );
          await this.store.notify(m, driverId, id, `payment:${dto.mutationId}`);
          return {
            id,
            receiptId,
            status: 'CONFIRMED',
            amountMinor: amount.toString(),
            currency: 'CDF',
          };
        },
      );
    } catch (error) {
      if (
        /ASSET_(BALANCE|STATE|OWNER|REPLAY)/.test(
          error instanceof Error ? error.message : '',
        )
      )
        throw new ConflictException(
          'Solde disponible insuffisant ou opération déjà traitée.',
        );
      throw error;
    }
  }
}
