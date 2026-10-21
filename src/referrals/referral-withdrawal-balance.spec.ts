import { ValidationPipe } from '@nestjs/common';
import { RequestReferralWithdrawalDto } from './dto/referral.dto';
import { reserveAvailableReferralTokens } from './referral-withdrawal-balance';

describe('available referral tokens are the only withdrawal funding', () => {
  it.each([0, 999, 999.99])('refuses %s available tokens despite other balances', availableTokens => {
    const account = {
      availableTokens,
      reservedTokens: 10000,
      pendingTokens: 10000,
      withdrawnTokens: 10000,
      balance: 10000,
      withdrawableBalance: 10000,
    };
    const before = { ...account };
    expect(() => reserveAvailableReferralTokens(account, 1000)).toThrow(
      'disponibles insuffisant',
    );
    expect(account).toEqual(before);
  });

  it('reserves the exact available balance without spending any other bucket', () => {
    expect(reserveAvailableReferralTokens({
      availableTokens: '1000.01', reservedTokens: '200.25',
    }, 1000.01)).toEqual({ availableTokens: 0, reservedTokens: 1200.26 });
  });

  it.each([NaN, Infinity, -1, null, undefined, '', 'NaN', 'Infinity', 'invalid', 1000.001])(
    'fails closed on an invalid stored available balance %s',
    availableTokens => {
      expect(() => reserveAvailableReferralTokens({
        availableTokens: availableTokens as number, reservedTokens: 0,
      }, 1000)).toThrow('Solde de parrainage invalide');
    },
  );

  it.each([NaN, Infinity, -1, null])(
    'fails closed on an invalid stored reservation %s',
    reservedTokens => {
      expect(() => reserveAvailableReferralTokens({
        availableTokens: 2000, reservedTokens: reservedTokens as number,
      }, 1000)).toThrow('Solde de parrainage invalide');
    },
  );
});

describe('withdrawal HTTP input cannot choose a funding source or balance', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const metadata = { type: 'body' as const, metatype: RequestReferralWithdrawalDto };

  it.each(['availableTokens', 'pendingTokens', 'reservedTokens', 'amount', 'userId', 'currency', 'source'])(
    'rejects the client-supplied field %s',
    async field => {
      await expect(pipe.transform({ tokens: 1000, [field]: 10000 }, metadata))
        .rejects.toThrow();
    },
  );

  it('preserves the existing mobile request contract', async () => {
    await expect(pipe.transform({ tokens: 1000, phone: '+243891234567' }, metadata))
      .resolves.toMatchObject({ tokens: 1000, phone: '+243891234567' });
  });
});
