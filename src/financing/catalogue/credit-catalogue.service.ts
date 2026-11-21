import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import type { CreditActor } from '../shared/credit.store';
import { CreateCreditProductDto } from './credit-catalogue.dto';
import { minor, MAX_MINOR } from '../shared/money';
import type { IdRow, ProductRow, PolicyRow } from '../shared/credit.rows';
import { EntityManager } from 'typeorm';
import { CreditPageDto } from '../shared/credit.dto';

@Injectable()
export class CreditCatalogService {
  constructor(private readonly store: CreditStore) {}

  async create(actor: CreditActor, dto: CreateCreditProductDto) {
    if (minor(dto.priceMinor, false) + minor(dto.feeMinor) > MAX_MINOR)
      throw new BadRequestException('Total trop élevé.');
    if (dto.kind === 'phone' && (!dto.brand?.trim() || !dto.model?.trim()))
      throw new BadRequestException('Marque et modèle requis.');
    return this.store.db.transaction(async (m) => {
      await this.store.authorize(m, actor, ['manager']);
      const {
        kind,
        code,
        name,
        description,
        supplierId,
        sellerId,
        creditorId,
        policyId,
        financingModel,
        currency,
        priceMinor,
        feeMinor,
        ...details
      } = dto;
      const [row] = await m.query<IdRow[]>(
        `INSERT INTO pro_credit_products(kind,code,name,description,"supplierId","sellerId","creditorId","policyId","financingModel",currency,"priceMinor","feeMinor",details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          kind,
          code,
          name.trim(),
          description.trim(),
          supplierId,
          sellerId,
          creditorId,
          policyId,
          financingModel,
          currency,
          priceMinor,
          feeMinor,
          JSON.stringify(details),
        ],
      );
      await this.store.audit(m, actor.userId, 'product_created', {
        id: row.id,
      });
      return row;
    });
  }

  async gate(m: EntityManager, product: ProductRow) {
    if (!product.enabled || product.financingModel === 'CO_FINANCED')
      throw new ConflictException('Offre désactivée.');
    const parties = await m.query<
      {
        organizationId: string;
        enabled: boolean;
        status: string;
        legalName: string;
        supplier: boolean;
        funder: boolean;
        operator: boolean;
      }[]
    >(
      `SELECT p.*,o.status,o."legalName" FROM pro_credit_parties p
      JOIN partner_organizations o ON o.id=p."organizationId" WHERE p."organizationId"=ANY($1::uuid[]) FOR SHARE OF p,o`,
      [[product.supplierId, product.sellerId, product.creditorId]],
    );
    const find = (id: string) =>
      parties.find(
        (p) =>
          p.organizationId === id &&
          p.enabled &&
          p.status === 'ACTIVE' &&
          p.legalName,
      );
    const creditor = find(product.creditorId);
    if (
      !find(product.supplierId)?.supplier ||
      !find(product.sellerId) ||
      !creditor?.funder ||
      (product.financingModel === 'ZWANGA_DIRECT') !== creditor.operator
    )
      throw new ConflictException(
        'Habilitation du fournisseur, vendeur ou financeur manquante.',
      );
  }

  async enable(actor: CreditActor, id: string, enabled: boolean) {
    return this.store.db.transaction(async (m) => {
      await this.store.authorize(m, actor, []);
      const [product] = await m.query<ProductRow[]>(
        'SELECT * FROM pro_credit_products WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!product) throw new NotFoundException('Produit introuvable.');
      if (enabled) await this.gate(m, { ...product, enabled });
      await m.query(
        'UPDATE pro_credit_products SET enabled=$2,"updatedAt"=now() WHERE id=$1',
        [id, enabled],
      );
      await this.store.audit(m, actor.userId, 'product_enabled', {
        id,
        enabled,
      });
      return { id, enabled };
    });
  }

  async list(page: CreditPageDto, actor?: CreditActor) {
    if (actor)
      await this.store.authorize(this.store.db.manager, actor, [
        'manager',
        'analyst',
        'stock',
        'documents',
        'accountant',
        'collector',
        'auditor',
      ]);
    const rows = await this.store.db.query<ProductRow[]>(
      `SELECT p.id,p.code,p.kind,p.name,p.description,p.enabled,p.currency,p."priceMinor",p."feeMinor",p.details,
      p."financingModel",p."supplierId",p."sellerId",p."creditorId",s."legalName" AS "supplierName",c."legalName" AS "creditorName",
      policy.version AS "policyVersion",policy.rules,
      (SELECT count(*)::integer FROM pro_credit_stock st WHERE st."productId"=p.id AND st.status='available') AS "availableStock"
      FROM pro_credit_products p JOIN pro_credit_policies policy ON policy.id=p."policyId"
      JOIN partner_organizations s ON s.id=p."supplierId" JOIN partner_organizations c ON c.id=p."creditorId"
      WHERE ($1::uuid IS NULL OR p.id>$1) ${actor ? '' : 'AND p.enabled'} ORDER BY p.id LIMIT $2`,
      [page.after ?? null, page.limit + 1],
    );
    return {
      items: rows.slice(0, page.limit),
      nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    };
  }

  async configuration(actor: CreditActor) {
    await this.store.authorize(this.store.db.manager, actor, [
      'manager',
      'analyst',
      'stock',
      'documents',
      'accountant',
      'collector',
      'auditor',
    ]);
    const parties = await this.store.db.query<
      {
        organizationId: string;
        legalName: string;
        supplier: boolean;
        funder: boolean;
        operator: boolean;
        enabled: boolean;
      }[]
    >(`SELECT p."organizationId",o."legalName",p.supplier,p.funder,p.operator,p.enabled
      FROM pro_credit_parties p JOIN partner_organizations o ON o.id=p."organizationId" ORDER BY p."organizationId" LIMIT 100`);
    const policies = await this.store.db.query<PolicyRow[]>(
      'SELECT id,version,terms,rules FROM pro_credit_policies ORDER BY "createdAt" DESC LIMIT 100',
    );
    return { parties, policies, configurationLimit: 100 };
  }
}
