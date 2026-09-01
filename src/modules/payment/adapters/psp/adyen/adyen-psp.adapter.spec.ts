import { AdyenPSPAdapter } from './adyen-psp.adapter';
import { RedisCircuitBreakerService } from '../../circuit-breaker/redis-circuit-breaker.service';
import { Money } from '../../../domain/value-objects/money.vo';
import { PSPChargeRequest } from '../../../ports/outbound/psp-adapter.port';

describe('AdyenPSPAdapter — ambiguous outcome tagging', () => {
  let adapter: AdyenPSPAdapter;
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
    adapter = new AdyenPSPAdapter(configService, circuitBreaker as unknown as RedisCircuitBreakerService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('tags a fetch()-level failure (timeout/network error, no response ever received) as isAmbiguousOutcome', async () => {
    global.fetch = jest.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError')) as any;

    const err: any = await adapter.charge(chargeRequest).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.isAmbiguousOutcome).toBe(true);
    expect(circuitBreaker.recordFailure).toHaveBeenCalledWith('ADYEN');
  });

  it('does NOT tag an explicit non-2xx PSP response (a real refusal) as isAmbiguousOutcome', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: 'Invalid card number', errorCode: '101' }),
    }) as any;

    const err: any = await adapter.charge(chargeRequest).catch((e) => e);

    expect(err.isAmbiguousOutcome).toBeUndefined();
    expect(err.errorCode).toBe('101');
    expect(circuitBreaker.recordFailure).toHaveBeenCalledWith('ADYEN');
  });

  it('does not tag a successful response as ambiguous, and records success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pspReference: 'psp_123', resultCode: 'Authorised' }),
    }) as any;

    const result = await adapter.charge(chargeRequest);

    expect(result.success).toBe(true);
    expect(result.status).toBe('SUCCEEDED');
    expect(circuitBreaker.recordSuccess).toHaveBeenCalled();
    expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
  });
});
