import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  ProServiceCase,
  ProServiceDocument,
  ProServiceEvent,
  ProServiceLedger,
  ProServiceOffering,
} from './pro-service.entities';
import { CreateServiceCaseDto, ListServiceCasesDto, UpdateDocumentCaseDto } from './pro-service.dto';
import { DOCUMENT_OPTIONS } from './pro-service.types';
import { financialSummary } from './pro-service.policy';
import { canEditDocumentCase, documentCaseEditMode, normalizeServiceApplication, sameApplication } from './document-case.policy';

@Injectable()
export class ProServiceStore {
  constructor(readonly db: DataSource) {}
  async catalogue(admin = false) {
    const items = await this.db
      .getRepository(ProServiceOffering)
      .find({ order: { code: 'ASC' } });
    return items.map((item) => ({
      code: item.code,
      name: item.name,
      description: item.description,
      availability: item.availability,
      engagementEnabled: Boolean(item.terms),
      documentOptions:
        item.code === 'documents'
          ? DOCUMENT_OPTIONS.map(([code, label]) => ({ code, label }))
          : [],
      ...(admin ? { terms: item.terms, updatedAt: item.updatedAt } : {}),
    }));
  }
  async create(dto: CreateServiceCaseDto, ownerId: string | null) {
    const repo = this.db.getRepository(ProServiceCase);
    const application = normalizeServiceApplication(dto.serviceCode, dto.application, dto.contactConsent);
    const same = (item: ProServiceCase) => {
      if (
        item.ownerId !== ownerId ||
        item.serviceCode !== dto.serviceCode ||
        JSON.stringify(item.application) !== JSON.stringify(application)
      ) {
        // Compare object keys independently: JSONB does not preserve property order.
        if (
          item.ownerId !== ownerId ||
          item.serviceCode !== dto.serviceCode ||
          Object.keys(application).some(
            (key) =>
              JSON.stringify(item.application[key]) !==
              JSON.stringify(application[key]),
          )
        ) {
          throw new ConflictException(
            'Cette référence de soumission a déjà été utilisée.',
          );
        }
      }
      return { id: item.id };
    };
    const previous = await repo.findOneBy({ submissionKey: dto.submissionKey });
    if (previous) return same(previous);
    try {
      return await this.db.transaction(async (manager) => {
        // Same lock order as acceptance/linking: account, then dossier. This
        // serializes different submission keys across API tasks, not just double taps.
        if (ownerId) {
          await this.activeUser(manager, ownerId, true);
          const replay = await manager.findOneBy(ProServiceCase, { submissionKey: dto.submissionKey });
          if (replay) return same(replay);
          if (dto.serviceCode === 'documents') await this.assertNoDocumentCase(manager, ownerId);
        }
        const offering = await manager.findOne(ProServiceOffering, {
          where: { code: dto.serviceCode },
          lock: { mode: 'pessimistic_read' },
        });
        if (offering?.availability !== 'open')
          throw new ConflictException(
            'Ce service n’accepte pas de nouvelles demandes.',
          );
        const item = await manager.save(
          ProServiceCase,
          manager.create(ProServiceCase, {
            serviceCode: dto.serviceCode,
            submissionKey: dto.submissionKey,
            application,
            ownerId,
            origin: ownerId ? 'mobile' : 'web',
            status: 'submitted',
          }),
        );
        await this.audit(manager, item.id, ownerId, 'submitted', {
          origin: item.origin,
          contactConsent: true,
          noticeVersion: 'services-contact-v1',
        });
        return { id: item.id };
      });
    } catch (error) {
      if (error?.code !== '23505') throw error;
      const existing = await repo.findOneBy({
        submissionKey: dto.submissionKey,
      });
      if (!existing) throw error;
      return same(existing);
    }
  }
  async findDocumentCase(manager: EntityManager, ownerId: string) {
    return manager.findOne(ProServiceCase, {
      where: { ownerId, serviceCode: 'documents' },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }
  async currentDocumentCase(ownerId: string) {
    const item = await this.findDocumentCase(this.db.manager, ownerId);
    return { request: item ? { id: item.id, status: item.status, canEdit: canEditDocumentCase(item) } : null };
  }
  async assertNoDocumentCase(manager: EntityManager, ownerId: string) {
    const item = await this.findDocumentCase(manager, ownerId);
    if (item) throw new ConflictException({
      code: 'DOCUMENT_REQUEST_ALREADY_EXISTS',
      message: 'Vous avez déjà une demande de documents. Modifiez votre demande existante.',
    });
  }
  async updateDocumentCase(id: string, ownerId: string, dto: UpdateDocumentCaseDto) {
    const application = normalizeServiceApplication('documents', dto.application, dto.contactConsent);
    return this.db.transaction(async manager => {
      await this.activeUser(manager, ownerId, true);
      const item = await this.requireCase(manager, id, ownerId, true);
      // Durable receipts make a lost response retry safe even after the team has
      // processed the dossier. Never overwrite newer data on a retry.
      const replay = await manager.getRepository(ProServiceEvent)
        .createQueryBuilder('event')
        .where('event."caseId" = :id AND event."actorId" = :ownerId AND event.action = :action', { id, ownerId, action: 'application_updated' })
        .andWhere("event.detail ->> 'mutationId' = :mutationId", { mutationId: dto.mutationId })
        .getOne();
      if (replay) {
        if (!sameApplication(replay.detail.application as any, application))
          throw new ConflictException('Cette référence de modification a déjà été utilisée.');
        return { id };
      }
      if (!canEditDocumentCase(item)) throw new ConflictException({
        code: 'DOCUMENT_REQUEST_NOT_EDITABLE',
        message: 'Cette demande ne peut plus être modifiée. Contactez l’assistance.',
      });
      if (item.updatedAt.getTime() !== Date.parse(dto.expectedUpdatedAt))
        throw new ConflictException({ code: 'DOCUMENT_REQUEST_CHANGED', message: 'La demande a changé. Actualisez le dossier avant de le modifier.' });
      const previousStatus = item.status;
      const editMode = documentCaseEditMode(item);
      const addedDocuments = application.documents.filter(code => !item.application.documents.includes(code));
      if (editMode === 'add_documents') {
        const original = normalizeServiceApplication('documents', item.application, true);
        if (!sameApplication({ ...application, documents: original.documents }, original) ||
            original.documents.some(code => !application.documents.includes(code)) || !addedDocuments.length)
          throw new ConflictException('Pour ce dossier engagé ou terminé, ajoutez un document sans modifier les informations déjà validées.');
      }
      item.application = application;
      if (editMode === 'full') item.status = 'submitted';
      // Keep the last quote for audit/version monotonicity, but it cannot be
      // accepted until a new quote is issued against this revised application.
      item.updatedAt = new Date(Math.max(Date.now(), item.updatedAt.getTime() + 1));
      await manager.save(item);
      await this.audit(manager, id, ownerId, 'application_updated', {
        mutationId: dto.mutationId, application, previousStatus,
        editMode, addedDocuments,
        invalidatedQuoteVersion: editMode === 'full' ? item.quote?.version ?? null : null, contactConsent: true,
      });
      return { id };
    });
  }
  async activeUser(manager: EntityManager, id: string, lock = false) {
    const user = await manager.findOne(User, {
      where: { id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (
      !user?.isActive ||
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.INACTIVE
    ) {
      throw new BadRequestException(
        'Ce compte ne peut pas engager cette démarche.',
      );
    }
    return user;
  }
  async list(query: ListServiceCasesDto, ownerId?: string) {
    const builder = this.db
      .getRepository(ProServiceCase)
      .createQueryBuilder('c')
      .select(['c.id', 'c.serviceCode', 'c.status', 'c.createdAt', 'c.application', 'c.customerMessage']);
    if (ownerId) builder.andWhere('c."ownerId" = :ownerId', { ownerId });
    if (query.status)
      builder.andWhere('c.status = :status', { status: query.status });
    if (query.cursor) {
      let cursor: { at: string; id: string };
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (
          !Number.isFinite(Date.parse(cursor.at)) ||
          !/^[0-9a-f-]{36}$/i.test(cursor.id)
        )
          throw new Error();
      } catch {
        throw new BadRequestException('Curseur invalide.');
      }
      builder.andWhere('(c."createdAt", c.id) < (:at, :id)', cursor);
    }
    const records = await builder
      .orderBy('c.createdAt', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .take(21)
      .getMany();
    const items = records
      .slice(0, 20)
      .map((item) => ({
        id: item.id,
        serviceCode: item.serviceCode,
        status: item.status,
        createdAt: item.createdAt,
        fullName: item.application.fullName,
        phone: item.application.phone ?? '',
        documentCodes: Array.isArray(item.application.documents) ? item.application.documents : [],
        customerMessage: item.customerMessage,
      }));
    const last = records[19];
    return {
      items,
      nextCursor:
        records.length > 20
          ? Buffer.from(
              JSON.stringify({ at: last.createdAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    };
  }
  async requireCase(
    manager: EntityManager,
    id: string,
    ownerId?: string,
    lock = false,
  ) {
    const item = await manager.findOne(ProServiceCase, {
      where: { id, ...(ownerId ? { ownerId } : {}) },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!item) throw new NotFoundException('Dossier introuvable.');
    return item;
  }
  async detail(id: string, ownerId?: string) {
    const item = await this.requireCase(this.db.manager, id, ownerId);
    const [documents, ledger, events, offering] = await Promise.all([
      this.db
        .getRepository(ProServiceDocument)
        .find({ where: { caseId: id }, order: { label: 'ASC' } }),
      this.db
        .getRepository(ProServiceLedger)
        .find({ where: { caseId: id }, order: { createdAt: 'ASC' } }),
      this.db
        .getRepository(ProServiceEvent)
        .find({
          where: { caseId: id },
          order: { createdAt: 'DESC' },
          take: 50,
          ...(ownerId ? { select: { id: true, action: true, createdAt: true } } : {}),
        }),
      this.db
        .getRepository(ProServiceOffering)
        .findOneBy({ code: item.serviceCode }),
    ]);
    const quote = item.quote && {
      ...item.quote,
      terms: item.quote.terms && {
        version: item.quote.terms.version,
        text: item.quote.terms.text,
      },
    };
    return {
      ...item,
      canEdit: canEditDocumentCase(item),
      editMode: documentCaseEditMode(item),
      quote: ownerId ? quote : item.quote,
      canAccept:
        item.status === 'quoted' &&
        Boolean(
          item.quote?.terms &&
          offering?.terms?.version === item.quote.terms.version &&
          offering.availability === 'open',
        ) &&
        Date.parse(item.quote!.validUntil) > Date.now(),
      documents: documents.map((doc) =>
        ownerId
          ? {
              id: doc.id,
              code: doc.code,
              label: doc.label,
              status: doc.status,
              receipt: doc.receipt,
              returnReceipt: doc.returnReceipt,
              heldAt: doc.heldAt,
              returnedAt: doc.returnedAt,
            }
          : doc,
      ),
      ledger: ledger.map((entry) =>
        ownerId
          ? {
              id: entry.id,
              kind: entry.kind,
              amountMinor: entry.amountMinor,
              currency: entry.currency,
              createdAt: entry.createdAt,
            }
          : entry,
      ),
      events: events.map((event) =>
        ownerId
          ? { id: event.id, action: event.action, createdAt: event.createdAt }
          : event,
      ),
      finances: financialSummary(item.quote, ledger),
    };
  }
  audit(
    manager: EntityManager,
    caseId: string | null,
    actorId: string | null,
    action: string,
    detail: Record<string, unknown> = {},
  ) {
    return manager.save(
      ProServiceEvent,
      manager.create(ProServiceEvent, { caseId, actorId, action, detail }),
    );
  }
}
