import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { CREDIT_COST_VERSION } from '../../asset-credit/credit-cost';
import { CreditStore, type CreditActor } from '../shared/credit.store';
import {
  DebtorsPageDto,
  RecoveryActionDto,
  RecoveryPageDto,
} from './credit-collections.dto';
import {
  decodeCollectionCursor,
  encodeCollectionCursor,
} from './collection-cursor';
import { COLLECTION_DEBTORS_SQL } from './collection-balances.sql';

const READ_ROLES = ['collector', 'manager', 'analyst', 'accountant', 'auditor'];
const WRITE_ROLES = ['collector', 'manager'];
const HISTORY_ACTIONS = [
  'recovery_action',
  'reschedule_proposed',
  'reschedule_consented',
  'reschedule_approved',
  'execution_updated',
  'delivered',
  'mandate_revoked',
];
export interface RecoveryHistoryItem {
  id: string;
  action: string;
  createdAt: string;
  actor: {
    id: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
  detail: Record<string, unknown>;
}
export interface CollectionDebtor {
  driverId: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  accountStatus: string;
  daysLate: number;
  lateMinor: string;
  contracts: {
    id: string;
    source: 'team' | 'catalogue';
    label: string;
    kind: string;
    daysLate: number;
    lateMinor: string;
    remainingMinor: string;
    nextDueAt: string | null;
  }[];
  lastAction: {
    kind: string;
    outcome: string;
    createdAt: string;
    promisedAt: string | null;
    promisedAmountMinor: string | null;
  } | null;
}

@Injectable()
export class CreditCollectionsService {
  constructor(private readonly store: CreditStore) {}

