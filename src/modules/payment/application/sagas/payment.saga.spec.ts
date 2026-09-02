/**
 * Payment Checkout Saga - Unit Tests
 * Tests compensating transactions when external PSP responds with timeout.
 *
 * Validates:
 * 1. Saga creates payment intent atomically with ledger outbox
 * 2. Compensating transaction fires when PSP times out
 * 3. Payment is marked FAILED with correct error code
 * 4. Domain events are published correctly
 * 5. Fallback PSP is tried before compensation
 */

import { PaymentCheckoutSaga, CheckoutSagaInput } from './payment-checkout.saga';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { AcquirerRoutingService } from '../services/acquirer-routing.service';
import { PaymentAggregate } from '../../domain/aggregates/payment.aggregate';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { BinInfo, CardBrand, CardType } from '../../domain/value-objects/bin-info.vo';
import { ChargeLedgerParamsResolverService } from '../services/charge-ledger-params-resolver.service';

// ─── Mock Factories ──────────────────────────────────────────────────────────

const createMockPaymentRepository = (): jest.Mocked<PaymentRepositoryPort> => ({
  save: jest.fn().mockResolvedValue(undefined),
  findById: jest.fn(),
  findByIdOnMaster: jest.fn(),
  findByIdempotencyKey: jest.fn(),
  findByPspTransactionId: jest.fn(),
  findByMerchantId: jest.fn(),
  update: jest.fn().mockResolvedValue(undefined),
  existsById: jest.fn(),
  count: jest.fn(),
  findByProviderAndDateRange: jest.fn(),
  countByStatusAndProvider: jest.fn(),
  sumSucceededVolumeSince: jest.fn(),
  findAmbiguousOlderThan: jest.fn(),
  countAmbiguousIncidentsSince: jest.fn(),
  findRecentAmbiguousFlags: jest.fn(),
  findAmbiguousEligibleForAutoResolution: jest.fn(),
});

const createMockLedgerOutbox = (): jest.Mocked<LedgerOutboxPort> => ({
  saveWithPayment: jest.fn().mockResolvedValue(undefined),
  findPending: jest.fn(),
  markPublished: jest.fn(),
  markFailed: jest.fn(),
  findStale: jest.fn(),
  findById: jest.fn(),
  findFailed: jest.fn(),
  resetToPending: jest.fn(),
  countByStatus: jest.fn(),
  findCreatedBetween: jest.fn(),
});

const createMockAcquirerRouting = (): jest.Mocked<AcquirerRoutingService> => ({
  selectOptimalAdapter: jest.fn(),
  executeWithSmartRouting: jest.fn(),
  getPSPHealthSummary: jest.fn(),
} as any);

const createMockDataSource = () => ({
  transaction: jest.fn().mockImplementation(async (cb: any) => {
    const mockManager = {
      save: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue({
        save: jest.fn().mockResolvedValue(undefined),
      }),
    };
    return cb(mockManager);
  }),
});

const createMockEventEmitter = () => ({
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
});

const createMockMerchantService = () => ({
  findByMerchantId: jest.fn().mockResolvedValue({ platformFeeBps: 150 }),
});

const createMockFxRateProvider = () => ({
  getRate: jest.fn().mockResolvedValue({ rate: 1, provider: 'mock' }),
});

const createMockReserveService = () => ({
  recordHold: jest.fn().mockResolvedValue(undefined),
});

const createMockAmbiguousRiskMonitoring = () => ({
  evaluate: jest.fn().mockResolvedValue(undefined),
});

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const createSagaInput = (overrides: Partial<CheckoutSagaInput> = {}): CheckoutSagaInput => ({
  paymentId: 'pay_test_001',
  idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
  amount: Money.of(99.99, 'USD'),
  merchantId: 'merchant_test_001',
  customerId: 'cust_001',
  orderId: 'order_001',
  description: 'Test payment',
  ...overrides,
});

