import { SmartRoutingStrategy, RoutingContext, PSPHealthStatus, CircuitBreakerState, PreferredProviderNotEntitledError } from './smart-routing.strategy';
import { Money } from '../value-objects/money.vo';
import { BinInfo, CardBrand, CardType } from '../value-objects/bin-info.vo';
import { PSPProvider } from '../aggregates/payment.aggregate';

const US_BIN = new BinInfo({ bin: '424242', country: 'US', cardBrand: CardBrand.VISA, cardType: CardType.CREDIT });
const EU_BIN = new BinInfo({ bin: '424243', country: 'DE', cardBrand: CardBrand.VISA, cardType: CardType.CREDIT });

function health(overrides: Partial<PSPHealthStatus> & { provider: PSPProvider }): PSPHealthStatus {
  return {
    circuitBreakerState: 'CLOSED' as CircuitBreakerState,
    successRate: 100,
    avgLatencyMs: 50,
    feePercentage: 2.9,
    fixedFeeMinorUnits: 30,
    supportedCurrencies: ['USD', 'EUR'],
    supportedCountries: ['*'],
    isAvailable: true,
    ...overrides,
  };
}

function healthMap(...statuses: PSPHealthStatus[]): Map<PSPProvider, PSPHealthStatus> {
  return new Map(statuses.map((s) => [s.provider, s]));
}

describe('SmartRoutingStrategy.selectProvider — preferredProvider override', () => {
  const strategy = new SmartRoutingStrategy();
  const baseContext: RoutingContext = {
    amount: Money.of(10, 'USD'),
    merchantId: 'merchant_1',
  };

  it('selects preferredProvider directly, even when it scores worse than the alternative', async () => {
    // ADYEN scores strictly better on every dimension (higher success
    // rate, lower latency, lower fee) — under the old +20-bonus scoring
    // model this could still lose to ADYEN. The override must select
    // STRIPE anyway.
    const map = healthMap(
      health({ provider: 'STRIPE', successRate: 80, avgLatencyMs: 500, feePercentage: 5 }),
      health({ provider: 'ADYEN', successRate: 100, avgLatencyMs: 20, feePercentage: 1 }),
    );

    const decision = strategy.selectProvider({ ...baseContext, preferredProvider: 'STRIPE' }, map);

    expect(decision.selectedProvider).toBe('STRIPE');
    expect(decision.routingReason).toContain('explicit preferredProvider override');
  });

  it('lists the remaining providers as fallbacks, sorted by score', async () => {
    const map = healthMap(
      health({ provider: 'STRIPE' }),
      health({ provider: 'ADYEN', successRate: 100, avgLatencyMs: 10 }),
    );

    const decision = strategy.selectProvider({ ...baseContext, preferredProvider: 'STRIPE' }, map);

    expect(decision.selectedProvider).toBe('STRIPE');
    expect(decision.fallbackProviders).toEqual(['ADYEN']);
  });

  it('falls through to normal scoring when the preferred provider fails the availability filter', async () => {
    const map = healthMap(
      health({ provider: 'STRIPE', circuitBreakerState: 'OPEN', isAvailable: false }),
      health({ provider: 'ADYEN' }),
    );

    const decision = strategy.selectProvider({ ...baseContext, preferredProvider: 'STRIPE' }, map);

    expect(decision.selectedProvider).toBe('ADYEN');
    expect(decision.routingReason).not.toContain('override');
  });

  it('falls through to normal scoring when the preferred provider does not support the currency', async () => {
    const map = healthMap(
      health({ provider: 'STRIPE', supportedCurrencies: ['EUR'] }),
      health({ provider: 'ADYEN', supportedCurrencies: ['USD', 'EUR'] }),
    );

    const decision = strategy.selectProvider({ ...baseContext, preferredProvider: 'STRIPE' }, map);

    expect(decision.selectedProvider).toBe('ADYEN');
  });

  it('with no preferredProvider set, picks the highest-scoring available provider as before', async () => {
    const map = healthMap(
      health({ provider: 'STRIPE', successRate: 50 }),
      health({ provider: 'ADYEN', successRate: 100 }),
    );

    const decision = strategy.selectProvider(baseContext, map);

    expect(decision.selectedProvider).toBe('ADYEN');
  });

  it('still applies the EU-card/Adyen and non-EU-card/Stripe geographic nudges when no preference overrides them', async () => {
    const map = healthMap(health({ provider: 'STRIPE' }), health({ provider: 'ADYEN' }));

    const euDecision = strategy.selectProvider({ ...baseContext, binInfo: EU_BIN }, map);
    expect(euDecision.selectedProvider).toBe('ADYEN');

    const usDecision = strategy.selectProvider({ ...baseContext, binInfo: US_BIN }, map);
    expect(usDecision.selectedProvider).toBe('STRIPE');
  });

  it('preferredProvider overrides the geographic nudge too — an EU card explicitly preferring STRIPE still gets STRIPE', async () => {
    const map = healthMap(health({ provider: 'STRIPE' }), health({ provider: 'ADYEN' }));

    const decision = strategy.selectProvider(
      { ...baseContext, binInfo: EU_BIN, preferredProvider: 'STRIPE' },
      map,
    );

    expect(decision.selectedProvider).toBe('STRIPE');
  });

  it('throws when no provider is available at all, preference or not', async () => {
    const map = healthMap(
      health({ provider: 'STRIPE', isAvailable: false }),
      health({ provider: 'ADYEN', isAvailable: false }),
    );

    expect(() => strategy.selectProvider({ ...baseContext, preferredProvider: 'STRIPE' }, map)).toThrow(
      'No available PSP providers',
    );
  });
});

