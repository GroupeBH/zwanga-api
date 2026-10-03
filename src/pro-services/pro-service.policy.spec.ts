import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateServiceCaseDto, QuoteServiceDto } from './pro-service.dto';
import { ProServiceCase, ProServiceLedger } from './pro-service.entities';
import {
  assertAccepted,
  assertTransition,
  financialSummary,
  validateLedger,
  validateQuote,
} from './pro-service.policy';
import { ServiceQuote } from './pro-service.types';

const quote: ServiceQuote = {
  version: 1,
  currency: 'CDF',
  totalMinor: 1000000,
  depositMinor: 200000,
  providerName: 'Prestataire test',
  description: 'Démarches de test',
  validUntil: '2040-01-01T00:00:00Z',
  installments: [
    { dueDate: '2040-02-01', amountMinor: 400000 },
    { dueDate: '2040-03-01', amountMinor: 400000 },
  ],
  retainedDocuments: [],
  terms: null,
};
const entry = (kind: ProServiceLedger['kind'], amountMinor: number) =>
  ({ kind, amountMinor }) as ProServiceLedger;
describe('Pro services financial policy', () => {
  it('allows a balanced quote without creating a debt', () => {
    expect(() => validateQuote(quote)).not.toThrow();
    expect(financialSummary(quote, []).balanceMinor).toBe(0);
  });
  it.each([
    { depositMinor: 1000001 },
    { validUntil: 'bad date' },
    { validUntil: '2000-01-01' },
    { installments: [{ dueDate: '2040-02-01', amountMinor: 799999 }] },
    { installments: [{ dueDate: '2030-01-01', amountMinor: 800000 }] },
    {
      installments: [
        { dueDate: '2040-02-01', amountMinor: 400000 },
        { dueDate: '2040-02-01', amountMinor: 400000 },
      ],
    },
    {
      retainedDocuments: [
        { code: 'a', label: 'A' },
        { code: 'a', label: 'A' },
      ],
    },
    {
      depositMinor: 1000000,
      installments: [],
      retainedDocuments: [{ code: 'a', label: 'A' }],
    },
  ])('rejects inconsistent quotes %j', (patch) =>
    expect(() =>
      validateQuote({ ...quote, ...patch } as QuoteServiceDto),
    ).toThrow(),
  );
  it('allocates partial repayments to the oldest installment', () => {
    const result = financialSummary(quote, [
      entry('deposit', 200000),
      entry('funding', 800000),
      entry('repayment', 500000),
    ]);
    expect(result.balanceMinor).toBe(300000);
    expect(result.installments.map((item) => item.remainingMinor)).toEqual([
      0, 300000,
    ]);
  });
  it('requires an exact advance after the agreed deposit', () => {
    const dto = {
      kind: 'funding' as const,
      amountMinor: 800000,
      reference: 'proof-test',
      evidence: 'Verified test receipt',
    };
    expect(() => validateLedger(quote, [], dto)).toThrow();
    expect(() =>
      validateLedger(quote, [entry('deposit', 200000)], dto),
    ).not.toThrow();
    expect(() =>
      validateLedger(
        quote,
        [entry('deposit', 200000), entry('funding', 800000)],
        dto,
      ),
    ).toThrow();
    expect(() =>
      validateLedger(quote, [entry('deposit', 200000)], {
        ...dto,
        amountMinor: 900000,
      }),
    ).toThrow();
  });
  it('forbids over-repayment and repayment before an advance', () => {
    const dto = {
      kind: 'repayment' as const,
      amountMinor: 1,
      reference: 'proof-test',
      evidence: 'Verified test receipt',
    };
    expect(() => validateLedger(quote, [], dto)).toThrow();
    expect(() =>
      validateLedger(
        quote,
        [entry('funding', 800000), entry('repayment', 800000)],
        dto,
      ),
    ).toThrow();
    expect(() =>
      validateLedger(quote, [entry('funding', 800000)], {
        ...dto,
        amountMinor: 800000,
      }),
    ).not.toThrow();
  });
  it('does not let status updates bypass applicant acceptance', () => {
    expect(() =>
      assertTransition({ status: 'quoted' } as ProServiceCase, 'accepted'),
    ).toThrow();
    expect(() =>
      assertTransition({ status: 'accepted' } as ProServiceCase, 'cancelled'),
    ).toThrow();
    expect(() =>
      assertAccepted({ quote, acceptedAt: null } as ProServiceCase),
    ).toThrow();
  });
  it('requires nested application data and validates each field', async () => {
    const errors = await validate(
      plainToInstance(CreateServiceCaseDto, {
        serviceCode: 'documents',
        submissionKey: '00000000-0000-4000-8000-000000000001',
      }),
    );
    expect(errors.some((error) => error.property === 'application')).toBe(true);
  });
});
