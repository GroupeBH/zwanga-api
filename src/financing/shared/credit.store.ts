import {
  Injectable,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { IdRow, ContractRow } from './credit.rows';
import { isDeepStrictEqual } from 'node:util';

export interface CreditActor {
  userId: string;
  role: string;
  passwordChangeRequired?: boolean;
}

@Injectable()
export class CreditStore {
  constructor(readonly db: DataSource) {}
  async authorize(
    m: EntityManager,
    actor: CreditActor,
    roles: string[],
    organizationId?: string,
  ) {
    // Recheck persisted identity; neither UI claims nor client-provided organization is authority.
    const [user] = await m.query<
      { role: string; isActive: boolean; status: string }[]
    >('SELECT role,"isActive",status FROM users WHERE id=$1', [actor.userId]);
    if (
      !user?.isActive ||
      ['inactive', 'suspended'].includes(user.status) ||
      actor.passwordChangeRequired
    )
      throw new ForbiddenException('Accès Zwanga Pro refusé.');
    if (user.role === 'super_admin') return;
    const [grant] = await m.query<IdRow[]>(
      `SELECT g.id FROM pro_credit_grants g WHERE g."userId"=$1 AND g.enabled
      AND g.role=ANY($2::text[]) AND (g."organizationId" IS NULL OR (g."organizationId"=$3
        AND EXISTS(SELECT 1 FROM partner_members pm JOIN partner_organizations po ON po.id=pm."organizationId"
          WHERE pm."userId"=$1 AND pm."organizationId"=$3 AND pm.status='ACTIVE' AND po.status='ACTIVE'))) LIMIT 1`,
      [actor.userId, roles, organizationId ?? null],
    );
    if (!grant)
      throw new ForbiddenException('Habilitation Zwanga Pro requise.');
  }
  async audit(
    m: EntityManager,
    actorId: string | null,
    action: string,
    detail: unknown,
    creditId?: string,
  ) {
    await m.query(
      'INSERT INTO pro_credit_audit("actorId","creditId",action,detail) VALUES($1,$2,$3,$4)',
      [actorId, creditId ?? null, action, JSON.stringify(detail)],
    );
  }
  async notify(
    m: EntityManager,
    userId: string,
    creditId: string,
    key: string,
  ) {
    // Reuse the existing notifications outbox and worker, never call a push provider in a transaction.
    await m.query(
      `INSERT INTO notifications("userId","eventKey",title,body,data,"fcmToken","isAutomatic",status,"errorMessage")
      VALUES($1,$2,'Zwanga Pro',$3,$4,'',false,'pending',NULL) ON CONFLICT("eventKey") DO NOTHING`,
      [
        userId,
        `pro:${key}`,
        'Votre dossier a été mis à jour. Consultez les détails dans l’application.',
        JSON.stringify({ type: 'zwanga_pro_updated', creditId }),
      ],
    );
  }
  async mutation<T>(
    actorId: string,
    id: string,
    action: string,
    payload: unknown,
    run: (m: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (m) => {
      await m.query("SET LOCAL lock_timeout='5s'");
      await m.query("SET LOCAL statement_timeout='15s'");
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `pro-mutation:${id}`,
      ]);
      const [prior] = await m.query<
        { actorId: string; action: string; payload: unknown; result: T }[]
      >('SELECT * FROM pro_credit_mutations WHERE id=$1', [id]);
      if (prior) {
        if (
          prior.actorId !== actorId ||
          prior.action !== action ||
          !isDeepStrictEqual(prior.payload, JSON.parse(JSON.stringify(payload)))
        )
          throw new ConflictException(
            'Clé d’idempotence déjà utilisée avec un autre contenu.',
          );
        return prior.result;
      }
      const result = await run(m);
      await m.query(
        'INSERT INTO pro_credit_mutations(id,"actorId",action,payload,result) VALUES($1,$2,$3,$4,$5)',
        [id, actorId, action, JSON.stringify(payload), JSON.stringify(result)],
      );
      return result;
    });
  }
  async contract(
    m: EntityManager,
    id: string,
    driverId?: string,
    lock = false,
  ) {
    const [row] = await m.query<ContractRow[]>(
      `SELECT c.*,p.* FROM asset_credits c JOIN pro_credit_contracts p ON p."creditId"=c.id
      WHERE c.id=$1 ${driverId ? 'AND c."driverId"=$2' : ''} ${lock ? 'FOR UPDATE OF c,p' : ''}`,
      driverId ? [id, driverId] : [id],
    );
    if (!row) throw new NotFoundException('Financement introuvable.');
    return row;
  }
  async driverLock(m: EntityManager, driverId: string) {
    // Same first lock as payouts. Wallet debit callers acquire wallet next, then asset-driver.
    await m.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [driverId]);
  }
  async creditLock(m: EntityManager, driverId: string) {
    await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `asset-driver:${driverId}`,
    ]);
  }
}
