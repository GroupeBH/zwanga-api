import {
  Injectable,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import type { CreditActor } from '../shared/credit.store';
import { CreditPartyDto, CreditGrantDto } from './credit-partners.dto';

@Injectable()
export class CreditPartnersService {
  constructor(private readonly store: CreditStore) {}

  async access(actor: CreditActor) {
    const permissions: Record<string, boolean> = {};
    for (const [name, roles] of Object.entries({
      overview: ['manager', 'accountant', 'collector', 'auditor'],
      review: ['analyst'],
      activate: ['analyst'],
    })) {
      try {
        await this.store.authorize(this.store.db.manager, actor, roles);
        permissions[name] = true;
      } catch (error) {
        if (error instanceof ForbiddenException) permissions[name] = false;
        else throw error;
      }
    }
    return permissions;
  }

  async party(actor: CreditActor, id: string, dto: CreditPartyDto) {
    return this.store.db.transaction(async (m) => {
      await this.store.authorize(m, actor, []); // Only persisted super-admin can habilitate a legal entity.
      const [org] = await m.query<{ id: string; legalName: string }[]>(
        'SELECT id,"legalName" FROM partner_organizations WHERE id=$1 AND status=\'ACTIVE\' FOR SHARE',
        [id],
      );
      if (!org?.legalName?.trim())
        throw new ConflictException(
          'Entreprise active et raison sociale requises.',
        );
      await m.query(
        `INSERT INTO pro_credit_parties("organizationId",supplier,funder,operator,enabled,"authorizationReference","validatedBy")
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT("organizationId") DO UPDATE SET supplier=$2,funder=$3,operator=$4,enabled=$5,
        "authorizationReference"=$6,"validatedBy"=$7,"updatedAt"=now()`,
        [
          id,
          dto.supplier,
          dto.funder,
          dto.operator,
          dto.enabled,
          dto.authorizationReference.trim(),
          actor.userId,
        ],
      );
      await this.store.audit(m, actor.userId, 'party_configured', {
        id,
        ...dto,
      });
      return { id };
    });
  }

  async grant(actor: CreditActor, dto: CreditGrantDto) {
    return this.store.db.transaction(async (m) => {
      await this.store.authorize(m, actor, []);
      if (
        ['funder', 'supplier'].includes(dto.role) !==
        Boolean(dto.organizationId)
      )
        throw new BadRequestException('Périmètre organisation incorrect.');
      await m.query(
        `INSERT INTO pro_credit_grants("userId",role,"organizationId",enabled,"grantedBy") VALUES($1,$2,$3,$4,$5)
        ON CONFLICT("userId",role,"organizationId") DO UPDATE SET enabled=$4,"grantedBy"=$5`,
        [
          dto.userId,
          dto.role,
          dto.organizationId ?? null,
          dto.enabled,
          actor.userId,
        ],
      );
      await this.store.audit(m, actor.userId, 'grant_configured', dto);
      return { updated: true };
    });
  }
}
