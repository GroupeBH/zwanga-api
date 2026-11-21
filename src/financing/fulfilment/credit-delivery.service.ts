import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { EquipmentStockService } from './equipment-stock.service';
import { VehicleDocumentsService } from './vehicle-documents.service';
import type { CreditActor } from '../shared/credit.store';
import {
  DeliverCreditProductDto,
  UpdateCreditDeliveryDto,
} from './credit-delivery.dto';
import type { IdRow } from '../shared/credit.rows';

@Injectable()
export class CreditDeliveryService {
  constructor(
    private readonly store: CreditStore,
    private readonly stock: EquipmentStockService,
    private readonly documents: VehicleDocumentsService,
  ) {}

  async deliver(actor: CreditActor, id: string, dto: DeliverCreditProductDto) {
    return this.store.mutation(
      actor.userId,
      dto.mutationId,
      'deliver',
      { id, ...dto },
      async (m) => {
        const c = await this.store.contract(m, id, undefined, true);
        if (c.driverId === actor.userId)
          throw new ConflictException(
            'La remise doit être attestée par un agent distinct du bénéficiaire.',
          );
        const document = c.snapshot.product.kind === 'document';
        if (
          c.snapshot.purchase &&
          BigInt(c.depositPaidMinor) + BigInt(c.paidMinor) <
            BigInt(c.snapshot.purchase.beforeDeliveryMinor)
        )
          throw new ConflictException(
            'Le paiement avant remise n’est pas encore confirmé.',
          );
        await this.store.authorize(
          m,
          actor,
          document ? ['documents', 'supplier'] : ['stock', 'supplier'],
          c.snapshot.product.supplierId,
        );
        if (
          !['accepted', 'active'].includes(c.status) ||
          c.depositPaidMinor !== c.depositMinor ||
          !['pending', 'processing'].includes(c.deliveryState)
        )
          throw new ConflictException(
            'Contrat accepté, acompte encaissé et remise non effectuée requis.',
          );
        const [proof] = await m.query<IdRow[]>(
          'SELECT id FROM pro_credit_attachments WHERE id=$1 AND "ownerId"=$2',
          [dto.proofId, actor.userId],
        );
        if (!proof) throw new NotFoundException('Preuve privée introuvable.');
        if (document) await this.documents.issue(m, c, dto);
        else await this.stock.assign(m, c, dto);
        await m.query(
          'UPDATE pro_credit_contracts SET "deliveryState"=\'delivered\',"deliveryProofId"=$2,"deliveredAt"=now() WHERE "creditId"=$1',
          [id, dto.proofId],
        );
        await this.store.audit(
          m,
          actor.userId,
          'delivered',
          { proofId: dto.proofId, stockId: dto.stockId ?? null },
          id,
        );
        await this.store.notify(m, c.driverId, id, `delivered:${id}`);
        return { id, deliveryState: 'delivered' };
      },
    );
  }

  async execution(
    actor: CreditActor,
    id: string,
    dto: UpdateCreditDeliveryDto,
  ) {
    return this.store.mutation(
      actor.userId,
      dto.mutationId,
      'execution',
      { id, ...dto },
      async (m) => {
        const c = await this.store.contract(m, id, undefined, true);
        await this.store.authorize(
          m,
          actor,
          c.snapshot.product.kind === 'document'
            ? ['documents', 'supplier']
            : ['stock', 'supplier'],
          c.snapshot.product.supplierId,
        );
        const allowed =
          dto.status === 'processing'
            ? c.deliveryState === 'pending'
            : dto.status === 'rejected'
              ? ['pending', 'processing'].includes(c.deliveryState)
              : c.deliveryState === 'delivered';
        if (!allowed || !['accepted', 'active', 'settled'].includes(c.status))
          throw new ConflictException('Transition de livraison non autorisée.');
        await m.query(
          'UPDATE pro_credit_contracts SET "deliveryState"=$2 WHERE "creditId"=$1',
          [id, dto.status],
        );
        if (dto.status === 'returned')
          await m.query(
            'UPDATE pro_credit_stock SET status=\'returned\' WHERE "creditId"=$1',
            [id],
          );
        // A return/rejection suspends future automatic collection, never invents a refund or erases the debt.
        await this.store.audit(
          m,
          actor.userId,
          'execution_updated',
          { state: dto.status, reason: dto.reason },
          id,
        );
        await this.store.notify(
          m,
          c.driverId,
          id,
          `execution:${dto.mutationId}`,
        );
        return {
          id,
          deliveryState: dto.status,
          financialReviewRequired: dto.status !== 'processing',
        };
      },
    );
  }
}
