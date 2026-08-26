import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PSPAdapterPort, PSPChargeRequest, PSPChargeResponse, PSPRefundRequest, PSPRefundResponse, PSPCaptureRequest, PSPCaptureResponse, PSPCancelRequest, PSPCancelResponse, PSPSettlementTransaction, PSPDisputeEvidenceResponse, PSPVerifyPaymentMethodRequest, PSPVerifyPaymentMethodResponse, PSPQueryOutcomeResult } from '../../../ports/outbound/psp-adapter.port';
import { PSPProvider } from '../../../domain/aggregates/payment.aggregate';
import { PSPHealthStatus } from '../../../domain/services/smart-routing.strategy';
import { RedisCircuitBreakerService } from '../../circuit-breaker/redis-circuit-breaker.service';
import { Money } from '../../../domain/value-objects/money.vo';
import { Semaphore } from '../../../../../shared/utils/semaphore';

/**
 * Stripe PSP Adapter
 * Implements PSPAdapterPort for Stripe payment processing.
 * Circuit breaker state and health metrics live in Redis (RedisCircuitBreakerService),
 * shared across every replica — see that service's docblock for why.
 */
@Injectable()
export class StripePSPAdapter extends PSPAdapterPort {
  readonly provider: PSPProvider = 'STRIPE';
  private readonly logger = new Logger(StripePSPAdapter.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly bulkhead: Semaphore;

  constructor(
    private readonly configService: ConfigService,
    private readonly circuitBreaker: RedisCircuitBreakerService,
  ) {
    super();
    this.apiKey = configService.get<string>('STRIPE_SECRET_KEY', 'sk_test_placeholder');
    // Caps how many concurrent outbound calls to Stripe this pod will have
    // in flight at once — see makeRequest() below, a bulkhead against one
    // degrading dependency exhausting this pod's own connection pool.
    // In-memory/per-pod, not Redis-backed: this protects this pod's own
    // connection pool/event loop capacity, not a cross-replica quota.
    // Read directly from process.env (not
    // configService.get, which doesn't coerce numeric strings) — same
    // reasoning and pattern as PaymentController's CHARGE_RATE_LIMIT_MAX.
    this.bulkhead = new Semaphore(Number(process.env.PSP_BULKHEAD_MAX_CONCURRENT) || 20);
    // Configurable like the Adyen adapter's ADYEN_BASE_URL — needed to point
    // at a local mock in tests/dev instead of always hitting the real Stripe API.
    this.baseUrl = configService.get<string>('STRIPE_BASE_URL', 'https://api.stripe.com/v1');
  }

  async charge(request: PSPChargeRequest): Promise<PSPChargeResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);
    const startTime = Date.now();

