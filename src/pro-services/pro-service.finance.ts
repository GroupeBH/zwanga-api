import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProServiceDocument, ProServiceLedger } from './pro-service.entities';
import { CustodyDto, ServiceLedgerDto } from './pro-service.dto';
import {
  assertAccepted,
  financialSummary,
  validateLedger,
} from './pro-service.policy';
import { ProServiceStore } from './pro-service.store';
import { ProServiceWorkflow } from './pro-service.workflow';

@Injectable()
export class ProServiceFinance {
  constructor(
    private readonly store: ProServiceStore,
    private readonly workflow: ProServiceWorkflow,
  ) {}
  async record(id: string, actorId: string, dto: ServiceLedgerDto) {
    const reference = dto.reference.trim();
    if (reference.length < 6 || dto.evidence.trim().length < 10)
      throw new BadRequestException(
        'Une référence et un justificatif vérifiés sont obligatoires.',
      );
    const replay = (entry: ProServiceLedger) => {
      if (
        entry.caseId !== id ||
        entry.kind !== dto.kind ||
        entry.amountMinor !== dto.amountMinor
      ) {
        throw new ConflictException(
          'Cette référence correspond déjà à une autre opération.',
        );
      }
      return { id: entry.id };
    };
    try {
      return await this.store.db.transaction(async (manager) => {
        const item = await this.store.requireCase(manager, id, undefined, true);
        const prior = await manager.findOneBy(ProServiceLedger, { reference });
        if (prior) return replay(prior);
        assertAccepted(item);
        if (dto.kind !== 'repayment')
          await this.workflow.legalGate(manager, item);
        const entries = await manager.find(ProServiceLedger, {
          where: { caseId: id },
        });
        validateLedger(item.quote!, entries, dto);
        const entry = await manager.save(
          ProServiceLedger,
          manager.create(ProServiceLedger, {
            caseId: id,
            kind: dto.kind,
            amountMinor: dto.amountMinor,
            currency: item.quote!.currency,
            reference,
            evidence: dto.evidence.trim(),
            recordedBy: actorId,
          }),
        );
        if (financialSummary(item.quote, [...entries, entry]).settled) {
          await manager.update(
            ProServiceDocument,
            { caseId: id, status: 'held' },
            { status: 'release_ready' },
          );
        }
        await this.store.audit(manager, id, actorId, 'ledger_recorded', {
          entryId: entry.id,
          kind: entry.kind,
          amountMinor: entry.amountMinor,
        });
        return { id: entry.id };
      });
    } catch (error) {
      if (error?.code !== '23505') throw error;
      const prior = await this.store.db
        .getRepository(ProServiceLedger)
        .findOneBy({ reference });
      if (!prior) throw error;
      return replay(prior);
    }
  }
  custody(id: string, documentId: string, actorId: string, dto: CustodyDto) {
    if (dto.receipt.trim().length < 3)
      throw new BadRequestException('Le reçu de remise est obligatoire.');
    return this.store.db.transaction(async (manager) => {
      const item = await this.store.requireCase(manager, id, undefined, true);
      assertAccepted(item);
      const doc = await manager.findOneBy(ProServiceDocument, {
        id: documentId,
        caseId: id,
      });
      if (!doc) throw new NotFoundException('Document introuvable.');
      if (dto.action === 'receive') {
        await this.workflow.legalGate(manager, item);
        if (
          doc.status !== 'expected' ||
          !item.quote!.terms!.custodyCodes.includes(doc.code) ||
          !dto.storageLocation?.trim()
        ) {
          throw new ConflictException(
            'Garde non autorisée ou lieu de conservation manquant.',
          );
        }
        const entries = await manager.find(ProServiceLedger, {
          where: { caseId: id },
        });
        const balance = financialSummary(item.quote, entries);
        if (!balance.fundedMinor)
          throw new ConflictException(
            'Aucune avance effectivement versée ne justifie cette garde.',
          );
        doc.status = balance.settled ? 'release_ready' : 'held';
        doc.heldAt = new Date();
        doc.receipt = dto.receipt.trim();
        doc.storageLocation = dto.storageLocation.trim();
      } else {
        if (doc.status !== 'release_ready')
          throw new ConflictException(
            'La restitution nécessite le remboursement complet enregistré.',
          );
        doc.status = 'returned';
        doc.returnedAt = new Date();
        doc.returnReceipt = dto.receipt.trim();
      }
      await manager.save(doc);
      await this.store.audit(manager, id, actorId, `document_${dto.action}`, {
        documentId,
        receipt: dto.receipt.trim(),
      });
      return { id: documentId };
    });
  }
}
