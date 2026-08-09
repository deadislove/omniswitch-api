import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PSPAdapterPort, PSPChargeRequest, PSPChargeResponse, PSPRefundRequest, PSPRefundResponse, PSPCaptureRequest, PSPCaptureResponse, PSPCancelRequest, PSPCancelResponse, PSPSettlementTransaction, PSPDisputeEvidenceResponse, PSPVerifyPaymentMethodRequest, PSPVerifyPaymentMethodResponse } from '../../../ports/outbound/psp-adapter.port';
import { PSPProvider } from '../../../domain/aggregates/payment.aggregate';
import { PSPHealthStatus } from '../../../domain/services/smart-routing.strategy';
import { RedisCircuitBreakerService } from '../../circuit-breaker/redis-circuit-breaker.service';
import { Money } from '../../../domain/value-objects/money.vo';

/**
 * Adyen PSP Adapter
 * Implements PSPAdapterPort for Adyen payment processing.
 * Preferred for European transactions (PSD2/SCA compliance).
 * Circuit breaker state and health metrics live in Redis (RedisCircuitBreakerService),
 * shared across every replica — see that service's docblock for why.
 */
@Injectable()
export class AdyenPSPAdapter extends PSPAdapterPort {
  readonly provider: PSPProvider = 'ADYEN';
  private readonly logger = new Logger(AdyenPSPAdapter.name);
  private readonly apiKey: string;
  private readonly merchantAccount: string;
  private readonly baseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly circuitBreaker: RedisCircuitBreakerService,
  ) {
    super();
    this.apiKey = configService.get<string>('ADYEN_API_KEY', 'adyen_test_placeholder');
    this.merchantAccount = configService.get<string>('ADYEN_MERCHANT_ACCOUNT', 'TestMerchant');
    this.baseUrl = configService.get<string>('ADYEN_BASE_URL', 'https://checkout-test.adyen.com/v71');
  }

  async charge(request: PSPChargeRequest): Promise<PSPChargeResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);
    const startTime = Date.now();

    try {
      const body = {
        merchantAccount: this.merchantAccount,
        amount: {
          value: Number(request.amount.amountMinorUnits),
          currency: request.currency,
        },
        reference: request.paymentId,
        paymentMethod: request.paymentMethodId
          ? { type: 'scheme', storedPaymentMethodId: request.paymentMethodId }
          : { type: 'scheme' },
        returnUrl: 'https://your-company.com/checkout/return',
        metadata: {
          paymentId: request.paymentId,
          merchantId: request.merchantId,
          // Hint only — Adyen's own SCA engine decides whether to
          // challenge; see PaymentCheckoutSaga's docblock for why nothing
          // pre-empts that decision on our side.
          ...(request.binCountry ? { binCountry: request.binCountry } : {}),
        },
        additionalData: {
          'allow3DS2': 'true',
          // Adyen's classic API doesn't take a per-request manual-capture
          // flag the way Stripe does — "separate capture" is normally an
          // account-level setting in the Customer Area. This flag is a
          // best-effort signal for merchant accounts configured that way;
          // it doesn't change Adyen's actual capture behavior on its own.
          ...(request.captureMethod === 'manual' ? { manualCapture: 'true' } : {}),
        },
      };

      const response = await this.makeRequest('POST', '/payments', body, request.idempotencyKey);
      await this.circuitBreaker.recordSuccess(this.provider, Date.now() - startTime);

      if (response.resultCode === 'Authorised') {
        if (request.captureMethod === 'manual') {
          return {
            success: false,
            transactionId: response.pspReference,
            status: 'REQUIRES_CAPTURE',
            rawResponse: response,
          };
        }
        return {
          success: true,
          transactionId: response.pspReference,
          status: 'SUCCEEDED',
          rawResponse: response,
        };
      }

      if (response.resultCode === 'RedirectShopper' || response.resultCode === 'IdentifyShopper') {
        return {
          success: false,
          transactionId: response.pspReference || request.paymentId,
          status: 'REQUIRES_ACTION',
          actionUrl: response.action?.url,
          rawResponse: response,
        };
      }

      return {
        success: false,
        transactionId: response.pspReference || request.paymentId,
        status: 'FAILED',
        rawResponse: response,
        errorCode: response.refusalReasonCode,
        errorMessage: response.refusalReason,
      };
    } catch (error: unknown) {
      await this.circuitBreaker.recordFailure(this.provider);
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Adyen charge failed: ${msg}`);
      throw error;
    }
  }

  async refund(request: PSPRefundRequest): Promise<PSPRefundResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);

    try {
      const body = {
        merchantAccount: this.merchantAccount,
        amount: {
          value: Number(request.amount.amountMinorUnits),
          currency: request.amount.currency.code,
        },
        reference: request.refundId,
      };

      const response = await this.makeRequest(
        'POST',
        `/payments/${request.pspTransactionId}/refunds`,
        body,
        request.idempotencyKey,
      );

      return {
        success: true,
        pspRefundId: response.pspReference,
        status: 'PENDING', // Adyen refunds are async
        rawResponse: response,
      };
    } catch (error: unknown) {
      await this.circuitBreaker.recordFailure(this.provider);
      throw error;
    }
  }

  async capture(request: PSPCaptureRequest): Promise<PSPCaptureResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);

    try {
      const body = {
        merchantAccount: this.merchantAccount,
        amount: {
          value: Number(request.amount.amountMinorUnits),
          currency: request.amount.currency.code,
        },
        reference: `capture-${request.paymentId}`,
      };

      const response = await this.makeRequest(
        'POST',
        `/payments/${request.pspTransactionId}/captures`,
        body,
        request.idempotencyKey,
      );

      return {
        success: true,
        pspCaptureId: response.pspReference,
        rawResponse: response,
      };
    } catch (error: unknown) {
      await this.circuitBreaker.recordFailure(this.provider);
      throw error;
    }
  }

  async cancel(request: PSPCancelRequest): Promise<PSPCancelResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);

    try {
      const body = {
        merchantAccount: this.merchantAccount,
        reference: `cancel-${request.paymentId}`,
      };

      const response = await this.makeRequest(
        'POST',
        `/payments/${request.pspTransactionId}/cancels`,
        body,
        request.idempotencyKey,
      );

      return {
        success: true,
        rawResponse: response,
      };
    } catch (error: unknown) {
      await this.circuitBreaker.recordFailure(this.provider);
      throw error;
    }
  }

  /**
   * Real Adyen has no separate SetupIntent-style API the way Stripe
   * does — the equivalent pattern is a zero-value authorization: a real
   * `/payments` call with `amount.value: 0` and `shopperInteraction:
   * 'ContAuth'` (off-session, using a previously-stored credential),
   * which validates the card without moving money. Routed to a
   * dedicated mock path (`/payments/verify`) rather than `/payments`
   * itself purely so the mock server's routing stays simple (no funds
   * move either way, but a $0 "charge" sharing a path with real charges
   * would need extra branching there to never push a settlement row) —
   * a real integration would just add `amount.value: 0` to the same
   * `/payments` call `charge()` already makes.
   */
  async verifyPaymentMethod(request: PSPVerifyPaymentMethodRequest): Promise<PSPVerifyPaymentMethodResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);
    const startTime = Date.now();

    try {
      const body = {
        merchantAccount: this.merchantAccount,
        amount: { value: 0, currency: request.currency },
        reference: `verify-${request.merchantId}-${Date.now()}`,
        paymentMethod: { type: 'scheme', storedPaymentMethodId: request.paymentMethodId },
        shopperInteraction: 'ContAuth',
        metadata: { merchantId: request.merchantId },
      };

      const response = await this.makeRequest('POST', '/payments/verify', body, request.idempotencyKey);
      await this.circuitBreaker.recordSuccess(this.provider, Date.now() - startTime);

      if (response.resultCode === 'Authorised') {
        return { success: true, pspVerificationId: response.pspReference, rawResponse: response };
      }

      return {
        success: false,
        pspVerificationId: response.pspReference,
        rawResponse: response,
        errorCode: response.refusalReasonCode,
        errorMessage: response.refusalReason,
      };
    } catch (error: unknown) {
      await this.circuitBreaker.recordFailure(this.provider);
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Adyen payment method verification failed: ${msg}`);
      throw error;
    }
  }

  async getHealthStatus(): Promise<PSPHealthStatus> {
    const metrics = await this.circuitBreaker.getMetrics(this.provider);
    const successRate = metrics.totalRequests > 0
      ? (metrics.successCount / metrics.totalRequests) * 100
      : 100;

    return {
      provider: this.provider,
      circuitBreakerState: metrics.state,
      successRate: Math.round(successRate),
      avgLatencyMs: Math.round(metrics.avgLatencyMs),
      feePercentage: 0.3,  // Adyen interchange++ model
      fixedFeeMinorUnits: 10,
      supportedCurrencies: [
        'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'SEK', 'NOK', 'DKK',
        'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'JPY', 'CNY', 'HKD',
        'SGD', 'MYR', 'THB', 'IDR', 'PHP', 'INR', 'ZAR', 'AED', 'SAR',
      ],
      supportedCountries: [
        'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
        'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
        'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'GB', 'US', 'AU',
        'CA', 'JP', 'SG', 'HK', 'MY', 'TH', 'ID', 'PH', 'IN', 'ZA',
      ],
      isAvailable: metrics.state !== 'OPEN',
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.circuitBreaker.isAvailable(this.provider);
  }

  async fetchSettlementTransactions(since: Date, until: Date): Promise<PSPSettlementTransaction[]> {
    const query = new URLSearchParams({
      since: Math.floor(since.getTime() / 1000).toString(),
      until: Math.floor(until.getTime() / 1000).toString(),
    });
    const response = await fetch(`${this.baseUrl}/settlement-report?${query.toString()}`, {
      method: 'GET',
      headers: { 'X-API-Key': this.apiKey },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`Adyen settlement-report request failed: ${response.status}`);
    }
    const body = await response.json();
    return (body.transactions || []).map((tx: { id: string; amount: number; currency: string; createdAt: string }) => ({
      pspTransactionId: tx.id,
      amount: Money.fromMinorUnits(tx.amount, tx.currency),
      settledAt: new Date(tx.createdAt),
    }));
  }

  async submitDisputeEvidence(pspDisputeId: string, evidence: string): Promise<PSPDisputeEvidenceResponse> {
    try {
      // Real Adyen's Disputes API (supplyDefenseDocument) lives on a
      // separate host with its own document-upload shape; this mock keeps
      // it to the same baseUrl and a single free-text field for simplicity.
      const response = await this.makeRequest('POST', `/disputes/${pspDisputeId}/defense`, { content: evidence });
      return { success: response.success === true, rawResponse: response };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, rawResponse: {}, errorMessage: msg };
    }
  }

  private async makeRequest(
    method: string,
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    const data = await response.json();

    if (!response.ok) {
      throw Object.assign(new Error(data.message || 'Adyen API error'), {
        errorCode: data.errorCode,
        statusCode: response.status,
      });
    }

    return data;
  }
}
