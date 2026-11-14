import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ActivateAssetCreditDto,
  OfferAssetCreditDto,
  RepayAssetCreditDto,
} from './asset-credit.dto';
import { TOKEN_VALUE_CDF } from '../wallet/token-value.policy';

export const ASSET_TERMS_VERSION = 'asset-credit-v1';
export const ASSET_POLICY_TEXT =
  '5 % du revenu du trajet remboursent votre matériel, en plus des 5 % de commission Zwanga. Pour un trajet cash, le remboursement est prélevé sur votre solde rechargé ; un montant non prélevé reste dû. Vous pouvez aussi rembourser librement avec votre solde. Les remboursements cessent au solde du crédit ; la commission reste à 5 %.';

@Injectable()
export class AssetCreditService {
  constructor(private readonly db: DataSource) {}
  async requests(driverId?: string) {
    return {
      items: await this.db.query(
        `SELECT id,"driverId","assetKind",notes,status,"createdAt" FROM asset_credit_requests ${driverId ? 'WHERE "driverId"=$1' : ''} ORDER BY "createdAt" DESC,id DESC LIMIT 100`,
        driverId ? [driverId] : [],
      ),
    };
  }
  async request(driverId: string, notes: string) {
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
        "SELECT enabled FROM asset_credit_products WHERE kind='phone' FOR SHARE",
      );
      if (!product?.enabled)
        throw new ConflictException('Ce service est en pause.');
      const [existing] = await m.query(
        `SELECT id FROM asset_credit_requests WHERE "driverId"=$1 AND "assetKind"='phone' AND status='submitted'`,
        [driverId],
      );
      if (existing) return existing;
      return (
        await m.query(
          `INSERT INTO asset_credit_requests("driverId","assetKind",notes) VALUES($1,'phone',$2) RETURNING id`,
          [driverId, notes.trim()],
        )
      )[0];
    });
  }
  async list(driverId?: string) {
    const rows = await this.db.query(
      `SELECT id,"driverId","assetKind",label,"principalMinor","paidMinor","dueMinor",status,terms,"policyVersion","acceptedAt","activatedAt","createdAt"
      FROM asset_credits ${driverId ? 'WHERE "driverId" = $1' : ''} ORDER BY "createdAt" DESC, id DESC LIMIT 100`,
      driverId ? [driverId] : [],
    );
    return {
      items: rows,
      commissionBps: 500,
      repaymentBps: 500,
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
      entries,
      currency: 'CDF',
      commissionBps: 500,
      repaymentBps: 500,
      policyText: ASSET_POLICY_TEXT,
    };
  }
  async offer(actorId: string, dto: OfferAssetCreditDto) {
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
        if (
          JSON.stringify(prior.requestPayload) !==
          JSON.stringify(JSON.parse(payload))
        ) {
          const same = Object.keys(dto).every(
            (k) => prior.requestPayload[k] === dto[k],
          );
          if (!same)
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
      const [credit] = await m.query(
        `INSERT INTO asset_credits ("driverId","assetKind",label,"principalMinor",terms,"validationReference","createdBy","mutationId","requestPayload")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
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
        ],
      );
      await m.query(
        `INSERT INTO asset_credit_events ("creditId","actorId",action) VALUES ($1,$2,'offered')`,
        [credit.id, actorId],
      );
      await m.query(
        `UPDATE asset_credit_requests SET status='offered' WHERE "driverId"=$1 AND "assetKind"=$2 AND status='submitted'`,
        [dto.driverId, dto.assetKind],
      );
      return credit;
    });
  }
  async decide(id: string, driverId: string, accept: boolean) {
    return this.db.transaction(async (m) => {
      const [credit] = await m.query(
        'SELECT * FROM asset_credits WHERE id=$1 AND "driverId"=$2 FOR UPDATE',
        [id, driverId],
      );
      if (!credit) throw new NotFoundException('Crédit introuvable.');
      if (credit.status === (accept ? 'accepted' : 'declined')) return { id };
      if (credit.status !== 'offered')
        throw new ConflictException('Ce contrat a déjà changé.');
      if (accept) {
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
        `UPDATE asset_credits SET status=$2,"acceptedAt"=CASE WHEN $2='accepted' THEN now() ELSE NULL END WHERE id=$1`,
        [id, accept ? 'accepted' : 'declined'],
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
      const [credit] = await m.query(
        'SELECT * FROM asset_credits WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!credit) throw new NotFoundException('Crédit introuvable.');
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
