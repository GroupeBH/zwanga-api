import { PartnersService } from './partners.service';

describe('field progress bounded projection', () => {
  it('reads only the latest identity and existence of an active vehicle', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'driver', phone: '+243812345678', role: 'driver', status: 'active', isActive: true,
      kycId: 'kyc', kycCreatedAt: new Date(), kycProvider: 'didit', kycStatus: 'approved', hasVehicle: true }]);
    const qb: any = { select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(), getRawMany: jest.fn().mockResolvedValue([]) };
    const service: any = Object.assign(Object.create(PartnersService.prototype), { users: { query }, trips: { createQueryBuilder: () => qb } });
    const result = await service.leadProgress([{ id: 'lead', phone: '+243812345678' }]);
    expect(result[0].status).toBe('READY_TO_DRIVE');
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('ORDER BY "createdAt" DESC,id DESC LIMIT 1');
    expect(sql).toContain('EXISTS (SELECT 1 FROM vehicles');
    expect(sql).not.toMatch(/password|documentUrl|refreshToken|SELECT \*/);
    expect(query.mock.calls[0][1][0]).toContain('+243812345678');
  });
  it('chunks phone lookup parameters and does not issue empty SQL', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service: any = Object.assign(Object.create(PartnersService.prototype), { users: { query } });
    expect(await service.leadProgress([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await service.leadProgress(Array.from({ length: 201 }, (_, i) => ({ id: String(i), phone: `+24381${String(i).padStart(7, '0')}` })));
    expect(query.mock.calls.length).toBeGreaterThan(1);
    for (const [, [phones]] of query.mock.calls) expect(phones.length).toBeLessThanOrEqual(200);
  });
});
