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
import { CreateServiceCaseDto, ListServiceCasesDto } from './pro-service.dto';
import { DOCUMENT_OPTIONS } from './pro-service.types';
import { financialSummary } from './pro-service.policy';

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
    if (dto.contactConsent !== true) throw new BadRequestException('Votre accord pour être contacté est nécessaire.');
    const repo = this.db.getRepository(ProServiceCase);
    const app = dto.application;
    const application = {
      fullName: app.fullName.trim(),
      phone: app.phone.trim(),
      vehicleDescription: app.vehicleDescription.trim(),
      plate: app.plate?.trim().toUpperCase() || '',
      documents: [...app.documents].sort(),
      description: app.description.trim(),
    };
    if (
      application.fullName.length < 3 ||
      application.phone.replace(/\D/g, '').length < 8
    ) {
      throw new BadRequestException(
        'Renseignez votre nom et un numéro de contact valide.',
      );
    }
    if (
      dto.serviceCode === 'documents' &&
      (!application.documents.length ||
        application.documents.some(
          (code) => !DOCUMENT_OPTIONS.some(([known]) => known === code),
        ))
    )
      throw new BadRequestException('Choisissez au moins un document proposé.');
    if (dto.serviceCode !== 'documents' && application.description.length < 10)
      throw new BadRequestException('Précisez votre besoin.');
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
        const offering = await manager.findOne(ProServiceOffering, {
          where: { code: dto.serviceCode },
          lock: { mode: 'pessimistic_read' },
        });
        if (offering?.availability !== 'open')
          throw new ConflictException(
            'Ce service n’accepte pas de nouvelles demandes.',
          );
        if (ownerId) await this.activeUser(manager, ownerId);
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
