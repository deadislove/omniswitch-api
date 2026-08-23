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

describe('PaymentProcessorFactory.executeWithFallback — ambiguous outcome propagation (Gap 1.2)', () => {
  const context: RoutingContext = {
    amount: Money.of(10, 'USD'),
    merchantId: 'merchant_1',
    preferredProvider: 'STRIPE',
  };

  it('tags the aggregate "all providers failed" error as ambiguous when the only attempt was a timeout', async () => {
    // ADYEN's own circuit is OPEN, so there's no viable fallback — the
    // primary's (STRIPE's) outcome is also the last outcome.
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN', 'OPEN');
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const timeoutError = Object.assign(
      new Error('Stripe request failed with no response: timeout'),
      { isAmbiguousOutcome: true },
    );
    const operation = jest.fn().mockRejectedValue(timeoutError);

    const err: any = await factory.executeWithFallback(context, operation).catch((e) => e);

    expect(err.message).toContain('All PSP providers failed');
    expect(err.isAmbiguousOutcome).toBe(true);
  });

  it('does not tag the aggregate error when the only attempt was an explicit decline', async () => {
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN', 'OPEN');
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const declineError = Object.assign(new Error('card_declined'), { code: 'card_declined', statusCode: 402 });
    const operation = jest.fn().mockRejectedValue(declineError);

    const err: any = await factory.executeWithFallback(context, operation).catch((e) => e);

    expect(err.isAmbiguousOutcome).toBe(false);
  });

  it('reflects the LAST attempted provider\'s outcome, not the first, when primary is ambiguous but the fallback explicitly declines', async () => {
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN'); // healthy, viable fallback
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const timeoutError = Object.assign(new Error('timeout'), { isAmbiguousOutcome: true });
    const declineError = Object.assign(new Error('declined'), { code: 'card_declined' });

    const operation = jest.fn()
      .mockRejectedValueOnce(timeoutError) // primary (STRIPE)
      .mockRejectedValueOnce(declineError); // fallback (ADYEN)

    const err: any = await factory.executeWithFallback(context, operation).catch((e) => e);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(err.isAmbiguousOutcome).toBe(false);
  });

  it('reflects an ambiguous fallback outcome even when the primary was a clear decline', async () => {
    const stripe = makeFakeAdapter('STRIPE');
    const adyen = makeFakeAdapter('ADYEN');
    const factory = new PaymentProcessorFactory(stripe as any, adyen as any);

    const declineError = Object.assign(new Error('declined'), { code: 'card_declined' });
    const timeoutError = Object.assign(new Error('timeout'), { isAmbiguousOutcome: true });

    const operation = jest.fn()
      .mockRejectedValueOnce(declineError) // primary (STRIPE)
      .mockRejectedValueOnce(timeoutError); // fallback (ADYEN)

    const err: any = await factory.executeWithFallback(context, operation).catch((e) => e);

    expect(err.isAmbiguousOutcome).toBe(true);
  });
});
