import { Injectable } from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { EntityManager } from 'typeorm';
import type { ContractRow, IdRow, ReceiptRow } from '../shared/credit.rows';
import type { CreditActor } from '../shared/credit.store';
import { CreditPageDto } from '../shared/credit.dto';

@Injectable()
export class CreditLedgerService {
  constructor(private readonly store: CreditStore) {}

  async journal(
    m: EntityManager,
    c: Pick<ContractRow, 'id' | 'creditorId'>,
    source: string,
    debit: string,
    credit: string,
    amount: bigint,
    detail: unknown,
  ) {
    const [row] = await m.query<IdRow[]>(
      `INSERT INTO pro_credit_journals("creditId","creditorId",currency,"sourceKey","debitAccount","creditAccount","amountMinor",detail)
      VALUES($1,$2,'CDF',$3,$4,$5,$6,$7) RETURNING id`,
      [
        c.id,
        c.creditorId,
        source,
        debit,
        credit,
        amount.toString(),
        JSON.stringify(detail),
      ],
    );
    return row.id;
  }

  async history(
    actor: CreditActor,
    id: string,
    page: CreditPageDto,
    admin = false,
  ) {
    const c = await this.store.contract(
      this.store.db.manager,
      id,
      admin ? undefined : actor.userId,
    );
    if (admin)
      await this.store.authorize(
        this.store.db.manager,
        actor,
        ['accountant', 'auditor', 'collector', 'funder'],
        c.creditorId,
      );
    const rows = await this.store.db.query<ReceiptRow[]>(
      `SELECT id,"amountMinor",currency,"createdAt","reversesId",detail->>'purpose' AS purpose,
      CASE WHEN "reversesId" IS NOT NULL THEN 'REVERSED' ELSE 'CONFIRMED' END AS status FROM pro_credit_journals
      WHERE "creditId"=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,
      [id, page.after ?? null, page.limit + 1],
    );
    return {
      items: rows.slice(0, page.limit),
      nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    };
  }
}
