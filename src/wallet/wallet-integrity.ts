/** Accounts start at zero. Every credit/debit must have a signed journal entry.
 * One SQL snapshot avoids concurrent-commit false positives. createdAt/UUID are
 * NOT a posting sequence (multiple entries may share a transaction timestamp).
 * Diagnostic only: never rewrite a balance from this query. */
export const WALLET_BALANCE_MISMATCH_SQL = `
  SELECT COUNT(*)::int AS count
  FROM wallet_accounts account
  LEFT JOIN (
    SELECT "accountId", SUM(amount) AS balance
    FROM wallet_ledger_entries GROUP BY "accountId"
  ) journal ON journal."accountId" = account.id
  WHERE account.balance <> COALESCE(journal.balance, 0)
`;
