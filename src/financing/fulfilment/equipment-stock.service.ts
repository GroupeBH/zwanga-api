import {
  Injectable,
  ServiceUnavailableException,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { ConfigService } from '@nestjs/config';
import type { CreditActor } from '../shared/credit.store';
import { CreditPageDto } from '../shared/credit.dto';
import { RegisterEquipmentStockDto } from './equipment-stock.dto';
import { createHmac, randomBytes, createCipheriv } from 'node:crypto';
import type { ProductRow, IdRow, ContractRow } from '../shared/credit.rows';
import { EntityManager } from 'typeorm';
import { DeliverCreditProductDto } from './credit-delivery.dto';

@Injectable()
export class EquipmentStockService {
  constructor(
    private readonly store: CreditStore,
    private readonly config: ConfigService,
  ) {}

  private key() {
    const encoded = this.config.get<string>('PRO_CREDIT_IDENTITY_KEY');
    if (!encoded || !/^[a-f0-9]{64}$/i.test(encoded))
      throw new ServiceUnavailableException(
        'Protection des identifiants matériels non configurée.',
      );
    return Buffer.from(encoded, 'hex');
  }

  async inventory(actor: CreditActor, productId: string, page: CreditPageDto) {
    const [p] = await this.store.db.query<{ supplierId: string }[]>(
      'SELECT "supplierId" FROM pro_credit_products WHERE id=$1',
      [productId],
    );
    if (!p) throw new NotFoundException('Produit introuvable.');
    await this.store.authorize(
      this.store.db.manager,
      actor,
      ['stock', 'supplier', 'auditor'],
      p.supplierId,
    );
    const rows = await this.store.db.query<
      {
        id: string;
        inventoryReference: string;
        status: string;
        creditId: string | null;
      }[]
    >(
      `SELECT id,"inventoryReference",status,"creditId" FROM pro_credit_stock
      WHERE "productId"=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,
      [productId, page.after ?? null, page.limit + 1],
    );
    return {
      items: rows.slice(0, page.limit),
      nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    };
  }

  async stock(actor: CreditActor, dto: RegisterEquipmentStockDto) {
    const key = this.key();
    const serialHash = createHmac('sha256', key)
      .update(`serial:${dto.serial.trim().toUpperCase()}`)
      .digest('hex');
    const imeiHash = dto.imei
      ? createHmac('sha256', key).update(`imei:${dto.imei}`).digest('hex')
      : null;
    // Never persist clear hardware identifiers in idempotency/audit payloads.
    return this.store.mutation(
      actor.userId,
      dto.mutationId,
      'stock',
      {
        productId: dto.productId,
        inventoryReference: dto.inventoryReference,
        serialHash,
        imeiHash,
      },
      async (m) => {
        const [product] = await m.query<ProductRow[]>(
          'SELECT * FROM pro_credit_products WHERE id=$1 FOR SHARE',
          [dto.productId],
        );
        if (!product || product.kind === 'document')
          throw new NotFoundException('Équipement introuvable.');
        await this.store.authorize(
          m,
          actor,
          ['stock', 'supplier'],
          product.supplierId,
        );
        if (product.kind === 'phone' && !dto.imei)
          throw new BadRequestException('IMEI requis.');
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(
          Buffer.from(`zwanga-pro:${dto.inventoryReference}:${dto.productId}`),
        );
        const encrypted = Buffer.concat([
          cipher.update(
            JSON.stringify({
              serial: dto.serial.trim(),
              imei: dto.imei ?? null,
            }),
            'utf8',
          ),
          cipher.final(),
        ]);
        const sealed = [
          'v1',
          iv.toString('hex'),
          cipher.getAuthTag().toString('hex'),
          encrypted.toString('hex'),
        ].join('.');
        const [item] = await m.query<IdRow[]>(
          `INSERT INTO pro_credit_stock("productId","inventoryReference","serialHash","imeiHash","encryptedIdentity") VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [dto.productId, dto.inventoryReference, serialHash, imeiHash, sealed],
        );
        await this.store.audit(m, actor.userId, 'stock_registered', {
          stockId: item.id,
          productId: dto.productId,
        });
        return item;
      },
    );
  }
  async assign(m: EntityManager, c: ContractRow, dto: DeliverCreditProductDto) {
    const id = c.id;
    const [stock] = await m.query<IdRow[]>(
      'SELECT id FROM pro_credit_stock WHERE id=$1 AND "productId"=$2 AND status=\'available\' FOR UPDATE',
      [dto.stockId ?? null, c.productId],
    );
    if (!stock)
      throw new ConflictException('Appareil indisponible ou déjà affecté.');
    await m.query(
      'UPDATE pro_credit_stock SET "creditId"=$2,status=\'delivered\' WHERE id=$1',
      [stock.id, id],
    );
  }
}
