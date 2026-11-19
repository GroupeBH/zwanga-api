import { Injectable } from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import type { CreditActor } from '../shared/credit.store';
import { CreateCreditPolicyDto } from './credit-policies.dto';
import { minor } from '../shared/money';
import type { IdRow } from '../shared/credit.rows';

@Injectable()
export class CreditPoliciesService {
  constructor(private readonly store: CreditStore) {}

  async policy(actor: CreditActor, dto: CreateCreditPolicyDto) {
    for (const key of [
      'minRevenueMinor',
      'maxPrincipalMinor',
      'newcomerLimitMinor',
      'fixedPerTripMinor',
    ] as const)
      minor(dto.rules[key]);
    return this.store.db.transaction(async (m) => {
      await this.store.authorize(m, actor, []);
      const [row] = await m.query<IdRow[]>(
        `INSERT INTO pro_credit_policies(version,terms,"legalReference",rules,"createdBy") VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [
          dto.version.trim(),
          dto.terms.trim(),
          dto.legalReference.trim(),
          JSON.stringify(dto.rules),
          actor.userId,
        ],
      );
      await this.store.audit(m, actor.userId, 'policy_created', {
        id: row.id,
        version: dto.version,
      });
      return row;
    });
  }
}