  private async credit(m: EntityManager, id: string, lock = false) {
    const [credit] = await m.query<
      {
        id: string;
        driverId: string;
        status: string;
        principalMinor: string;
        paidMinor: string;
      }[]
    >(
      `SELECT id,"driverId",status,"principalMinor","paidMinor" FROM asset_credits WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!credit) throw new NotFoundException('Crédit introuvable.');
    return credit;
  }

  async record(actor: CreditActor, id: string, dto: RecoveryActionDto) {
    // mutation() returns saved results before invoking its callback: recheck
    // current permissions even for retries after grant revocation.
    await this.store.read((m) => this.store.authorize(m, actor, WRITE_ROLES));
    return this.store.mutation(
      actor.userId,
      dto.mutationId,
      'recovery_action',
      { id, ...dto },
      async (m) => {
        await this.store.authorize(m, actor, WRITE_ROLES);
        const c = await this.credit(m, id, true);
        if (c.driverId === actor.userId)
          throw new ConflictException({
            code: 'RECOVERY_SELF_ACTION',
            message:
              'Vous ne pouvez pas enregistrer votre propre recouvrement.',
          });
        if (c.status !== 'active')
          throw new ConflictException({
            code: 'CREDIT_NOT_ACTIVE',
            message: 'Le crédit doit être actif pour enregistrer une action.',
          });
        if (dto.note.trim().length < 3)
          throw new BadRequestException(
            'La note doit contenir au moins trois caractères utiles.',
          );
        const promised = dto.outcome === 'promise_to_pay';
        let promise:
          { promisedAt: string; promisedAmountMinor: string } | undefined;
        if (
          !promised &&
          (dto.promisedAt !== undefined ||
            dto.promisedAmountMinor !== undefined)
        )
          throw new BadRequestException(
            'Les informations de promesse sont réservées au résultat promise_to_pay.',
          );
        if (promised) {
          const now = Date.now(),
            at = Date.parse(dto.promisedAt ?? '');
          if (
            !dto.promisedAt ||
            !/T.+(?:Z|[+-]\d\d:\d\d)$/.test(dto.promisedAt) ||
            !Number.isFinite(at) ||
            at <= now ||
            at > now + 90 * 86400000 ||
            typeof dto.promisedAmountMinor !== 'string' ||
            !/^[0-9]{1,13}$/.test(dto.promisedAmountMinor) ||
            BigInt(dto.promisedAmountMinor) <= 0n ||
            BigInt(dto.promisedAmountMinor) >
              BigInt(c.principalMinor) - BigInt(c.paidMinor)
          ) {
            throw new BadRequestException(
              'Promesse invalide : date future avec fuseau, dans les 90 jours, et montant positif ne dépassant pas le restant dû requis.',
            );
          }
          promise = {
            promisedAt: new Date(at).toISOString(),
            promisedAmountMinor: BigInt(dto.promisedAmountMinor).toString(),
          };
        }
        const receipt = await this.store.audit(
          m,
          actor.userId,
          'recovery_action',
          { kind: dto.kind, outcome: dto.outcome, note: dto.note, ...promise },
          id,
        );
        // "paid" is an agent observation, never a financial settlement.
        return {
          id: receipt.id,
          creditId: id,
          createdAt: receipt.createdAt.toISOString(),
        };
      },
    );
  }

  async history(actor: CreditActor, id: string, page: RecoveryPageDto) {
    const cursor = page.after ? decodeCollectionCursor(page.after) : undefined;
    if (cursor && (cursor.type !== 'history' || cursor.creditId !== id))
      throw new BadRequestException(
        'Ce curseur ne correspond pas au crédit demandé.',
      );
    return this.store.read(async (m) => {
      await this.store.authorize(m, actor, READ_ROLES);
      await this.credit(m, id);
      const rows = await m.query<RecoveryHistoryItem[]>(
        `SELECT a.id,a.action,
        to_char(a."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
        CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('id',u.id,'firstName',u."firstName",'lastName',u."lastName") END AS actor,a.detail
        FROM pro_credit_audit a LEFT JOIN users u ON u.id=a."actorId"
        WHERE a."creditId"=$1 AND a.action=ANY($2::text[])
          AND ($3::timestamptz IS NULL OR (a."createdAt",a.id)<($3::timestamptz,$4::uuid))
        ORDER BY a."createdAt" DESC,a.id DESC LIMIT $5`,
        [
          id,
          HISTORY_ACTIONS,
          cursor?.at ?? null,
          cursor?.id ?? null,
          page.limit + 1,
        ],
      );
      const items = rows.slice(0, page.limit),
        last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > page.limit && last
            ? encodeCollectionCursor({
                v: 1,
                type: 'history',
                creditId: id,
                at: last.createdAt,
                id: last.id,
              })
            : null,
      };
    });
  }

  async debtors(actor: CreditActor, page: DebtorsPageDto) {
    const minDays = page.minDays ?? 0,
      maxDays = page.maxDays ?? 365000;
    if (minDays > maxDays)
      throw new BadRequestException(
        'minDays doit être inférieur ou égal à maxDays.',
      );
    const cursor = page.after ? decodeCollectionCursor(page.after) : undefined;
    if (
      cursor &&
      (cursor.type !== 'debtors' ||
        cursor.minDays !== minDays ||
        cursor.maxDays !== maxDays)
    )
      throw new BadRequestException(
        'Ce curseur ne correspond pas aux filtres demandés.',
      );
    // Freeze the clock across pages, not financial data across separate requests.
    const asOf = cursor?.asOf ?? new Date().toISOString();
    return this.store.read(async (m) => {
      await this.store.authorize(m, actor, [
        'collector',
        'manager',
        'accountant',
        'auditor',
      ]);
      const rows = await m.query<CollectionDebtor[]>(COLLECTION_DEBTORS_SQL, [
        asOf,
        CREDIT_COST_VERSION,
        minDays,
        maxDays,
        cursor?.daysLate ?? null,
        cursor?.lateMinor ?? null,
        cursor?.driverId ?? null,
        page.limit + 1,
      ]);
      const items = rows.slice(0, page.limit),
        last = items.at(-1);
      return {
        asOf,
        items,
        nextCursor:
          rows.length > page.limit && last
            ? encodeCollectionCursor({
                v: 1,
                type: 'debtors',
                asOf,
                minDays,
                maxDays,
                daysLate: last.daysLate,
                lateMinor: last.lateMinor,
                driverId: last.driverId,
              })
            : null,
      };
    });
  }
}
