import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreditStore, CreditActor } from '../shared/credit.store';
import { CreditCatalogService } from '../catalogue/credit-catalogue.service';
import { CreditPageDto } from '../shared/credit.dto';
import { ProductRow, PolicyRow } from '../shared/credit.rows';
import {
  CommerceCategoryDto,
  CommerceProductDto,
  PurchaseQuoteDto,
} from './commerce.dto';
import {
  commercePrices,
  publicCommerce,
  purchaseQuote,
} from './commerce.policy';

@Injectable()
export class CommerceCatalogueService {
  constructor(
    private readonly store: CreditStore,
    private readonly catalog: CreditCatalogService,
  ) {}

  async categories(admin?: CreditActor) {
    if (admin)
      await this.store.authorize(this.store.db.manager, admin, [
        'manager',
        'analyst',
      ]);
    const items = await this.store.db.query(
      `SELECT id,code,name,kind,enabled FROM pro_commerce_categories ${admin ? '' : 'WHERE enabled'} ORDER BY code`,
    );
    return { items };
  }

  async category(actor: CreditActor, dto: CommerceCategoryDto) {
    return this.store.mutation(
      actor.userId,
      dto.mutationId,
      'commerce_category',
      dto,
      async (m) => {
        await this.store.authorize(m, actor, ['manager']);
        const [row] = await m.query(
          `INSERT INTO pro_commerce_categories(code,name,kind,enabled) VALUES($1,$2,$3,$4)
        ON CONFLICT(code) DO UPDATE SET name=excluded.name,enabled=excluded.enabled
        WHERE pro_commerce_categories.kind=excluded.kind RETURNING id`,
          [dto.code, dto.name.trim(), dto.kind, dto.enabled],
        );
        if (!row)
          throw new ConflictException(
            'La nature de la catégorie ne peut pas changer.',
          );
        await this.store.audit(m, actor.userId, 'commerce_category_saved', {
          id: row.id,
        });
        return row;
      },
    );
  }

  async configure(actor: CreditActor, id: string, dto: CommerceProductDto) {
    const prices = commercePrices(dto.commerce);
    return this.store.mutation(
      actor.userId,
      dto.mutationId,
      'commerce_configure',
      { id, ...dto },
      async (m) => {
        await this.store.authorize(m, actor, ['manager']);
        const [p] = await m.query<ProductRow[]>(
          'SELECT * FROM pro_credit_products WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (!p) throw new NotFoundException('Produit introuvable.');
        if (p.revision !== dto.revision)
          throw new ConflictException(
            'Le produit a changé. Actualisez avant de modifier.',
          );
        if (dto.metadata) {
          const { name, description, ...details } = dto.metadata;
          await m.query(
            'UPDATE pro_credit_products SET name=$2,description=$3,details=details || $4::jsonb WHERE id=$1',
            [id, name.trim(), description.trim(), JSON.stringify(details)],
          );
        }
        const [category] = await m.query<{ kind: string }[]>(
          'SELECT kind FROM pro_commerce_categories WHERE id=$1 AND enabled FOR SHARE',
          [dto.categoryId],
        );
        const allowed =
          p.kind === 'equipment' ? ['equipment', 'accessories'] : [p.kind];
        if (!category || !allowed.includes(category.kind))
          throw new ConflictException(
            'Catégorie incompatible avec ce produit.',
          );
        const [policy] = await m.query<PolicyRow[]>(
          'SELECT * FROM pro_credit_policies WHERE id=$1',
          [p.policyId],
        );
        if (
          dto.commerce.plans.some(
            (plan) => plan.count > policy.rules.maxInstallments,
          ) ||
          BigInt(prices.depositMinor) * 10000n <
            BigInt(prices.creditTotalMinor) * BigInt(policy.rules.minDepositBps)
        )
          throw new ConflictException(
            'Les formules ou l’acompte ne respectent pas la politique de financement.',
          );
        await m.query(
          `UPDATE pro_credit_products SET commerce=$2,"categoryId"=$3,"priceMinor"=$4,"feeMinor"=0,
        enabled=false,revision=revision+1,"updatedAt"=now() WHERE id=$1`,
          [
            id,
            JSON.stringify(dto.commerce),
            dto.categoryId,
            prices.creditTotalMinor,
          ],
        );
        await this.store.audit(m, actor.userId, 'commerce_product_configured', {
          id,
          revision: dto.revision + 1,
        });
        return { id, revision: dto.revision + 1, enabled: false, ...prices };
      },
    );
  }

  async product(id: string) {
    const [p] = await this.store.db.query<ProductRow[]>(
      'SELECT p.* FROM pro_credit_products p JOIN pro_commerce_categories c ON c.id=p."categoryId" WHERE p.id=$1 AND p.enabled AND c.enabled AND p.commerce IS NOT NULL',
      [id],
    );
    if (!p?.commerce) throw new NotFoundException('Produit indisponible.');
    // Public projection is an allowlist: no acquisition cost, margin, internal IDs or risk limits.
    const [policy] = await this.store.db.query<PolicyRow[]>(
      'SELECT * FROM pro_credit_policies WHERE id=$1',
      [p.policyId],
    );
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      categoryId: p.categoryId,
      revision: p.revision,
      currency: p.currency,
      details: p.details,
      prices: publicCommerce(p.commerce),
      terms: policy.terms,
      repayment: {
        netIncomeBps: policy.rules.netIncomeBps,
        fixedPerTripMinor: policy.rules.fixedPerTripMinor,
        commissionShareBps: policy.rules.commissionShareBps,
      },
      delivery:
        'Après validation du dossier et paiement confirmé de l’acompte ou de la première échéance. Sous réserve de stock.',
    };
  }

  async list(page: CreditPageDto, categoryId?: string) {
    const rows = await this.store.db.query<ProductRow[]>(
      `SELECT p.id,p.name,p.description,p.kind,p."categoryId",p.revision,p.currency,p.details,p.commerce
       FROM pro_credit_products p JOIN pro_commerce_categories c ON c.id=p."categoryId"
       WHERE p.enabled AND c.enabled AND p.commerce IS NOT NULL AND ($1::uuid IS NULL OR p.id>$1)
       AND ($3::uuid IS NULL OR p."categoryId"=$3) ORDER BY p.id LIMIT $2`,
      [page.after ?? null, page.limit + 1, categoryId ?? null],
    );
    return {
      items: rows.slice(0, page.limit).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        kind: p.kind,
        categoryId: p.categoryId,
        revision: p.revision,
        currency: p.currency,
        details: p.details,
        prices: publicCommerce(p.commerce!),
      })),
      nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    };
  }

  async quote(id: string, dto: PurchaseQuoteDto) {
    await this.product(id);
    const [p] = await this.store.db.query<ProductRow[]>(
      'SELECT * FROM pro_credit_products WHERE id=$1',
      [id],
    );
    await this.catalog.gate(this.store.db.manager, p);
    return purchaseQuote(
      { id: p.id, commerce: p.commerce!, revision: p.revision! },
      dto.mode,
      dto.planId,
    );
  }
}