describe('SmartRoutingStrategy.selectProvider — per-merchant PSP entitlement', () => {
  const strategy = new SmartRoutingStrategy();
  const baseContext: RoutingContext = {
    amount: Money.of(10, 'USD'),
    merchantId: 'merchant_1',
  };

  it('rejects (throws PreferredProviderNotEntitledError) when preferredProvider is outside entitledProviders, even though STRIPE itself is healthy and available', async () => {
    const map = healthMap(health({ provider: 'STRIPE' }), health({ provider: 'ADYEN' }));

    expect(() =>
      strategy.selectProvider({ ...baseContext, preferredProvider: 'STRIPE', entitledProviders: ['ADYEN'] }, map),
    ).toThrow(PreferredProviderNotEntitledError);
  });

  it('carries the rejected provider on the thrown error, not just a generic message', async () => {
    const map = healthMap(health({ provider: 'STRIPE' }), health({ provider: 'ADYEN' }));

    try {
      strategy.selectProvider({ ...baseContext, preferredProvider: 'STRIPE', entitledProviders: ['ADYEN'] }, map);
      fail('expected selectProvider to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PreferredProviderNotEntitledError);
      expect((err as PreferredProviderNotEntitledError).provider).toBe('STRIPE');
    }
  });

  it('excludes a non-entitled PSP from the general candidate pool when there is no preferredProvider', async () => {
    const map = healthMap(
      health({ provider: 'STRIPE', successRate: 100 }),
      health({ provider: 'ADYEN', successRate: 50 }),
    );

    // ADYEN would normally lose on score, but it's the only entitled PSP.
    const decision = strategy.selectProvider({ ...baseContext, entitledProviders: ['ADYEN'] }, map);

    expect(decision.selectedProvider).toBe('ADYEN');
    expect(decision.fallbackProviders).toEqual([]);
  });

  it('selects preferredProvider directly when it IS entitled, unaffected by the entitlement filter', async () => {
    const map = healthMap(health({ provider: 'STRIPE' }), health({ provider: 'ADYEN' }));

    const decision = strategy.selectProvider(
      { ...baseContext, preferredProvider: 'STRIPE', entitledProviders: ['STRIPE', 'ADYEN'] },
      map,
    );

    expect(decision.selectedProvider).toBe('STRIPE');
  });

  it('undefined entitledProviders means no restriction at all — matches pre-entitlement behavior', async () => {
    const map = healthMap(health({ provider: 'STRIPE' }), health({ provider: 'ADYEN' }));

    const decision = strategy.selectProvider({ ...baseContext, preferredProvider: 'STRIPE' }, map);

    expect(decision.selectedProvider).toBe('STRIPE');
  });
});
