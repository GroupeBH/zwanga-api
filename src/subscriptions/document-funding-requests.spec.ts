import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ListDocumentFundingRequestsQueryDto } from './dto/subscription.dto';
import { DocumentFundingRequestStatus } from './entities/document-funding-request.entity';
import { SubscriptionsService } from './subscriptions.service';

describe('document funding request filters', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const validateQuery = (query: unknown) =>
    pipe.transform(query, {
      type: 'query',
      metatype: ListDocumentFundingRequestsQueryDto,
    });

  describe('query validation', () => {
    it.each([
      {},
      { status: DocumentFundingRequestStatus.PENDING },
      { dateFrom: '2024-02-29' },
      { dateTo: '2026-12-31' },
      { requesterName: 'Jean Mukendi' },
      {
        status: DocumentFundingRequestStatus.APPROVED,
        dateFrom: '2026-10-01',
        dateTo: '2026-10-21',
        requesterName: 'Mukendi Jean',
      },
    ])('accepts supported filters %j', async (query) => {
      await expect(validateQuery(query)).resolves.toMatchObject(query);
    });

    it.each([
      { dateFrom: '2026-02-29' },
      { dateTo: '2026-02-30' },
      { dateFrom: '2026-13-01' },
      { dateTo: '2026-1-01' },
      { dateFrom: '2026-10-21T12:00:00Z' },
      { dateTo: '' },
      { dateFrom: ['2026-10-01', '2026-10-21'] },
      { requesterName: ['Jean', 'Paul'] },
      { requesterName: 'a'.repeat(161) },
      { status: 'invalid' },
    ])('rejects malformed filters %j', async (query) => {
      await expect(validateQuery(query)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('list query', () => {
    const rows = [
      { id: 'request-1', driver: { firstName: 'Jean' }, subscription: null },
    ];
    let query: {
      leftJoinAndSelect: jest.Mock;
      andWhere: jest.Mock;
      orderBy: jest.Mock;
      addOrderBy: jest.Mock;
      getMany: jest.Mock;
    };
    let repository: { createQueryBuilder: jest.Mock };
    let service: SubscriptionsService;

    beforeEach(() => {
      query = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      repository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
      service = new SubscriptionsService(
        {} as any,
        repository as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('preserves the array, relations and newest-first order without filters', async () => {
      await expect(service.getDocumentFundingRequests({})).resolves.toBe(rows);
      expect(query.andWhere).not.toHaveBeenCalled();
      expect(query.leftJoinAndSelect).toHaveBeenCalledWith(
        'fundingRequest.driver',
        'driver',
      );
      expect(query.leftJoinAndSelect).toHaveBeenCalledWith(
        'fundingRequest.subscription',
        'subscription',
      );
      expect(query.orderBy).toHaveBeenCalledWith(
        'fundingRequest.createdAt',
        'DESC',
      );
      expect(query.addOrderBy).toHaveBeenCalledWith(
        'fundingRequest.id',
        'DESC',
      );
    });

    it('keeps the existing status-only filter', async () => {
      await service.getDocumentFundingRequests({
        status: DocumentFundingRequestStatus.FUNDED,
      });
      expect(query.andWhere).toHaveBeenCalledTimes(1);
      expect(query.andWhere).toHaveBeenCalledWith(
        'fundingRequest.status = :status',
        { status: 'funded' },
      );
    });

    it('combines status, inclusive dates and a partial full name in either order', async () => {
      await service.getDocumentFundingRequests({
        status: DocumentFundingRequestStatus.PENDING,
        dateFrom: '2026-10-01',
        dateTo: '2026-10-21',
        requesterName: '  Mukendi   Jean  ',
      });
      expect(query.andWhere).toHaveBeenCalledTimes(4);
      expect(query.andWhere).toHaveBeenCalledWith(
        'fundingRequest.status = :status',
        { status: 'pending' },
      );
      expect(query.andWhere).toHaveBeenCalledWith(
        'fundingRequest.createdAt >= :dateFrom',
        {
          dateFrom: new Date('2026-09-30T23:00:00Z'),
        },
      );
      expect(query.andWhere).toHaveBeenCalledWith(
        'fundingRequest.createdAt < :dateToExclusive',
        {
          dateToExclusive: new Date('2026-10-21T23:00:00Z'),
        },
      );
      const [sql, params] = query.andWhere.mock.calls[3];
      expect(sql).toContain(
        "concat(driver.firstName, ' ', driver.lastName) ILIKE :requesterName",
      );
      expect(sql).toContain(
        "OR concat(driver.lastName, ' ', driver.firstName) ILIKE :requesterName",
      );
      expect(sql.trim().startsWith('(')).toBe(true);
      expect(sql.trim().endsWith(')')).toBe(true);
      expect(params).toEqual({ requesterName: '%Mukendi Jean%' });
    });

    it('accepts only a lower date bound', async () => {
      await service.getDocumentFundingRequests({ dateFrom: '2026-10-21' });
      expect(query.andWhere).toHaveBeenCalledTimes(1);
      expect(query.andWhere).toHaveBeenCalledWith(
        'fundingRequest.createdAt >= :dateFrom',
        {
          dateFrom: new Date('2026-10-20T23:00:00Z'),
        },
      );
    });

    it.each([
      ['2026-12-31', '2026-12-31T23:00:00Z'],
      ['2024-02-29', '2024-02-29T23:00:00Z'],
    ])(
      'accepts only an upper bound through the end of %s',
      async (dateTo, expectedEnd) => {
        await service.getDocumentFundingRequests({ dateTo });
        expect(query.andWhere).toHaveBeenCalledTimes(1);
        expect(query.andWhere).toHaveBeenCalledWith(
          'fundingRequest.createdAt < :dateToExclusive',
          {
            dateToExclusive: new Date(expectedEnd),
          },
        );
      },
    );

    it('supports a single complete calendar day', async () => {
      await service.getDocumentFundingRequests({
        dateFrom: '2026-10-21',
        dateTo: '2026-10-21',
      });
      expect(query.andWhere).toHaveBeenCalledTimes(2);
      const from = query.andWhere.mock.calls[0][1].dateFrom as Date;
      const to = query.andWhere.mock.calls[1][1].dateToExclusive as Date;
      expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it('rejects an inverted period before querying the database', async () => {
      await expect(
        service.getDocumentFundingRequests({
          dateFrom: '2026-10-22',
          dateTo: '2026-10-21',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('binds names as parameters and treats SQL wildcard characters literally', async () => {
      const name = "O'Neil_50%!";
      await service.getDocumentFundingRequests({ requesterName: name });
      const [sql, params] = query.andWhere.mock.calls[0];
      expect(sql).not.toContain(name);
      expect(sql).toContain("ESCAPE '!'");
      expect(params).toEqual({ requesterName: "%O'Neil!_50!%!!%" });
    });

    it('ignores a whitespace-only name', async () => {
      await service.getDocumentFundingRequests({ requesterName: '  \t ' });
      expect(query.andWhere).not.toHaveBeenCalled();
    });
  });
});
