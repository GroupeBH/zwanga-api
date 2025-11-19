import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
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
    const entry = this.faqRepository.create(dto);
    return this.faqRepository.save(entry);
  }

  async findAll(query: ListFaqQueryDto, includeUnpublished = false) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (query.category) {
      where.category = query.category;
    }

    if (!includeUnpublished) {
      where.isPublished = true;
    }

    if (query.search) {
      where.question = Like(`%${query.search}%`);
    }

    const [data, total] = await this.faqRepository.findAndCount({
      where,
      order: { order: 'ASC', createdAt: 'DESC' },
      skip,
      take: limit,
    });

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
    Object.assign(entry, dto);
    return this.faqRepository.save(entry);
  }

  async remove(id: string): Promise<void> {
    const entry = await this.findOne(id, true);
    await this.faqRepository.remove(entry);
  }
}

