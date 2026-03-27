import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FaqEntry } from './entities/faq-entry.entity';
import {
  CreateFaqEntryDto,
  UpdateFaqEntryDto,
  ListFaqQueryDto,
} from './dto/faq.dto';

@Injectable()
export class FaqService {
  constructor(
    @InjectRepository(FaqEntry)
    private readonly faqRepository: Repository<FaqEntry>,
  ) {}

  async create(dto: CreateFaqEntryDto): Promise<FaqEntry> {
    const entry = this.faqRepository.create({
      ...dto,
      category: this.normalizeOptional(dto.category),
      locale: dto.locale?.trim() || 'fr-CD',
      audience: this.normalizeOptional(dto.audience),
      keywords: this.normalizeOptional(dto.keywords),
    });
    return this.faqRepository.save(entry);
  }

  async findAll(query: ListFaqQueryDto, includeUnpublished = false) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const faqQuery = this.faqRepository.createQueryBuilder('faq');

    if (!includeUnpublished) {
      faqQuery.andWhere('faq.isPublished = :isPublished', { isPublished: true });
    }

    if (query.category?.trim()) {
      faqQuery.andWhere('LOWER(faq.category) = LOWER(:category)', {
        category: query.category.trim(),
      });
    }

    if (query.locale?.trim()) {
      faqQuery.andWhere('(faq.locale = :locale OR faq.locale IS NULL)', {
        locale: query.locale.trim(),
      });
    }

    if (query.audience?.trim()) {
      faqQuery.andWhere('(faq.audience = :audience OR faq.audience IS NULL)', {
        audience: query.audience.trim(),
      });
    }

    if (query.search?.trim()) {
      faqQuery.andWhere(
        '(faq.question ILIKE :search OR faq.answer ILIKE :search OR faq.keywords ILIKE :search)',
        {
          search: `%${query.search.trim()}%`,
        },
      );
    }

    const [data, total] = await faqQuery
      .orderBy('faq.order', 'ASC')
      .addOrderBy('faq.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      data,
      meta: {
        page,
        limit,
        total,
      },
    };
  }

  async findOne(id: string, includeUnpublished = false): Promise<FaqEntry> {
    const entry = await this.faqRepository.findOne({ where: { id } });

    if (!entry || (!entry.isPublished && !includeUnpublished)) {
      throw new NotFoundException('FAQ entry not found');
    }

    return entry;
  }

  async update(id: string, dto: UpdateFaqEntryDto): Promise<FaqEntry> {
    const entry = await this.findOne(id, true);
    Object.assign(entry, {
      ...dto,
      ...(dto.category !== undefined
        ? { category: this.normalizeOptional(dto.category) }
        : {}),
      ...(dto.locale !== undefined ? { locale: dto.locale.trim() || 'fr-CD' } : {}),
      ...(dto.audience !== undefined
        ? { audience: this.normalizeOptional(dto.audience) }
        : {}),
      ...(dto.keywords !== undefined
        ? { keywords: this.normalizeOptional(dto.keywords) }
        : {}),
    });
    return this.faqRepository.save(entry);
  }

  async remove(id: string): Promise<void> {
    const entry = await this.findOne(id, true);
    await this.faqRepository.remove(entry);
  }

  private normalizeOptional(value?: string | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }
}

