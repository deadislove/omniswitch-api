import { StripePSPAdapter } from './stripe-psp.adapter';
import { RedisCircuitBreakerService } from '../../circuit-breaker/redis-circuit-breaker.service';
import { Money } from '../../../domain/value-objects/money.vo';
import { PSPChargeRequest } from '../../../ports/outbound/psp-adapter.port';

describe('StripePSPAdapter — ambiguous outcome tagging', () => {
  let adapter: StripePSPAdapter;
  let circuitBreaker: { assertAvailable: jest.Mock; recordSuccess: jest.Mock; recordFailure: jest.Mock };
  const originalFetch = global.fetch;

  const chargeRequest: PSPChargeRequest = {
    paymentId: 'pay_1',
    idempotencyKey: 'idem_1',
    amount: Money.of(10, 'USD'),
    currency: 'USD',
    merchantId: 'merchant_1',
  };

  beforeEach(() => {
    circuitBreaker = {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    const configService = { get: (_key: string, def?: string) => def } as any;
    adapter = new StripePSPAdapter(configService, circuitBreaker as unknown as RedisCircuitBreakerService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('tags a fetch()-level failure (timeout/network error, no response ever received) as isAmbiguousOutcome', async () => {
    global.fetch = jest.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError')) as any;

    const err: any = await adapter.charge(chargeRequest).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.isAmbiguousOutcome).toBe(true);
    expect(circuitBreaker.recordFailure).toHaveBeenCalledWith('STRIPE');
  });

  it('does NOT tag an explicit non-2xx PSP response (a real decline) as isAmbiguousOutcome', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: { message: 'Your card was declined.', code: 'card_declined', type: 'card_error' } }),
    }) as any;

    const err: any = await adapter.charge(chargeRequest).catch((e) => e);

    expect(err.isAmbiguousOutcome).toBeUndefined();
    expect(err.code).toBe('card_declined');
    expect(err.statusCode).toBe(402);
    expect(circuitBreaker.recordFailure).toHaveBeenCalledWith('STRIPE');
  });

  it('does not tag a successful response as ambiguous, and records success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'pi_123', status: 'succeeded' }),
    }) as any;

    const result = await adapter.charge(chargeRequest);

    expect(result.success).toBe(true);
    expect(result.status).toBe('SUCCEEDED');
    expect(circuitBreaker.recordSuccess).toHaveBeenCalled();
    expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
  });
});

describe('StripePSPAdapter — custom metadata forwarding', () => {
  let adapter: StripePSPAdapter;
  const originalFetch = global.fetch;

  beforeEach(() => {
    const circuitBreaker = {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    const configService = { get: (_key: string, def?: string) => def } as any;
    adapter = new StripePSPAdapter(configService, circuitBreaker as unknown as RedisCircuitBreakerService);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'pi_123', status: 'succeeded' }),
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('forwards ChargePaymentDto.metadata to Stripe as metadata[<key>] form fields', async () => {
    await adapter.charge({
      paymentId: 'pay_1',
      idempotencyKey: 'idem_1',
      amount: Money.of(10, 'USD'),
      currency: 'USD',
      merchantId: 'merchant_1',
      metadata: { campaign: 'summer_sale' },
    });

    const sentBody = new URLSearchParams((global.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(sentBody.get('metadata[campaign]')).toBe('summer_sale');
  });

  it("a merchant-supplied metadata key can't overwrite the reserved payment_id/merchant_id/bin_country keys", async () => {
    await adapter.charge({
      paymentId: 'pay_1',
      idempotencyKey: 'idem_1',
      amount: Money.of(10, 'USD'),
      currency: 'USD',
      merchantId: 'merchant_1',
      binCountry: 'US',
      metadata: { payment_id: 'spoofed', merchant_id: 'spoofed', bin_country: 'spoofed' },
    });

    const sentBody = new URLSearchParams((global.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(sentBody.get('metadata[payment_id]')).toBe('pay_1');
    expect(sentBody.get('metadata[merchant_id]')).toBe('merchant_1');
    expect(sentBody.get('metadata[bin_country]')).toBe('US');
  });
});
