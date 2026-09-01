import { randomUUID } from 'crypto';
import { ReconciliationService } from './reconciliation.service';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { ReconciliationPort } from '../../ports/outbound/reconciliation.port';
import { PaymentProcessorFactory } from '../../adapters/psp/payment-processor.factory';
import { PSPSettlementTransaction } from '../../ports/outbound/psp-adapter.port';
import { PaymentAggregate, PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { Money } from '../../domain/value-objects/money.vo';

// ─── Mock Factories ──────────────────────────────────────────────────────────

const createMockPaymentRepository = (): jest.Mocked<PaymentRepositoryPort> => ({
  save: jest.fn(),
  findById: jest.fn(),
  findByIdOnMaster: jest.fn(),
  findByIdempotencyKey: jest.fn(),
  findByPspTransactionId: jest.fn(),
  findByMerchantId: jest.fn(),
  update: jest.fn(),
  existsById: jest.fn(),
  count: jest.fn(),
  findByProviderAndDateRange: jest.fn(),
  countByStatusAndProvider: jest.fn(),
  sumSucceededVolumeSince: jest.fn(),
  findAmbiguousOlderThan: jest.fn(),
  countAmbiguousIncidentsSince: jest.fn(),
  findRecentAmbiguousFlags: jest.fn(),
  findAmbiguousEligibleForAutoResolution: jest.fn(),
} as unknown as jest.Mocked<PaymentRepositoryPort>);

const createMockReconciliationRepo = (): jest.Mocked<ReconciliationPort> => ({
  save: jest.fn().mockResolvedValue(undefined),
  findRecent: jest.fn(),
  findByProvider: jest.fn(),
});

function createMockProcessorFactory(fetchSettlementTransactions: jest.Mock): PaymentProcessorFactory {
  return {
    getAdapter: jest.fn().mockReturnValue({ fetchSettlementTransactions }),
  } as unknown as PaymentProcessorFactory;
}

function makePayment(overrides: {
  pspTransactionId?: string;
  amount?: Money;
  status?: PaymentStatus;
  pspProvider?: PSPProvider;
} = {}): PaymentAggregate {
  return PaymentAggregate.reconstitute({
    id: randomUUID(),
    amount: overrides.amount ?? Money.of(50, 'USD'),
    status: overrides.status ?? PaymentStatus.SUCCEEDED,
    idempotencyKey: randomUUID(),
    metadata: { merchantId: 'merchant_1' },
    pspProvider: overrides.pspProvider ?? 'STRIPE',
    pspTransactionId: overrides.pspTransactionId ?? `pi_${randomUUID()}`,
  });
}

function makeSettlement(overrides: { pspTransactionId: string; amount?: Money; settledAt?: Date }): PSPSettlementTransaction {
  return {
    pspTransactionId: overrides.pspTransactionId,
    amount: overrides.amount ?? Money.of(50, 'USD'),
    settledAt: overrides.settledAt ?? new Date(),
  };
}

describe('ReconciliationService', () => {
  let paymentRepository: jest.Mocked<PaymentRepositoryPort>;
  let reconciliationRepo: jest.Mocked<ReconciliationPort>;
  let fetchSettlementTransactions: jest.Mock;
  let service: ReconciliationService;
  const since = new Date('2026-01-01T00:00:00.000Z');
  const until = new Date('2026-01-01T01:00:00.000Z');

  beforeEach(() => {
    paymentRepository = createMockPaymentRepository();
    reconciliationRepo = createMockReconciliationRepo();
    fetchSettlementTransactions = jest.fn();
    service = new ReconciliationService(
      paymentRepository,
      reconciliationRepo,
      createMockProcessorFactory(fetchSettlementTransactions),
    );
  });

  it('reports CLEAN with zero mismatches when every payment has a matching PSP settlement of the same amount', async () => {
    const payment = makePayment({ pspTransactionId: 'pi_1', amount: Money.of(50, 'USD') });
    paymentRepository.findByProviderAndDateRange.mockResolvedValue([payment]);
    fetchSettlementTransactions.mockResolvedValue([makeSettlement({ pspTransactionId: 'pi_1', amount: Money.of(50, 'USD') })]);

    const run = await service.reconcile('STRIPE', since, until);

    expect(run.status).toBe('CLEAN');
    expect(run.mismatches).toHaveLength(0);
    expect(run.transactionsChecked).toBe(2);
    expect(reconciliationRepo.save).toHaveBeenCalledWith(run);
  });

  it('flags MISSING_AT_PSP when our ledger has a charge the PSP has no settlement record for', async () => {
    const payment = makePayment({ pspTransactionId: 'pi_missing', amount: Money.of(75, 'USD') });
    paymentRepository.findByProviderAndDateRange.mockResolvedValue([payment]);
    fetchSettlementTransactions.mockResolvedValue([]);

    const run = await service.reconcile('STRIPE', since, until);

    expect(run.status).toBe('MISMATCHES_FOUND');
    expect(run.mismatches).toEqual([
      expect.objectContaining({
        type: 'MISSING_AT_PSP',
        paymentId: payment.id,
        pspTransactionId: 'pi_missing',
      }),
    ]);
  });

  it('flags AMOUNT_MISMATCH when both sides have the transaction but disagree on amount', async () => {
    const payment = makePayment({ pspTransactionId: 'pi_2', amount: Money.of(100, 'USD') });
    paymentRepository.findByProviderAndDateRange.mockResolvedValue([payment]);
    fetchSettlementTransactions.mockResolvedValue([makeSettlement({ pspTransactionId: 'pi_2', amount: Money.of(80, 'USD') })]);

    const run = await service.reconcile('STRIPE', since, until);

    expect(run.status).toBe('MISMATCHES_FOUND');
    expect(run.mismatches).toEqual([
      expect.objectContaining({
        type: 'AMOUNT_MISMATCH',
        paymentId: payment.id,
        pspTransactionId: 'pi_2',
      }),
    ]);
    const mismatch = run.mismatches[0];
    expect(mismatch.expectedAmount?.equals(Money.of(100, 'USD'))).toBe(true);
    expect(mismatch.actualAmount?.equals(Money.of(80, 'USD'))).toBe(true);
  });

  it('flags UNKNOWN_AT_PSP when the PSP settled something we have no record of at all', async () => {
    paymentRepository.findByProviderAndDateRange.mockResolvedValue([]);
    fetchSettlementTransactions.mockResolvedValue([makeSettlement({ pspTransactionId: 'pi_orphan', amount: Money.of(20, 'USD') })]);

    const run = await service.reconcile('STRIPE', since, until);

    expect(run.status).toBe('MISMATCHES_FOUND');
    expect(run.mismatches).toEqual([
      expect.objectContaining({
        type: 'UNKNOWN_AT_PSP',
        pspTransactionId: 'pi_orphan',
      }),
    ]);
  });

  it('sums multiple settlement records sharing one pspTransactionId (partial captures) before comparing', async () => {
    // A single authorization captured in two partial captures produces two
    // separate PSP settlement transactions that both carry the original
    // pspTransactionId — naively keying by id would silently keep only the
    // last one and compare against a fraction of what was actually settled.
    const payment = makePayment({ pspTransactionId: 'pi_partial', amount: Money.of(100, 'USD') });
    paymentRepository.findByProviderAndDateRange.mockResolvedValue([payment]);
    fetchSettlementTransactions.mockResolvedValue([
      makeSettlement({ pspTransactionId: 'pi_partial', amount: Money.of(40, 'USD') }),
      makeSettlement({ pspTransactionId: 'pi_partial', amount: Money.of(60, 'USD') }),
    ]);

    const run = await service.reconcile('STRIPE', since, until);

    expect(run.status).toBe('CLEAN');
    expect(run.mismatches).toHaveLength(0);
  });

  it('still flags AMOUNT_MISMATCH when the summed partial-capture settlements do not add up to our total', async () => {
    const payment = makePayment({ pspTransactionId: 'pi_partial2', amount: Money.of(100, 'USD') });
    paymentRepository.findByProviderAndDateRange.mockResolvedValue([payment]);
    fetchSettlementTransactions.mockResolvedValue([
      makeSettlement({ pspTransactionId: 'pi_partial2', amount: Money.of(40, 'USD') }),
      makeSettlement({ pspTransactionId: 'pi_partial2', amount: Money.of(50, 'USD') }), // sums to 90, not 100
    ]);

    const run = await service.reconcile('STRIPE', since, until);

    expect(run.status).toBe('MISMATCHES_FOUND');
    expect(run.mismatches).toHaveLength(1);
    expect(run.mismatches[0].type).toBe('AMOUNT_MISMATCH');
    expect(run.mismatches[0].actualAmount?.equals(Money.of(90, 'USD'))).toBe(true);
  });

  it('skips a payment with no pspTransactionId rather than crashing the run', async () => {
    // Shouldn't happen for the charged statuses findByProviderAndDateRange
    // returns, but ReconciliationService defends against it rather than
    // letting one bad record take down the whole run.
    const payment = PaymentAggregate.reconstitute({
      id: randomUUID(),
      amount: Money.of(50, 'USD'),
      status: PaymentStatus.SUCCEEDED,
      idempotencyKey: randomUUID(),
      metadata: { merchantId: 'merchant_1' },
      pspProvider: 'STRIPE',
      pspTransactionId: undefined,
    });
    paymentRepository.findByProviderAndDateRange.mockResolvedValue([payment]);
    fetchSettlementTransactions.mockResolvedValue([]);

    const run = await service.reconcile('STRIPE', since, until);

    expect(run.mismatches).toHaveLength(0);
    expect(run.status).toBe('CLEAN');
  });

  it('checks multiple independent payments/settlements together, each judged on its own', async () => {
    const clean = makePayment({ pspTransactionId: 'pi_clean', amount: Money.of(10, 'USD') });
    const missing = makePayment({ pspTransactionId: 'pi_missing2', amount: Money.of(20, 'USD') });
    const mismatched = makePayment({ pspTransactionId: 'pi_bad', amount: Money.of(30, 'USD') });
    paymentRepository.findByProviderAndDateRange.mockResolvedValue([clean, missing, mismatched]);
    fetchSettlementTransactions.mockResolvedValue([
      makeSettlement({ pspTransactionId: 'pi_clean', amount: Money.of(10, 'USD') }),
      makeSettlement({ pspTransactionId: 'pi_bad', amount: Money.of(35, 'USD') }),
      makeSettlement({ pspTransactionId: 'pi_orphan2', amount: Money.of(5, 'USD') }),
    ]);

    const run = await service.reconcile('STRIPE', since, until);

    expect(run.status).toBe('MISMATCHES_FOUND');
    const types = run.mismatches.map((m) => m.type).sort();
    expect(types).toEqual(['AMOUNT_MISMATCH', 'MISSING_AT_PSP', 'UNKNOWN_AT_PSP']);
    expect(run.transactionsChecked).toBe(6); // 3 of ours + 3 PSP settlement records
  });

  it('persists the run and records the requested window even when clean', async () => {
    paymentRepository.findByProviderAndDateRange.mockResolvedValue([]);
    fetchSettlementTransactions.mockResolvedValue([]);

    const run = await service.reconcile('ADYEN', since, until);

    expect(run.pspProvider).toBe('ADYEN');
    expect(run.windowStart).toEqual(since);
    expect(run.windowEnd).toEqual(until);
    expect(reconciliationRepo.save).toHaveBeenCalledTimes(1);
  });

  describe('runScheduled', () => {
    it('reconciles every configured provider for a rolling one-hour window', async () => {
      paymentRepository.findByProviderAndDateRange.mockResolvedValue([]);
      fetchSettlementTransactions.mockResolvedValue([]);

      await service.runScheduled();

      expect(paymentRepository.findByProviderAndDateRange).toHaveBeenCalledWith('STRIPE', expect.any(Date), expect.any(Date));
      expect(paymentRepository.findByProviderAndDateRange).toHaveBeenCalledWith('ADYEN', expect.any(Date), expect.any(Date));
      expect(reconciliationRepo.save).toHaveBeenCalledTimes(2);
    });

    it('one provider failing does not stop the other from being reconciled', async () => {
      paymentRepository.findByProviderAndDateRange.mockImplementation(async (provider) => {
        if (provider === 'STRIPE') throw new Error('Stripe settlement API unreachable');
        return [];
      });
      fetchSettlementTransactions.mockResolvedValue([]);

      await expect(service.runScheduled()).resolves.toBeUndefined();

      // ADYEN still got its own run recorded even though STRIPE's threw.
      expect(reconciliationRepo.save).toHaveBeenCalledTimes(1);
      expect(reconciliationRepo.save).toHaveBeenCalledWith(expect.objectContaining({ pspProvider: 'ADYEN' }));
    });
  });
});
