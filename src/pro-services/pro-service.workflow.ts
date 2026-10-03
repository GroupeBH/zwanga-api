import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import {
  ProServiceCase,
  ProServiceDocument,
  ProServiceLedger,
  ProServiceOffering,
} from './pro-service.entities';
import {
  AcceptServiceQuoteDto,
  CaseStatusDto,
  LinkServiceOwnerDto,
  QuoteServiceDto,
} from './pro-service.dto';
import {
  assertAccepted,
  assertTransition,
  financialSummary,
  validateQuote,
} from './pro-service.policy';
import { ProServiceStore } from './pro-service.store';

@Injectable()
export class ProServiceWorkflow {
  constructor(private readonly store: ProServiceStore) {}

  async quote(id: string, actorId: string, dto: QuoteServiceDto) {
    validateQuote(dto);
    return this.store.db.transaction(async (manager) => {
      const item = await this.store.requireCase(manager, id, undefined, true);
      if (
        !['submitted', 'reviewing', 'needs_info', 'quoted'].includes(
          item.status,
        ) ||
        item.acceptedAt
      ) {
        throw new ConflictException(
          'Ce dossier ne peut plus recevoir un nouveau devis.',
        );
      }
      if (item.serviceCode !== 'documents')
        throw new ConflictException(
          'Ce service accepte seulement les demandes pour le moment.',
        );
      const offering = await manager.findOneByOrFail(ProServiceOffering, {
        code: item.serviceCode,
      });
      if (
        dto.retainedDocuments.some(
          (doc) => !offering.terms?.custodyCodes.includes(doc.code),
        )
      ) {
        throw new BadRequestException(
          'Chaque original doit être expressément autorisé par les conditions validées.',
        );
      }
      item.quote = {
        ...dto,
        version: (item.quote?.version ?? 0) + 1,
        terms: offering.terms,
      };
      item.status = 'quoted';
      await manager.save(item);
      await this.store.audit(manager, id, actorId, 'quoted', {
        quote: item.quote,
      });
      return { id };
    });
  }

  async legalGate(manager: EntityManager, item: ProServiceCase) {
    const offering = await manager.findOne(ProServiceOffering, {
      where: { code: item.serviceCode },
      lock: { mode: 'pessimistic_read' },
    });
    if (
      item.serviceCode !== 'documents' ||
      offering?.availability !== 'open' ||
      !offering.terms ||
      !item.quote?.terms ||
      (!item.acceptedAt && offering.terms.version !== item.quote.terms.version)
    ) {
      throw new ConflictException(
        'Engagement bloqué : des conditions validées et un devis à jour sont obligatoires.',
      );
    }
  }

  async accept(id: string, ownerId: string, dto: AcceptServiceQuoteDto) {
    return this.store.db.transaction(async (manager) => {
      // User lock serializes simultaneous acceptances of different cases by one account.
      await this.store.activeUser(manager, ownerId, true);
      const item = await this.store.requireCase(manager, id, ownerId, true);
      if (item.acceptedAt && item.acceptedQuoteVersion === dto.quoteVersion)
        return { id };
      if (
        !dto.consent ||
        item.status !== 'quoted' ||
        !item.quote ||
        item.quote.version !== dto.quoteVersion ||
        Date.parse(item.quote.validUntil) <= Date.now()
      )
        throw new ConflictException('Ce devis a changé ou a expiré.');
      await this.legalGate(manager, item);
      const identity = await manager.findOne(KycDocument, {
        where: { userId: ownerId },
        order: { createdAt: 'DESC' },
      });
      if (identity?.status !== KycStatus.APPROVED)
        throw new ConflictException(
          'Vérifiez votre identité avant d’accepter ce devis.',
        );
      const pending = await manager
        .getRepository(ProServiceCase)
        .createQueryBuilder('c')
        .where(
          'c."ownerId" = :ownerId AND c."acceptedAt" IS NOT NULL AND c.id <> :id',
          { ownerId, id },
        )
        .andWhere(
          `(c.status <> 'completed' OR EXISTS (SELECT 1 FROM pro_service_ledger l WHERE l."caseId" = c.id GROUP BY l."caseId" HAVING SUM(CASE WHEN l.kind = 'funding' THEN l."amountMinor" WHEN l.kind = 'repayment' THEN -l."amountMinor" ELSE 0 END) > 0))`,
        )
        .getExists();
      if (pending)
        throw new ConflictException(
          'Un dossier engagé ou un remboursement est encore en cours.',
        );
      item.acceptedAt = new Date();
      item.acceptedQuoteVersion = dto.quoteVersion;
      item.status = 'accepted';
      await manager.save(item);
      for (const doc of item.quote.retainedDocuments) {
        await manager.save(
          ProServiceDocument,
          manager.create(ProServiceDocument, { caseId: id, ...doc }),
        );
      }
      await this.store.audit(manager, id, ownerId, 'accepted', {
        quoteVersion: dto.quoteVersion,
        termsVersion: item.quote.terms!.version,
        consent: true,
      });
      return { id };
    });
  }

  async status(id: string, actorId: string, dto: CaseStatusDto, owner = false) {
    return this.store.db.transaction(async (manager) => {
      const item = await this.store.requireCase(
        manager,
        id,
        owner ? actorId : undefined,
        true,
      );
      if (owner && dto.status !== 'cancelled')
        throw new BadRequestException('Seule l’annulation est disponible.');
      assertTransition(item, dto.status);
      if (dto.status === 'processing') {
        assertAccepted(item);
        const entries = await manager.find(ProServiceLedger, {
          where: { caseId: id },
        });
        const totals = financialSummary(item.quote, entries);
        if (
          totals.depositPaidMinor !== item.quote!.depositMinor ||
          totals.fundedMinor !==
            item.quote!.totalMinor - item.quote!.depositMinor
        ) {
          throw new ConflictException(
            'Enregistrez les justificatifs de l’apport et du paiement au prestataire avant le traitement.',
          );
        }
      }
      const previous = item.status;
      item.status = dto.status;
      item.customerMessage = dto.message.trim();
      await manager.save(item);
      await this.store.audit(manager, id, actorId, 'status_changed', {
        previous,
        status: dto.status,
        message: item.customerMessage,
      });
      return { id };
    });
  }

  async linkOwner(id: string, actorId: string, dto: LinkServiceOwnerDto) {
    if (dto.evidence.trim().length < 10)
      throw new BadRequestException('Documentez la vérification du titulaire.');
    return this.store.db.transaction(async (manager) => {
      const user = await this.store.activeUser(manager, dto.ownerId, true);
      const item = await this.store.requireCase(manager, id, undefined, true);
      if (item.ownerId || item.acceptedAt || item.origin !== 'web')
        throw new ConflictException('Ce dossier est déjà rattaché.');
      if (!user.isPhoneVerified)
        throw new ConflictException('Le compte doit avoir un numéro vérifié.');
      item.ownerId = user.id;
      await manager.save(item);
      await this.store.audit(manager, id, actorId, 'owner_linked', {
        ownerId: user.id,
        evidence: dto.evidence.trim(),
      });
      return { id };
    });
  }
}