    try {
      this.logger.log(`Stripe charge: paymentId=${request.paymentId}, amount=${request.amount.amountMinorUnits} ${request.currency}`);

      // Build Stripe PaymentIntent params
      const params = new URLSearchParams({
        amount: request.amount.amountMinorUnits.toString(),
        currency: request.currency.toLowerCase(),
        'metadata[payment_id]': request.paymentId,
        'metadata[merchant_id]': request.merchantId,
        confirm: 'true',
        'automatic_payment_methods[enabled]': 'false',
      });

      if (request.paymentMethodId) {
        params.append('payment_method', request.paymentMethodId);
      }
      if (request.description) {
        params.append('description', request.description);
      }
      if (request.statementDescriptor) {
        params.append('statement_descriptor', request.statementDescriptor.substring(0, 22));
      }
      if (request.captureMethod === 'manual') {
        params.append('capture_method', 'manual');
      }
      if (request.binCountry) {
        // Hint only — Stripe's own SCA engine decides whether to challenge;
        // see PaymentCheckoutSaga's docblock for why nothing pre-empts that
        // decision on our side.
        params.append('metadata[bin_country]', request.binCountry);
      }

      const response = await this.makeRequest('POST', '/payment_intents', params, request.idempotencyKey);

      await this.circuitBreaker.recordSuccess(this.provider, Date.now() - startTime);

      if (response.status === 'requires_action') {
        return {
          success: false,
          transactionId: response.id,
          status: 'REQUIRES_ACTION',
          actionUrl: response.next_action?.redirect_to_url?.url,
          rawResponse: response,
        };
      }

      if (response.status === 'requires_capture') {
        return {
          success: false,
          transactionId: response.id,
          status: 'REQUIRES_CAPTURE',
          rawResponse: response,
        };
      }

      if (response.status === 'succeeded') {
        return {
          success: true,
          transactionId: response.id,
          status: 'SUCCEEDED',
          rawResponse: response,
        };
      }

      return {
        success: false,
        transactionId: response.id,
        status: 'FAILED',
        rawResponse: response,
        errorCode: response.last_payment_error?.code,
        errorMessage: response.last_payment_error?.message,
      };
    } catch (error) {
      await this.circuitBreaker.recordFailure(this.provider);
      const latency = Date.now() - startTime;
      this.logger.error(`Stripe charge failed after ${latency}ms: ${error.message}`);
      throw error;
    }
  }

  async refund(request: PSPRefundRequest): Promise<PSPRefundResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);
    const startTime = Date.now();

    try {
      const params = new URLSearchParams({
        payment_intent: request.pspTransactionId,
        amount: request.amount.amountMinorUnits.toString(),
        reason: this.mapRefundReason(request.reason),
        'metadata[refund_id]': request.refundId,
        'metadata[payment_id]': request.paymentId,
      });

      const response = await this.makeRequest('POST', '/refunds', params, request.idempotencyKey);
      await this.circuitBreaker.recordSuccess(this.provider, Date.now() - startTime);

      return {
        success: response.status === 'succeeded',
        pspRefundId: response.id,
        status: response.status === 'succeeded' ? 'SUCCEEDED' : 'PENDING',
        rawResponse: response,
      };
    } catch (error) {
      await this.circuitBreaker.recordFailure(this.provider);
      throw error;
    }
  }

  async capture(request: PSPCaptureRequest): Promise<PSPCaptureResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);

    try {
      const params = new URLSearchParams({
        amount_to_capture: request.amount.amountMinorUnits.toString(),
      });

      const response = await this.makeRequest(
        'POST',
        `/payment_intents/${request.pspTransactionId}/capture`,
        params,
        request.idempotencyKey,
      );

      return {
        success: response.status === 'succeeded',
        pspCaptureId: response.id,
        rawResponse: response,
      };
    } catch (error) {
      await this.circuitBreaker.recordFailure(this.provider);
      throw error;
    }
  }

  async cancel(request: PSPCancelRequest): Promise<PSPCancelResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);

    try {
      const response = await this.makeRequest(
        'POST',
        `/payment_intents/${request.pspTransactionId}/cancel`,
        new URLSearchParams(),
        request.idempotencyKey,
      );

      return {
        success: response.status === 'canceled',
        rawResponse: response,
      };
    } catch (error) {
      await this.circuitBreaker.recordFailure(this.provider);
      throw error;
    }
  }

  /**
   * Real Stripe SetupIntent: confirms a stored payment method off-session
   * without charging it — `usage: 'off_session'` tells Stripe this is for
   * a future off-session charge (a renewal), and
   * `allow_redirects: 'never'` means a card that needs a redirect-based
   * verification just fails outright here rather than this method having
   * to also handle a REQUIRES_ACTION-shaped response the way charge()
   * does — a trial signup that can't be verified synchronously isn't
   * verified.
   */
  async verifyPaymentMethod(request: PSPVerifyPaymentMethodRequest): Promise<PSPVerifyPaymentMethodResponse> {
    await this.circuitBreaker.assertAvailable(this.provider);
    const startTime = Date.now();

    try {
      const params = new URLSearchParams({
        payment_method: request.paymentMethodId,
        confirm: 'true',
        usage: 'off_session',
        'automatic_payment_methods[enabled]': 'true',
        'automatic_payment_methods[allow_redirects]': 'never',
        'metadata[merchant_id]': request.merchantId,
      });

      const response = await this.makeRequest('POST', '/setup_intents', params, request.idempotencyKey);
      await this.circuitBreaker.recordSuccess(this.provider, Date.now() - startTime);

      if (response.status === 'succeeded') {
        return { success: true, pspVerificationId: response.id, rawResponse: response };
      }

      return {
        success: false,
        pspVerificationId: response.id,
        rawResponse: response,
        errorCode: response.last_setup_error?.code,
        errorMessage: response.last_setup_error?.message,
      };
    } catch (error) {
      await this.circuitBreaker.recordFailure(this.provider);
      const latency = Date.now() - startTime;
      this.logger.error(`Stripe payment method verification failed after ${latency}ms: ${error.message}`);
      throw error;
    }
  }

  /**
   * See PSPAdapterPort.queryOutcome's docblock. Real Stripe: replaying
   * any request with the same Idempotency-Key header returns the cached
   * response of the original call regardless of body — this mock models
   * that with a dedicated GET lookup instead, since a real replay would
   * still require constructing a full request body this system no
   * longer has the card reference for.
   */
  async queryOutcome(idempotencyKey: string): Promise<PSPQueryOutcomeResult> {
    await this.circuitBreaker.assertAvailable(this.provider);
    const startTime = Date.now();

    try {
      const response = await this.makeRequest(
        'GET',
        `/payment_intents/lookup?idempotency_key=${encodeURIComponent(idempotencyKey)}`,
        new URLSearchParams(),
      );
      await this.circuitBreaker.recordSuccess(this.provider, Date.now() - startTime);

      if (!response.found) {
        return { outcome: 'STILL_UNKNOWN' };
      }
      if (response.status === 'succeeded') {
        return { outcome: 'SUCCEEDED', pspTransactionId: response.id, rawResponse: response };
      }
      return {
        outcome: 'FAILED',
        pspTransactionId: response.id,
        errorCode: response.last_payment_error?.code,
        rawResponse: response,
      };
    } catch (error) {
      await this.circuitBreaker.recordFailure(this.provider);
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
      feePercentage: 2.9,
      fixedFeeMinorUnits: 30, // $0.30
      supportedCurrencies: [
        'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD',
        'SGD', 'SEK', 'NOK', 'DKK', 'NZD', 'MXN', 'BRL', 'INR',
        'JPY', 'TWD', 'THB', 'MYR', 'IDR', 'PHP', 'ZAR', 'AED',
      ],
      supportedCountries: ['*'], // Stripe supports global
      isAvailable: metrics.state !== 'OPEN',
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.circuitBreaker.isAvailable(this.provider);
  }

  async fetchSettlementTransactions(since: Date, until: Date): Promise<PSPSettlementTransaction[]> {
    const query = new URLSearchParams({
      'created[gte]': Math.floor(since.getTime() / 1000).toString(),
      'created[lte]': Math.floor(until.getTime() / 1000).toString(),
    });
    const response = await fetch(`${this.baseUrl}/balance_transactions?${query.toString()}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`Stripe balance_transactions request failed: ${response.status}`);
    }
    const body = await response.json();
    return (body.data || []).map((tx: { id: string; amount: number; currency: string; createdAt: string }) => ({
      pspTransactionId: tx.id,
      amount: Money.fromMinorUnits(tx.amount, tx.currency),
      settledAt: new Date(tx.createdAt),
    }));
  }

  async submitDisputeEvidence(pspDisputeId: string, evidence: string): Promise<PSPDisputeEvidenceResponse> {
    try {
      // Real Stripe: POST /v1/disputes/:id with evidence[...] fields and
      // submit=true. This mock only needs a single free-text field, not
      // Stripe's full evidence taxonomy (receipt, shipping docs, etc.).
      const params = new URLSearchParams({
        'evidence[uncategorized_text]': evidence,
        submit: 'true',
      });
      const response = await this.makeRequest('POST', `/disputes/${pspDisputeId}`, params);
      return { success: response.status === 'under_review', rawResponse: response };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, rawResponse: {}, errorMessage: msg };
    }
  }

  // ─── HTTP Client ────────────────────────────────────────────────────────────

  // Bulkhead-wrapped: acquires a permit before making the actual outbound
  // call, queuing rather than piling up unboundedly if
  // PSP_BULKHEAD_MAX_CONCURRENT Stripe calls are already in flight from
  // this pod. See the constant's docblock above.
  private async makeRequest(
    method: string,
    path: string,
    params: URLSearchParams,
    idempotencyKey?: string,
  ): Promise<any> {
    return this.bulkhead.run(() => this.makeRequestInner(method, path, params, idempotencyKey));
  }

  private async makeRequestInner(
    method: string,
    path: string,
    params: URLSearchParams,
    idempotencyKey?: string,
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2023-10-16',
    };

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' ? params.toString() : undefined,
        signal: AbortSignal.timeout(30000), // 30s timeout
      });
    } catch (err: unknown) {
      // fetch() itself threw — either the 30s AbortSignal above fired, or a
      // lower-level network failure (DNS, connection refused, TLS
      // handshake) — before any response was ever received. Unlike the
      // !response.ok branch below, this means whether Stripe actually
      // processed the request is genuinely unknown, not "no": tagged so a
      // caller (PaymentCheckoutSaga) can treat it as a distinct, ambiguous
      // outcome instead of the same kind of failure as an explicit decline.
      throw Object.assign(
        new Error(`Stripe request failed with no response: ${err instanceof Error ? err.message : String(err)}`),
        { isAmbiguousOutcome: true },
      );
    }

    const data = await response.json();

    if (!response.ok) {
      const error = data.error || {};
      throw Object.assign(new Error(error.message || 'Stripe API error'), {
        code: error.code,
        type: error.type,
        statusCode: response.status,
      });
    }

    return data;
  }

  private mapRefundReason(reason: string): string {
    const map: Record<string, string> = {
      'duplicate': 'duplicate',
      'fraudulent': 'fraudulent',
      'customer_request': 'requested_by_customer',
    };
    return map[reason.toLowerCase()] || 'requested_by_customer';
  }
}
