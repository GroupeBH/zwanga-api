import { join } from 'path';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { resolveDirectConversation } from '../chat/direct-conversation';
import { Conversation } from '../chat/entities/conversation.entity';
import { ReferralsService } from './referrals.service';
import { ReferralProfile } from './entities/referral-profile.entity';
import { ReferralReward } from './entities/referral-reward.entity';
import { ReferralWithdrawal } from './entities/referral-withdrawal.entity';

describe('performance reads: generated PostgreSQL, without a database connection', () => {
  let source: DataSource;
  beforeAll(async () => {
    source = new DataSource({ type: 'postgres', database: 'metadata_only', entities: [join(__dirname, '../**/*.entity.ts')] });
    await (source as any).buildMetadatas();
  });
  afterEach(() => jest.restoreAllMocks());

  it('quotes the third-participant subquery and binds both direct-message participants', async () => {
    jest.spyOn(source.manager, 'transaction').mockImplementation((async (work: any) => work(source.manager)) as any);
    jest.spyOn(source.manager, 'query').mockResolvedValue([]);
    jest.spyOn(SelectQueryBuilder.prototype, 'getOne').mockImplementation(async function () {
      const [sql, params] = this.getQueryAndParameters();
      expect(sql).toContain('"other"."conversationId" = "conversation"."id"');
      expect(sql).toContain('"other"."userId" NOT IN');
      expect(sql).not.toContain('other.conversationId');
      expect(sql).toContain('"conversation"."bookingId" IS NULL');
      expect(params).toEqual(expect.arrayContaining(['first-account', 'second-account', 'general']));
      return { id: 'existing' } as any;
    });
    await expect(resolveDirectConversation(source.getRepository(Conversation), 'first-account', 'second-account')).resolves.toEqual({ id: 'existing' });
  });

  it('limits referral page IDs and keeps ownership parameters with real TypeORM metadata', async () => {
    const service: any = Object.create(ReferralsService.prototype);
    service.profileRepository = source.getRepository(ReferralProfile);
    service.rewardRepository = source.getRepository(ReferralReward);
    service.withdrawalRepository = source.getRepository(ReferralWithdrawal);
    const queries: string[] = [];
    jest.spyOn(SelectQueryBuilder.prototype, 'getRawMany').mockImplementation(async function () {
      const [sql, params] = this.getQueryAndParameters();
      expect(params).toContain('owner-only');
      expect(sql).toContain('LIMIT 3');
      expect(sql).toContain('DESC');
      queries.push(sql); return [];
    });
    for (const method of ['getReferralPage', 'getRewardPage', 'getWithdrawalPage']) {
      expect(await service[method]('owner-only', { limit: 2 })).toEqual({ data: [], nextCursor: null });
    }
    expect(queries[0]).toContain('COALESCE("profile"."referredAt", "profile"."createdAt")');
    expect(queries[0]).toContain('"profile"."referredByUserId"');
    expect(queries[1]).toContain('"reward"."referrerUserId"');
    expect(queries[2]).toContain('"withdrawal"."userId"');
  });
});
