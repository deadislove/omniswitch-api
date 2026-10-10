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

describe('AdyenPSPAdapter — custom metadata forwarding', () => {
  let adapter: AdyenPSPAdapter;
  const originalFetch = global.fetch;

  beforeEach(() => {
    const circuitBreaker = {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    const configService = { get: (_key: string, def?: string) => def } as any;
    adapter = new AdyenPSPAdapter(configService, circuitBreaker as unknown as RedisCircuitBreakerService);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pspReference: 'psp_123', resultCode: 'Authorised' }),
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("forwards ChargePaymentDto.metadata into Adyen's own metadata object", async () => {
    await adapter.charge({
      paymentId: 'pay_1',
      idempotencyKey: 'idem_1',
      amount: Money.of(10, 'USD'),
      currency: 'USD',
      merchantId: 'merchant_1',
      metadata: { campaign: 'summer_sale' },
    });

    const sentBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sentBody.metadata.campaign).toBe('summer_sale');
  });

  it("a merchant-supplied metadata key can't overwrite the reserved paymentId/merchantId/binCountry keys", async () => {
    await adapter.charge({
      paymentId: 'pay_1',
      idempotencyKey: 'idem_1',
      amount: Money.of(10, 'USD'),
      currency: 'USD',
      merchantId: 'merchant_1',
      binCountry: 'US',
      metadata: { paymentId: 'spoofed', merchantId: 'spoofed', binCountry: 'spoofed' },
    });

    const sentBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sentBody.metadata.paymentId).toBe('pay_1');
    expect(sentBody.metadata.merchantId).toBe('merchant_1');
    expect(sentBody.metadata.binCountry).toBe('US');
  });
});

describe('AdyenPSPAdapter — fraudResult risk signal', () => {
  let adapter: AdyenPSPAdapter;
  const originalFetch = global.fetch;

  beforeEach(() => {
    const circuitBreaker = {
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

  it('surfaces fraudResult.accountScore as riskSignal.riskScore (no riskLevel — Adyen has no such category)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        pspReference: 'psp_123',
        resultCode: 'Authorised',
        fraudResult: { accountScore: 67, results: [{ accountScoreResult: 67, checkId: 1, name: 'Test' }] },
      }),
    }) as any;

    const result = await adapter.charge({
      paymentId: 'pay_1',
      idempotencyKey: 'idem_1',
      amount: Money.of(10, 'USD'),
      currency: 'USD',
      merchantId: 'merchant_1',
    });

    expect(result.riskSignal).toEqual({ riskScore: 67 });
  });

  it('leaves riskSignal undefined when the response has no fraudResult at all', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pspReference: 'psp_123', resultCode: 'Authorised' }),
    }) as any;

    const result = await adapter.charge({
      paymentId: 'pay_1',
      idempotencyKey: 'idem_1',
      amount: Money.of(10, 'USD'),
      currency: 'USD',
      merchantId: 'merchant_1',
    });

    expect(result.riskSignal).toBeUndefined();
  });
});
