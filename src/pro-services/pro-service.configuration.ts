import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProServiceEvent, ProServiceOffering } from './pro-service.entities';
import { OfferingUpdateDto } from './pro-service.dto';
import { ProServiceStore } from './pro-service.store';
import { DOCUMENT_OPTIONS, ServiceCode } from './pro-service.types';

@Injectable()
export class ProServiceConfiguration {
  constructor(private readonly store: ProServiceStore) {}
  update(code: string, actorId: string, dto: OfferingUpdateDto) {
    return this.store.db.transaction(async (manager) => {
      const offering = await manager.findOne(ProServiceOffering, {
        where: { code: code as ServiceCode },
        lock: { mode: 'pessimistic_write' },
      });
      if (!offering) throw new NotFoundException('Service introuvable.');
      if (dto.legalValidated) {
        if (code !== 'documents')
          throw new ConflictException(
            'Seule l’ouverture des demandes est disponible pour ce service.',
          );
        if (
          !dto.termsVersion.trim() ||
          dto.termsText.trim().length < 50 ||
          !dto.validationReference.trim()
        ) {
          throw new BadRequestException(
            'Renseignez le contrat validé, sa version et la référence de validation juridique.',
          );
        }
        if (
          dto.custodyCodes.some(
            (code) => !DOCUMENT_OPTIONS.some(([known]) => known === code),
          )
        ) {
          throw new BadRequestException(
            'Un code de document autorisé est inconnu.',
          );
        }
        const unchanged =
          offering.terms?.version === dto.termsVersion.trim() &&
          offering.terms.text === dto.termsText.trim() &&
          offering.terms.validationReference ===
            dto.validationReference.trim() &&
          JSON.stringify(offering.terms.custodyCodes) ===
            JSON.stringify(dto.custodyCodes);
        if (!unchanged) {
          const used = await manager
            .getRepository(ProServiceEvent)
            .createQueryBuilder('e')
            .where(
              "e.action = 'terms_validated' AND e.detail->>'serviceCode' = :code AND e.detail->>'version' = :version",
              { code, version: dto.termsVersion.trim() },
            )
            .getExists();
          if (used)
            throw new ConflictException(
              'Cette version du contrat existe déjà. Utilisez une nouvelle version.',
            );
          offering.terms = {
            version: dto.termsVersion.trim(),
            text: dto.termsText.trim(),
            validationReference: dto.validationReference.trim(),
            custodyCodes: dto.custodyCodes,
            validatedBy: actorId,
            validatedAt: new Date().toISOString(),
          };
          await this.store.audit(manager, null, actorId, 'terms_validated', {
            serviceCode: code,
            version: offering.terms.version,
            terms: offering.terms,
          });
        }
      } else offering.terms = null;
      offering.availability = dto.availability;
      await manager.save(offering);
      await this.store.audit(manager, null, actorId, 'offering_updated', {
        serviceCode: code,
        availability: dto.availability,
        legalValidated: dto.legalValidated,
      });
      return { code };
    });
  }
}
