import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  ActivateAssetCreditDto,
  AssetConsentDto,
  OfferAssetCreditDto,
  RepayAssetCreditDto,
} from './asset-credit.dto';
import { TOKEN_VALUE_CDF } from '../wallet/token-value.policy';
import { ASSET_PRODUCTS, isAssetIntakeOpen, type AssetKind } from './asset-credit-products';
import { creditSchedule, validateCreditCost } from './credit-cost';
import { assertVehicleCreditEligible, vehicleCreditEligibility } from './vehicle-credit-eligibility';
import { repaymentPlanPreviews, selectRepaymentPlan, validateRepaymentPlans } from './repayment-plans';
import { isDeepStrictEqual } from 'node:util';

export const ASSET_TERMS_VERSION = 'asset-credit-v2';
export const ASSET_POLICY_TEXT =
  'Chaque offre précise son pourcentage de remboursement. Les pourcentages acceptés s’additionnent aux 5 % de commission Zwanga, sans dépasser le revenu disponible. Pour un trajet cash, le remboursement vient du solde rechargé ; le reliquat reste dû. Vous pouvez aussi choisir un remboursement depuis votre solde. Les anciens contrats conservent leur part commune de 5 %.';
const LEGACY_POLICY_TEXT = 'Vos anciens crédits partagent 5 % du revenu du trajet, en plus des 5 % de commission Zwanga. Les nouveaux crédits éventuellement acceptés s’ajoutent avec leurs propres pourcentages. Pour un trajet cash, le remboursement vient du solde rechargé ; le reliquat reste dû.';