const createEuropeanBinInfo = () => new BinInfo({
  bin: '491761',
  country: 'DE',
  cardBrand: CardBrand.VISA,
  cardType: CardType.CREDIT,
  issuingBank: 'Deutsche Bank',
});

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('PaymentCheckoutSaga', () => {
  let saga: PaymentCheckoutSaga;
  let paymentRepository: jest.Mocked<PaymentRepositoryPort>;
  let ledgerOutbox: jest.Mocked<LedgerOutboxPort>;
  let acquirerRouting: jest.Mocked<AcquirerRoutingService>;
  let dataSource: any;
  let eventEmitter: any;
  let merchantService: any;
  let fxRateProvider: any;
  let reserveService: any;
  let ambiguousRiskMonitoring: any;

  beforeEach(() => {
    paymentRepository = createMockPaymentRepository();
    ledgerOutbox = createMockLedgerOutbox();
    acquirerRouting = createMockAcquirerRouting();
    dataSource = createMockDataSource();
    eventEmitter = createMockEventEmitter();
    merchantService = createMockMerchantService();
    fxRateProvider = createMockFxRateProvider();
    reserveService = createMockReserveService();
    ambiguousRiskMonitoring = createMockAmbiguousRiskMonitoring();

    saga = new PaymentCheckoutSaga(
      paymentRepository,
      ledgerOutbox,
      acquirerRouting,
      dataSource,
      eventEmitter,
      new ChargeLedgerParamsResolverService(merchantService, fxRateProvider, paymentRepository),
      reserveService,
      ambiguousRiskMonitoring,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── Happy Path ─────────────────────────────────────────────────────────────

  describe('Happy Path - Successful Payment', () => {
    it('should complete payment successfully via Stripe', async () => {
      const input = createSagaInput();

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'STRIPE',
          fallbackProviders: ['ADYEN'],
          estimatedFee: Money.of(3.20, 'USD'),
          routingReason: 'Selected STRIPE (score: 85)',
          score: 85,
        },
      });

      acquirerRouting.executeWithSmartRouting.mockResolvedValue({
        result: {
          success: true,
          transactionId: 'pi_stripe_test_001',
          status: 'SUCCEEDED',
          rawResponse: { id: 'pi_stripe_test_001', status: 'succeeded' },
        },
        provider: 'STRIPE',
        usedFallback: false,
      });

      const result = await saga.execute(input);

      expect(result.status).toBe(PaymentStatus.SUCCEEDED);
      expect(result.pspTransactionId).toBe('pi_stripe_test_001');
      expect(result.pspProvider).toBe('STRIPE');
      expect(result.requiresAction).toBe(false);
      expect(result.usedFallback).toBe(false);
      expect(paymentRepository.save).toHaveBeenCalledTimes(1); // Step 1: PENDING intent, no ledger entry yet
      expect(paymentRepository.update).toHaveBeenCalledTimes(1); // PROCESSING
      // SUCCEEDED is written via dataSource.transaction (atomic with the ledger entry), not paymentRepository.update
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('should write the ledger outbox entry atomically with the SUCCEEDED transition, not at intent creation', async () => {
      const input = createSagaInput();

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'STRIPE',
          fallbackProviders: [],
          estimatedFee: Money.of(3.20, 'USD'),
          routingReason: 'Selected STRIPE',
          score: 80,
        },
      });

      acquirerRouting.executeWithSmartRouting.mockResolvedValue({
        result: { success: true, transactionId: 'pi_001', status: 'SUCCEEDED', rawResponse: {} },
        provider: 'STRIPE',
        usedFallback: false,
      });

      await saga.execute(input);

      // The ledger entry is written inside dataSource.transaction, which is
      // only invoked once the charge is confirmed SUCCEEDED — not at Step 1
      // (payment intent creation uses paymentRepository.save(), not a
      // transaction). The old behavior double-booked a PAYMENT_CHARGED
      // entry for manual-capture payments (once at authorization, once at
      // capture) — this regression test guards against that.
      expect(paymentRepository.save).toHaveBeenCalledTimes(1);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      const transactionCallback = dataSource.transaction.mock.calls[0][0];
      expect(typeof transactionCallback).toBe('function');
    });

    it('should NOT write any ledger entry when routing fails before a PSP is ever contacted', async () => {
      const input = createSagaInput();

      acquirerRouting.selectOptimalAdapter.mockRejectedValue(
        new Error('No available PSP providers for currency USD'),
      );

      await expect(saga.execute(input)).rejects.toThrow('No available PSP');

      // Step 1 only saves the PENDING intent; no charge was ever attempted,
      // so dataSource.transaction (which is where the ledger entry is
      // written) must never be called.
      expect(paymentRepository.save).toHaveBeenCalledTimes(1);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  // ─── PSP Timeout / Compensating Transaction ─────────────────────────────────

  describe('Compensating Transactions - PSP Timeout', () => {
    it('should mark payment FAILED when PSP times out (all providers)', async () => {
      const input = createSagaInput();

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'STRIPE',
          fallbackProviders: ['ADYEN'],
          estimatedFee: Money.of(3.20, 'USD'),
          routingReason: 'Selected STRIPE',
          score: 80,
        },
      });

      // Simulate PSP timeout - all providers fail
      const timeoutError = new Error('PSP request timed out after 30000ms');
      timeoutError.name = 'TimeoutError';
      acquirerRouting.executeWithSmartRouting.mockRejectedValue(
        new Error('All PSP providers failed. Primary: STRIPE. Fallbacks tried: [ADYEN]'),
      );

      await expect(saga.execute(input)).rejects.toThrow('All PSP providers failed');

      // Verify compensating transaction was executed
      expect(paymentRepository.update).toHaveBeenCalled();

      // Find the update call that marks payment as FAILED
      const updateCalls = paymentRepository.update.mock.calls;
      const failedUpdate = updateCalls.find((call) => {
        const payment = call[0] as PaymentAggregate;
        return payment.status === PaymentStatus.FAILED;
      });

      expect(failedUpdate).toBeDefined();
    });

    it('should publish PaymentFailedEvent when PSP times out', async () => {
      const input = createSagaInput();

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'STRIPE',
          fallbackProviders: [],
          estimatedFee: Money.of(3.20, 'USD'),
          routingReason: 'Selected STRIPE',
          score: 80,
        },
      });

      acquirerRouting.executeWithSmartRouting.mockRejectedValue(
        new Error('Connection timeout: STRIPE'),
      );

      await expect(saga.execute(input)).rejects.toThrow();

      // Verify domain events were emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.failed',
        expect.objectContaining({
          paymentId: input.paymentId,
        }),
      );
    });

    it('should mark payment FAILED when routing finds no available PSP', async () => {
      const input = createSagaInput();

      acquirerRouting.selectOptimalAdapter.mockRejectedValue(
        new Error('No available PSP providers for currency USD'),
      );

      await expect(saga.execute(input)).rejects.toThrow('No available PSP');

      // Compensating transaction should still fire
      const updateCalls = paymentRepository.update.mock.calls;
      const failedUpdate = updateCalls.find((call) => {
        const payment = call[0] as PaymentAggregate;
        return payment.status === PaymentStatus.FAILED;
      });
      expect(failedUpdate).toBeDefined();
    });

    it('should use fallback PSP when primary times out', async () => {
      const input = createSagaInput();

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'STRIPE',
          fallbackProviders: ['ADYEN'],
          estimatedFee: Money.of(3.20, 'USD'),
          routingReason: 'Selected STRIPE',
          score: 80,
        },
      });

      // Stripe times out, Adyen succeeds
      acquirerRouting.executeWithSmartRouting.mockResolvedValue({
        result: {
          success: true,
          transactionId: 'adyen_psp_ref_001',
          status: 'SUCCEEDED',
          rawResponse: { pspReference: 'adyen_psp_ref_001', resultCode: 'Authorised' },
        },
        provider: 'ADYEN',
        usedFallback: true,
      });

      const result = await saga.execute(input);

      expect(result.status).toBe(PaymentStatus.SUCCEEDED);
      expect(result.pspProvider).toBe('ADYEN');
      expect(result.usedFallback).toBe(true);
    });
  });

  // ─── 3DS / SCA Flow ─────────────────────────────────────────────────────────

  describe('3DS / SCA Risk Assessment', () => {
    // Regression test: this saga used to short-circuit high-risk-score
    // payments *before* ever calling the PSP, fabricating a
    // `3ds.omniswitch.io` URL that resolved to nothing and had no real
    // pspTransactionId — meaning the payment could never be resolved by any
    // webhook. The fix was to always call the PSP and let *its* response
    // decide REQUIRES_ACTION, same as Stripe/Adyen actually behave. This
    // test would fail if that short-circuit ever came back: it asserts the
    // PSP was actually invoked and that the resulting pspTransactionId is
    // the real one the (mocked) PSP returned, not a fabricated one.
    it('should call the PSP and use its REQUIRES_ACTION response for a high-risk European card, not a pre-emptive redirect', async () => {
      const input = createSagaInput({
        amount: Money.of(15000, 'EUR'), // High value: crosses the >10,000 major-unit tier in calculateRiskScore()
        binInfo: createEuropeanBinInfo(),
      });

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'ADYEN',
          fallbackProviders: ['STRIPE'],
          estimatedFee: Money.of(15, 'EUR'),
          routingReason: 'Selected ADYEN (EU card)',
          score: 90,
        },
      });

      acquirerRouting.executeWithSmartRouting.mockResolvedValue({
        result: {
          success: false,
          transactionId: 'adyen_mock_challenge_001',
          status: 'REQUIRES_ACTION',
          actionUrl: 'https://mock-psp.local/3ds/adyen_mock_challenge_001',
          rawResponse: { resultCode: 'RedirectShopper' },
        },
        provider: 'ADYEN',
        usedFallback: false,
      });

      const result = await saga.execute(input);

      expect(acquirerRouting.executeWithSmartRouting).toHaveBeenCalled();
      expect(result.requiresAction).toBe(true);
      expect(result.status).toBe(PaymentStatus.REQUIRES_ACTION);
      expect(result.pspTransactionId).toBe('adyen_mock_challenge_001');
      expect(result.actionUrl).toBe('https://mock-psp.local/3ds/adyen_mock_challenge_001');
      expect(result.riskScore).toBeGreaterThanOrEqual(50);
    });

    it('should still succeed a high-risk European card if the PSP does not actually challenge it', async () => {
      // A high risk score no longer guarantees REQUIRES_ACTION on its own —
      // only the PSP's real response does. This covers the other half of
      // the regression: risk score must inform, not decide.
      const input = createSagaInput({
        amount: Money.of(15000, 'EUR'),
        binInfo: createEuropeanBinInfo(),
      });

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'ADYEN',
          fallbackProviders: ['STRIPE'],
          estimatedFee: Money.of(15, 'EUR'),
          routingReason: 'Selected ADYEN (EU card)',
          score: 90,
        },
      });

      acquirerRouting.executeWithSmartRouting.mockResolvedValue({
        result: {
          success: true,
          transactionId: 'adyen_mock_authorised_001',
          status: 'SUCCEEDED',
          rawResponse: { resultCode: 'Authorised' },
        },
        provider: 'ADYEN',
        usedFallback: false,
      });

      const result = await saga.execute(input);

      expect(result.requiresAction).toBe(false);
      expect(result.status).toBe(PaymentStatus.SUCCEEDED);
      expect(result.riskScore).toBeGreaterThanOrEqual(50);
    });

    it('should process frictionless for low-risk US card', async () => {
      const input = createSagaInput({
        amount: Money.of(25, 'USD'), // Low value
        binInfo: new BinInfo({
          bin: '424242',
          country: 'US',
          cardBrand: CardBrand.VISA,
          cardType: CardType.CREDIT,
        }),
      });

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'STRIPE',
          fallbackProviders: ['ADYEN'],
          estimatedFee: Money.of(1.03, 'USD'),
          routingReason: 'Selected STRIPE (US card)',
          score: 85,
        },
      });

      acquirerRouting.executeWithSmartRouting.mockResolvedValue({
        result: {
          success: true,
          transactionId: 'pi_frictionless_001',
          status: 'SUCCEEDED',
          rawResponse: {},
        },
        provider: 'STRIPE',
        usedFallback: false,
      });

      const result = await saga.execute(input);

      expect(result.requiresAction).toBe(false);
      expect(result.status).toBe(PaymentStatus.SUCCEEDED);
    });
  });

  // ─── Idempotency ─────────────────────────────────────────────────────────────

  describe('Idempotency', () => {
    it('should create payment with correct idempotency key', async () => {
      const input = createSagaInput({
        idempotencyKey: 'test-idempotency-key-12345',
      });

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'STRIPE',
          fallbackProviders: [],
          estimatedFee: Money.of(3.20, 'USD'),
          routingReason: 'Selected STRIPE',
          score: 80,
        },
      });

      acquirerRouting.executeWithSmartRouting.mockResolvedValue({
        result: { success: true, transactionId: 'pi_001', status: 'SUCCEEDED', rawResponse: {} },
        provider: 'STRIPE',
        usedFallback: false,
      });

      await saga.execute(input);

      // Verify the payment was saved with the correct idempotency key
      const transactionFn = dataSource.transaction.mock.calls[0][0];
      const mockManager = { save: jest.fn(), getRepository: jest.fn().mockReturnValue({ save: jest.fn() }) };
      await transactionFn(mockManager);

      const savedEntity = mockManager.save.mock.calls[0][0];
      expect(savedEntity.idempotencyKey).toBe('test-idempotency-key-12345');
    });
  });

  // ─── Money Value Object ──────────────────────────────────────────────────────

  describe('Money Value Object - Multi-Currency', () => {
    it('should handle JPY (zero-decimal currency) correctly', () => {
      const jpy = Money.of(1000, 'JPY');
      expect(jpy.amountMinorUnits).toBe(1000n);
      expect(jpy.currency.minorUnits).toBe(0);
      expect(jpy.amount).toBe(1000);
    });

    it('should handle USD (2-decimal currency) correctly', () => {
      const usd = Money.of(99.99, 'USD');
      expect(usd.amountMinorUnits).toBe(9999n);
      expect(usd.currency.minorUnits).toBe(2);
      expect(usd.amount).toBe(99.99);
    });

    it('should handle KWD (3-decimal currency) correctly', () => {
      const kwd = Money.of(10.500, 'KWD');
      expect(kwd.amountMinorUnits).toBe(10500n);
      expect(kwd.currency.minorUnits).toBe(3);
    });

    it('should prevent currency mismatch in arithmetic', () => {
      const usd = Money.of(100, 'USD');
      const eur = Money.of(100, 'EUR');
      expect(() => usd.add(eur)).toThrow('Currency mismatch');
    });

    it('should convert currency using FX rate snapshot', () => {
      const usd = Money.of(100, 'USD');
      const eur = usd.convertTo('EUR', 0.92, 'ECB');
      expect(eur.currency.code).toBe('EUR');
      expect(eur.amount).toBeCloseTo(92, 1);
      expect(eur.fxSnapshot?.rate).toBe(0.92);
      expect(eur.fxSnapshot?.provider).toBe('ECB');
    });

    it('should prevent negative money creation', () => {
      expect(() => Money.fromMinorUnits(-1n, 'USD')).toThrow('cannot be negative');
    });
  });

  // ─── Domain Events ───────────────────────────────────────────────────────────

  describe('Domain Events', () => {
    it('should emit PaymentStatusChangedEvent on each status transition', async () => {
      const input = createSagaInput();

      acquirerRouting.selectOptimalAdapter.mockResolvedValue({
        adapter: {} as any,
        decision: {
          selectedProvider: 'STRIPE',
          fallbackProviders: [],
          estimatedFee: Money.of(3.20, 'USD'),
          routingReason: 'Selected STRIPE',
          score: 80,
        },
      });

      acquirerRouting.executeWithSmartRouting.mockResolvedValue({
        result: { success: true, transactionId: 'pi_001', status: 'SUCCEEDED', rawResponse: {} },
        provider: 'STRIPE',
        usedFallback: false,
      });

      await saga.execute(input);

      // Should emit status change events
      const emitCalls = eventEmitter.emit.mock.calls.map((c: any) => c[0]);
      expect(emitCalls).toContain('payment.status.changed');
      expect(emitCalls).toContain('payment.intent.created');
      expect(emitCalls).toContain('payment.charged');
    });
  });
});
