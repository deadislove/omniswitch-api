import { PaymentProcessorFactory, isAmbiguousOutcomeError } from './payment-processor.factory';
import { RoutingContext } from '../../domain/services/smart-routing.strategy';
import { Money } from '../../domain/value-objects/money.vo';

function makeFakeAdapter(provider: 'STRIPE' | 'ADYEN', circuitState: 'CLOSED' | 'OPEN' = 'CLOSED') {
  return {
    provider,
    getHealthStatus: jest.fn().mockResolvedValue({
      provider,
      circuitBreakerState: circuitState,
      successRate: 100,
      avgLatencyMs: 50,
      feePercentage: 2.9,
      fixedFeeMinorUnits: 30,
      supportedCurrencies: ['USD'],
      supportedCountries: ['*'],
      isAvailable: circuitState !== 'OPEN',
    }),
    isAvailable: jest.fn().mockResolvedValue(circuitState !== 'OPEN'),
  };
}

describe('isAmbiguousOutcomeError', () => {
  it('is true for a tagged error', () => {
    expect(isAmbiguousOutcomeError(Object.assign(new Error('x'), { isAmbiguousOutcome: true }))).toBe(true);
  });

  it('is false for an untagged error, and for non-error values', () => {
    expect(isAmbiguousOutcomeError(new Error('x'))).toBe(false);
    expect(isAmbiguousOutcomeError('plain string')).toBe(false);
    expect(isAmbiguousOutcomeError(null)).toBe(false);
    expect(isAmbiguousOutcomeError(undefined)).toBe(false);
  });
});

describe('PaymentProcessorFactory.executeWithFallback', () => {
  const context: RoutingContext = {
    amount: Money.of(10, 'USD'),
    merchantId: 'merchant_1',
    preferredProvider: 'STRIPE',
  };

  const timeoutError = () => Object.assign(new Error('Stripe request failed with no response: timeout'), { isAmbiguousOutcome: true });
  const declineError = () => Object.assign(new Error('card_declined'), { code: 'card_declined', statusCode: 402 });

  it('primary succeeds: no retry, no fallback', async () => {
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN');
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const operation = jest.fn().mockResolvedValue({ ok: true });

    const result = await factory.executeWithFallback(context, operation);

    expect(result).toEqual({ result: { ok: true }, provider: 'STRIPE', usedFallback: false });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(adyen.isAvailable).not.toHaveBeenCalled();
  });

  it('primary ambiguous, same-provider retry succeeds: fallback is never touched', async () => {
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN');
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const operation = jest.fn()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({ ok: true });

    const result = await factory.executeWithFallback(context, operation);

    expect(result).toEqual({ result: { ok: true }, provider: 'STRIPE', usedFallback: false });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(adyen.isAvailable).not.toHaveBeenCalled();
  });

  it('primary ambiguous, retry also ambiguous: throws isAmbiguousOutcome without ever attempting a fallback', async () => {
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN');
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const operation = jest.fn().mockRejectedValue(timeoutError());

    const err: any = await factory.executeWithFallback(context, operation).catch((e) => e);

    expect(err.isAmbiguousOutcome).toBe(true);
    expect(err.message).toContain('remains ambiguous after one retry');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(adyen.isAvailable).not.toHaveBeenCalled();
  });

  it('primary ambiguous, retry resolves to an explicit decline: falls back and succeeds', async () => {
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN');
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const operation = jest.fn()
      .mockRejectedValueOnce(timeoutError()) // primary attempt
      .mockRejectedValueOnce(declineError()) // same-provider retry
      .mockResolvedValueOnce({ ok: true }); // fallback

    const result = await factory.executeWithFallback(context, operation);

    expect(result).toEqual({ result: { ok: true }, provider: 'ADYEN', usedFallback: true });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('primary explicit decline, no viable fallback: fails without any retry', async () => {
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN', 'OPEN');
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const operation = jest.fn().mockRejectedValue(declineError());

    const err: any = await factory.executeWithFallback(context, operation).catch((e) => e);

    expect(err.message).toContain('All PSP providers failed');
    expect(err.isAmbiguousOutcome).toBe(false);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('reflects an ambiguous fallback outcome in the aggregate error', async () => {
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN');
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const operation = jest.fn()
      .mockRejectedValueOnce(declineError()) // primary (STRIPE) — explicit decline, no retry triggered
      .mockRejectedValueOnce(timeoutError()); // fallback (ADYEN) — ambiguous

    const err: any = await factory.executeWithFallback(context, operation).catch((e) => e);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(err.isAmbiguousOutcome).toBe(true);
  });
});