@Injectable()
export class AssetCreditService {
  constructor(private readonly db: DataSource) {}
  private async repaymentTotal(m: EntityManager | DataSource, driverId: string, offeredId?: string) {
    const [row] = await m.query(`SELECT COALESCE(SUM(CASE WHEN "policyVersion"='asset-credit-v2' THEN "repaymentBps" ELSE 0 END),0)
      + CASE WHEN COUNT(*) FILTER (WHERE "policyVersion"='asset-credit-v1')>0 THEN 500 ELSE 0 END AS total
      FROM asset_credits WHERE "driverId"=$1 AND (status IN ('accepted','active') OR (id=$2 AND status='offered'))`, [driverId, offeredId ?? null]);
    return Number(row.total);
  }
  async products(driverId: string) {
    const rows = await this.db.query('SELECT kind,enabled FROM asset_credit_products');
    const [driver] = await this.db.query(
      'SELECT id FROM users WHERE id=$1 AND "isDriver"=true AND "isActive"=true', [driverId],
    );
    const vehicle = driver ? await vehicleCreditEligibility(this.db, driverId) : { eligible: false };
    return {
      items: ASSET_PRODUCTS.map((product) => ({ ...product,
        enabled: isAssetIntakeOpen(product.kind) && rows.some((row) => row.kind === product.kind && row.enabled === true)
          && (product.kind !== 'vehicle' || vehicle.eligible),
        comingSoon: !isAssetIntakeOpen(product.kind),
        ...(product.kind === 'vehicle' ? { eligibility: vehicle } : {}),
      })),
      canRequest: Boolean(driver), policyText: ASSET_POLICY_TEXT,
    };
  }
  async requests(driverId?: string) {
    return {
      items: await this.db.query(
        `SELECT id,"driverId","assetKind",notes,status,"createdAt" FROM asset_credit_requests WHERE to_jsonb(asset_credit_requests)->>'proProductId' IS NULL ${driverId ? 'AND "driverId"=$1' : ''} ORDER BY "createdAt" DESC,id DESC LIMIT 100`,
        driverId ? [driverId] : [],
      ),
    };
  }
  async request(driverId: string, notes: string, assetKind: AssetKind = 'phone') {
    if (!isAssetIntakeOpen(assetKind)) throw new ConflictException('Cet équipement sera disponible prochainement.');
    if (!ASSET_PRODUCTS.some((product) => product.kind === assetKind))
      throw new BadRequestException('Matériel inconnu.');
    return this.db.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `asset-request:${driverId}`,
      ]);
      const [driver] = await m.query(
        'SELECT id FROM users WHERE id=$1 AND "isDriver"=true AND "isActive"=true',
        [driverId],
      );
      if (!driver)
        throw new ConflictException(
          'Ce service est réservé aux conducteurs actifs.',
        );
      const [product] = await m.query(
        'SELECT enabled FROM asset_credit_products WHERE kind=$1 FOR SHARE', [assetKind],
      );
      if (!product?.enabled)
        throw new ConflictException('Ce service est en pause.');
      if (assetKind === 'vehicle') await assertVehicleCreditEligible(m, driverId);
      const [existing] = await m.query(
        `SELECT id,to_jsonb(asset_credit_requests)->>'proProductId' AS "proProductId" FROM asset_credit_requests WHERE "driverId"=$1 AND "assetKind"=$2 AND status='submitted'`,
        [driverId, assetKind],
      );
      if (existing?.proProductId) throw new ConflictException('Une demande Zwanga Pro est déjà en cours. Consultez ce dossier.');
      if (existing) return existing;
      return (
        await m.query(
          `INSERT INTO asset_credit_requests("driverId","assetKind",notes) VALUES($1,$2,$3) RETURNING id`,
          [driverId, assetKind, notes.trim()],
        )
      )[0];
    });
  }
  async comment(id: string, driverId: string, notes: string) {
    const [updated] = await this.db.query(`WITH updated AS (UPDATE asset_credit_requests SET notes=$3
      WHERE id=$1 AND "driverId"=$2 AND status='submitted' AND to_jsonb(asset_credit_requests)->>'proProductId' IS NULL RETURNING id,notes) SELECT * FROM updated`, [id, driverId, notes.trim()]);
    if (!updated) throw new ConflictException('Ce dossier ne peut plus être modifié. Consultez votre offre.');
    return updated;
  }
  async list(driverId?: string) {
    const rows = await this.db.query(
      `SELECT id,"driverId","assetKind",label,"principalMinor","paidMinor","dueMinor",status,terms,"policyVersion","repaymentBps","acceptedAt","activatedAt","createdAt",
        "cashPriceMinor","creditFeeMinor","installmentCount","installmentPeriod","costDisclosureVersion"
      FROM asset_credits WHERE "policyVersion"<>'zwanga-pro-v1' ${driverId ? 'AND "driverId" = $1' : ''} ORDER BY "createdAt" DESC, id DESC LIMIT 100`,
      driverId ? [driverId] : [],
    );
    return {
      // The mobile dashboard must compare every active contract, not fetch one
      // arbitrarily selected credit and hide an older overdue installment.
      items: rows.map((credit) => {
        const { installments, minimumDueMinor } = creditSchedule(credit);
        return { ...credit, minimumDueMinor,
          nextInstallment: installments.find(row => row.remainingMinor > 0 && row.dueAt) ?? null };
      }),
      commissionBps: 500,
      ...(driverId ? { totalRepaymentBps: await this.repaymentTotal(this.db, driverId) } : {}),
      policyText: ASSET_POLICY_TEXT,
      policyVersion: ASSET_TERMS_VERSION,
      currency: 'CDF',
    };
  }
  async detail(id: string, driverId?: string) {
    const [credit] = await this.db.query(
      `SELECT * FROM asset_credits WHERE id=$1 ${driverId ? 'AND "driverId"=$2' : ''}`,
      driverId ? [id, driverId] : [id],
    );
    if (!credit) throw new NotFoundException('Crédit introuvable.');
    if (credit.policyVersion === 'zwanga-pro-v1') throw new ConflictException('Consultez ce contrat dans Zwanga Pro.');
    const entries = await this.db.query(
      'SELECT id,kind,"amountMinor","dueDeltaMinor","createdAt","bookingId" FROM asset_credit_entries WHERE "creditId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 100',
      [id],
    );
    if (driverId) {
      delete credit.validationReference;
      delete credit.createdBy;
      delete credit.requestPayload;
      delete credit.mutationId;
    }
    return {
      ...credit,
      ...creditSchedule(credit),
      repaymentPlanPreviews: repaymentPlanPreviews(credit),
      entries,
      currency: 'CDF',
      commissionBps: 500,
      totalRepaymentBps: await this.repaymentTotal(this.db, credit.driverId, credit.id),
      policyText: credit.policyVersion === 'asset-credit-v1' ? LEGACY_POLICY_TEXT : ASSET_POLICY_TEXT,
    };
  }
  async offer(actorId: string, dto: OfferAssetCreditDto) {
    if (!isAssetIntakeOpen(dto.assetKind)) throw new ConflictException('Cet équipement sera disponible prochainement.');
    const plans = validateRepaymentPlans(dto.repaymentPlans, dto);
    const costVersion = validateCreditCost(dto.principalMinor, {
      cashPriceMinor: dto.cashPriceMinor, creditFeeMinor: dto.creditFeeMinor,
      installmentCount: dto.installmentCount, installmentPeriod: dto.installmentPeriod,
    });
    if (!Number.isInteger(dto.repaymentBps) || dto.repaymentBps < 1 || dto.repaymentBps > 9500)
      throw new BadRequestException('Indiquez un pourcentage de remboursement entre 0,01 % et 95 %.');
    if (
      dto.label.trim().length < 3 ||
      dto.terms.trim().length < 50 ||
      dto.validationReference.trim().length < 3
    )
      throw new BadRequestException(
        'Complétez le matériel, les conditions et la validation du contrat.',
      );
    if (dto.principalMinor % TOKEN_VALUE_CDF)
      throw new BadRequestException(
        'Montant incompatible avec la précision du portefeuille.',
      );
    return this.db.transaction(async (m) => {
      // Serialization makes repeated submissions deterministic, even with a different payload.
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `asset-offer:${dto.mutationId}`,
      ]);
      const payload = JSON.stringify(dto);
      const [prior] = await m.query(
        'SELECT id,"requestPayload" FROM asset_credits WHERE "mutationId"=$1',
        [dto.mutationId],
      );
      if (prior) {
        if (!isDeepStrictEqual(prior.requestPayload, JSON.parse(payload))) {
          throw new ConflictException(
            'Cette opération existe avec un autre contenu.',
          );
        }
        return { id: prior.id };
      }
      const [product] = await m.query(
        'SELECT enabled FROM asset_credit_products WHERE kind=$1 FOR SHARE',
        [dto.assetKind],
      );
      if (!product?.enabled)
        throw new ConflictException('Ce financement n’est pas encore ouvert.');
      const [driver] = await m.query(
        'SELECT id FROM users WHERE id=$1 AND "isDriver"=true AND "isActive"=true',
        [dto.driverId],
      );
      if (!driver)
        throw new BadRequestException('Conducteur actif introuvable.');
      if (dto.assetKind === 'vehicle') await assertVehicleCreditEligible(m, dto.driverId);
      const [credit] = await m.query(
        `INSERT INTO asset_credits ("driverId","assetKind",label,"principalMinor",terms,"validationReference","createdBy","mutationId","requestPayload","repaymentBps","policyVersion",
          "cashPriceMinor","creditFeeMinor","installmentCount","installmentPeriod","costDisclosureVersion","repaymentPlans")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          dto.driverId,
          dto.assetKind,
          dto.label.trim(),
          dto.principalMinor,
          dto.terms.trim(),
          dto.validationReference.trim(),
          actorId,
          dto.mutationId,
          payload,
          dto.repaymentBps,
          ASSET_TERMS_VERSION,
          dto.cashPriceMinor ?? null, dto.creditFeeMinor ?? null,
          dto.installmentCount ?? null, dto.installmentPeriod ?? null, costVersion,
          JSON.stringify(plans),
        ],
      );
      await m.query(
        `INSERT INTO asset_credit_events ("creditId","actorId",action) VALUES ($1,$2,'offered')`,
        [credit.id, actorId],
      );
      await m.query(
        `UPDATE asset_credit_requests SET status='offered' WHERE "driverId"=$1 AND "assetKind"=$2 AND status='submitted'
          AND to_jsonb(asset_credit_requests)->>'proProductId' IS NULL`,
        [dto.driverId, dto.assetKind],
      );
      return credit;
    });
  }
  async decide(id: string, driverId: string, accept: boolean, consent?: AssetConsentDto) {
    return this.db.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`asset-driver:${driverId}`]);
      const [credit] = await m.query(
        'SELECT * FROM asset_credits WHERE id=$1 AND "driverId"=$2 FOR UPDATE',
        [id, driverId],
      );
      if (!credit) throw new NotFoundException('Crédit introuvable.');
      if (credit.policyVersion === 'zwanga-pro-v1') throw new ConflictException('Utilisez le parcours contractuel Zwanga Pro.');
      const plan = accept ? selectRepaymentPlan(credit, consent?.selectedPlanId) : null;
      if (accept && credit.costDisclosureVersion && consent?.costDisclosureVersion !== credit.costDisclosureVersion)
        throw new ConflictException('Mettez à jour l’application pour consulter et accepter le prix, les frais et les échéances de cette offre.');
      if (accept && ((consent && consent.policyVersion !== credit.policyVersion)
        || (credit.policyVersion === 'asset-credit-v2' && (!consent || consent.consent !== true))))
        throw new ConflictException('Actualisez le contrat et confirmez les conditions affichées.');
      if (credit.status === (accept ? 'accepted' : 'declined')) return { id };
      if (credit.status !== 'offered')
        throw new ConflictException('Ce contrat a déjà changé.');
      if (accept) {
        if (credit.assetKind === 'vehicle') await assertVehicleCreditEligible(m, driverId);
        const total = await this.repaymentTotal(m, driverId, id);
        if (total > 9500) throw new ConflictException('Le total des remboursements et de la commission dépasse 100 % du revenu.');
        if (credit.policyVersion === 'asset-credit-v2' && consent?.expectedTotalRepaymentBps !== total)
          throw new ConflictException('Vos crédits ont changé. Actualisez pour vérifier le nouveau total avant de confirmer.');
        const [identity] = await m.query(
          'SELECT status FROM kyc_documents WHERE "userId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
          [driverId],
        );
        if (identity?.status !== 'approved')
          throw new ConflictException(
            'Vérifiez votre identité avant d’accepter ce contrat.',
          );
      }
      await m.query(
        `UPDATE asset_credits SET status=$2,"acceptedAt"=CASE WHEN $2='accepted' THEN now() ELSE NULL END,
          "selectedPlanId"=COALESCE($3,"selectedPlanId"),"installmentCount"=COALESCE($4,"installmentCount") WHERE id=$1`,
        [id, accept ? 'accepted' : 'declined', plan?.id ?? null, plan?.months ?? null],
      );
      await m.query(
        'INSERT INTO asset_credit_events ("creditId","actorId",action) VALUES ($1,$2,$3)',
        [id, driverId, accept ? 'accepted' : 'declined'],
      );
      return { id };
    });
  }
  async activate(id: string, actorId: string, dto: ActivateAssetCreditDto) {
    if (
      dto.assetReference.trim().length < 3 ||
      dto.deliveryReference.trim().length < 3
    )
      throw new BadRequestException('Les références de remise sont requises.');
    return this.db.transaction(async (m) => {
      const [owner] = await m.query('SELECT "driverId" FROM asset_credits WHERE id=$1', [id]);
      if (!owner) throw new NotFoundException('Crédit introuvable.');
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`asset-driver:${owner.driverId}`]);
      const [credit] = await m.query(
        'SELECT * FROM asset_credits WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!credit) throw new NotFoundException('Crédit introuvable.');
      if (credit.policyVersion === 'zwanga-pro-v1') throw new ConflictException('Utilisez la remise Zwanga Pro.');
      if (
        ['active', 'settled'].includes(credit.status) &&
        credit.deliveryReference === dto.deliveryReference.trim() &&
        credit.assetReference === dto.assetReference.trim()
      )
        return { id };
      if (credit.status !== 'accepted')
        throw new ConflictException(
          'Le conducteur doit accepter le contrat avant la remise.',
        );
      if (await this.repaymentTotal(m, credit.driverId) > 9500)
        throw new ConflictException('Le cumul des crédits doit être régularisé avant la remise.');
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `asset-serial:${credit.assetKind}:${dto.assetReference.trim().toUpperCase()}`,
      ]);
      // A settled credit can reopen after an earning reversal: never silently refinance its asset.
      const [assigned] = await m.query(
        `SELECT id FROM asset_credits WHERE "assetKind"=$1 AND upper("assetReference")=$2`,
        [credit.assetKind, dto.assetReference.trim().toUpperCase()],
      );
      if (assigned)
        throw new ConflictException(
          'Ce matériel est déjà lié à un contrat. Un nouveau financement nécessite un contrôle distinct.',
        );
      const [driver] = await m.query(
        'SELECT id FROM users WHERE id=$1 AND "isDriver"=true AND "isActive"=true',
        [credit.driverId],
      );
      const [identity] = await m.query(
        'SELECT status FROM kyc_documents WHERE "userId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
        [credit.driverId],
      );
      if (!driver || identity?.status !== 'approved')
        throw new ConflictException(
          'Conducteur actif et identité vérifiée requis avant la remise.',
        );
      await m.query(
        `UPDATE asset_credits SET status='active',"activatedAt"=clock_timestamp(),"deliveryReference"=$2,"assetReference"=$3 WHERE id=$1`,
        [id, dto.deliveryReference.trim(), dto.assetReference.trim()],
      );
      await m.query(
        `INSERT INTO asset_credit_events ("creditId","actorId",action) VALUES ($1,$2,'delivered')`,
        [id, actorId],
      );
      return { id };
    });
  }
  async repay(id: string, driverId: string, dto: RepayAssetCreditDto) {
    if (dto.amountMinor % TOKEN_VALUE_CDF)
      throw new BadRequestException(
        'Montant incompatible avec la précision du portefeuille.',
      );
    try {
      return await this.db.transaction(async (m) => {
        const [contract] = await m.query('SELECT "policyVersion" FROM asset_credits WHERE id=$1 AND "driverId"=$2', [id, driverId]);
        if (contract?.policyVersion === 'zwanga-pro-v1') throw new ConflictException('Utilisez le remboursement Zwanga Pro.');
        const [result] = await m.query(
          'SELECT zwanga_asset_wallet_repay($1,$2,$3,$4) AS result',
          [id, driverId, dto.amountMinor, dto.mutationId],
        );
        return result.result;
      });
    } catch (error) {
      if (/ASSET_(BALANCE|STATE|OWNER|REPLAY)/.test(error?.message ?? ''))
        throw new ConflictException(
          'Remboursement impossible : vérifiez le solde disponible et le montant restant, puis actualisez.',
        );
      throw error;
    }
  }
}
