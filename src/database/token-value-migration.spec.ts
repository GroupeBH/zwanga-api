import { QueryRunner } from 'typeorm';
import { TokenValue25Cdf1780000070000 } from './migrations/1780000070000-TokenValue25Cdf';
import { WelcomeBonus25CdfCopy1780000071000 } from './migrations/1780000071000-WelcomeBonus25CdfCopy';
import { TokenValue10Cdf1780000080000 } from './migrations/1780000080000-TokenValue10Cdf';
import { WelcomeBonus500Tokens1780000081000 } from './migrations/1780000081000-WelcomeBonus500Tokens';

describe('token denomination migration', () => {
  it('changes only the new booking default to 10 and can restore 25 without repricing rows', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const runner = { isTransactionActive: true, query } as unknown as QueryRunner;
    const migration = new TokenValue10Cdf1780000080000();
    await migration.up(runner);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('SET DEFAULT 10'));
    await migration.down(runner);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('SET DEFAULT 25'));
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b/i);
    await expect(migration.up({ isTransactionActive: false } as QueryRunner)).rejects.toThrow('transaction');
  });

  it('refuses an unknown welcome function instead of guessing how to credit 500 tokens', async () => {
    const query = jest.fn().mockResolvedValue([{ definition: 'unrecognized function' }]);
    const migration = new WelcomeBonus500Tokens1780000081000();
    await expect(migration.up({ isTransactionActive: true, query } as unknown as QueryRunner))
      .rejects.toThrow('Unexpected');
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toContain('ALTER TABLE');
    await expect(migration.down()).rejects.toThrow('forward');
  });
  it('only adjusts the welcome copy, without granting or multiplying any tokens', async () => {
    const definition =
      "CREATE OR REPLACE FUNCTION zwanga_grant_welcome_bonus(uid uuid) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM 'Bienvenue chez Zwanga ! 5 000 FC vous sont offerts sous forme de jetons Zwanga pour vous permettre de payer votre abonnement Pro.'; RETURN false; END $$;";
    const query = jest.fn().mockResolvedValue([{ definition }]);
    const migration = new WelcomeBonus25CdfCopy1780000071000();
    await migration.up({
      isTransactionActive: true,
      query,
    } as unknown as QueryRunner);
    expect(query).toHaveBeenLastCalledWith(
      definition.replace(
        '5 000 FC vous sont offerts sous forme de jetons Zwanga pour vous permettre de payer',
        '1 250 FC vous sont offerts sous forme de 50 jetons Zwanga pour contribuer au paiement de',
      ),
    );
    query.mockResolvedValue([{ definition: 'unknown' }]);
    await expect(
      migration.up({
        isTransactionActive: true,
        query,
      } as unknown as QueryRunner),
    ).rejects.toThrow('Unexpected');
  });
  it('changes new quote defaults without modifying existing balances or financial rows', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new TokenValue25Cdf1780000070000().up({
      isTransactionActive: true,
      query,
    } as unknown as QueryRunner);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('SET DEFAULT 25');
    expect(sql).toContain('"tokenQuantity" numeric(12,2)');
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b/i);
    expect(sql).not.toContain('wallet_accounts');
  });

  it('requires a transaction and refuses a destructive rollback', async () => {
    const migration = new TokenValue25Cdf1780000070000();
    const query = jest.fn();
    await expect(
      migration.up({
        isTransactionActive: false,
        query,
      } as unknown as QueryRunner),
    ).rejects.toThrow('transaction');
    expect(query).not.toHaveBeenCalled();
    await expect(migration.down()).rejects.toThrow('forward');
  });
});
