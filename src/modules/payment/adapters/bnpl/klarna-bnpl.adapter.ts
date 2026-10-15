import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BnplAdapterPort,
  BnplOrderRequest,
  BnplOrderResponse,
  BnplCaptureRequest,
  BnplCaptureResponse,
  BnplRefundRequest,
  BnplRefundResponse,
} from '../../ports/outbound/bnpl-adapter.port';

/**
 * Klarna BNPL Adapter
 * Endpoint names and the create-order -> capture -> refund split are
 * modeled on real Klarna's actual API structure — the Payments API's
 * `/payments/v1/authorizations/{authorization_token}/order` (placing
 * an order once the customer has authorized it) and the Order
 * Management API's `/ordermanagement/v1/orders/{order_id}/captures`
 * and `/ordermanagement/v1/orders/{order_id}/refunds` (capture is the
 * point Klarna actually pays the merchant; refund is a Klarna-side
 * action, never a card-network reversal). What this adapter does
 * *not* attempt to reproduce: the real pre-authorization step (a
 * customer-facing Klarna checkout session, `/payments/v1/sessions`,
 * that returns a `client_token` for a frontend SDK to collect the
 * customer's own authorization against before a backend ever calls
 * `createOrder()`) — this reference project has no frontend to run
 * that flow through, the same simplification already accepted for a
 * card's 3DS `actionUrl` redirect. `createOrder()` here stands in for
 * that already-authorized hand-off, same spirit as how this codebase
 * already treats a PSP's real async redirect flow.
 *
 * Same honest posture as `AchBankTransferAdapter`'s own docblock: this
 * mechanism is real and genuinely runnable end to end against
 * `scripts/mock-psp/server.js`'s `/klarna/...` routes, but no real
 * Klarna account has ever actually been called with real credentials,
 * and the exact field names inside each request/response body below
 * are illustrative rather than a byte-exact reproduction of Klarna's
 * published schema (which this project has not independently verified
 * field-by-field).
 */
@Injectable()
export class KlarnaBnplAdapter extends BnplAdapterPort {
  private readonly logger = new Logger(KlarnaBnplAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('KLARNA_PROVIDER_URL', 'http://localhost:4000/klarna');
  }

  async createOrder(request: BnplOrderRequest): Promise<BnplOrderResponse> {
    const response = await fetch(`${this.baseUrl}/payments/v1/authorizations/mock/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.idempotencyKey },
      body: JSON.stringify({
        merchant_reference: request.bnplOrderId,
        order_amount: Number(request.amount.amountMinorUnits),
        purchase_currency: request.amount.currency.code,
        merchant_id: request.merchantId,
        customer_id: request.customerId,
        description: request.description,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const body = await response.json();
    if (!response.ok || body.fraud_status === 'REJECTED') {
      return {
        success: false,
        status: 'REJECTED',
        providerOrderId: body.order_id ?? '',
        rawResponse: body,
        errorMessage: body.error ?? 'Klarna declined this order',
      };
    }

    this.logger.log(`Klarna order placed for merchant ${request.merchantId}: order_id=${body.order_id}`);
    return { success: true, status: 'AUTHORIZED', providerOrderId: body.order_id, rawResponse: body };
  }

  async captureOrder(request: BnplCaptureRequest): Promise<BnplCaptureResponse> {
    const response = await fetch(
      `${this.baseUrl}/ordermanagement/v1/orders/${encodeURIComponent(request.providerOrderId)}/captures`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.idempotencyKey },
        body: JSON.stringify({ captured_amount: Number(request.amount.amountMinorUnits) }),
        signal: AbortSignal.timeout(15000),
      },
    );

    const body = await response.json();
    if (!response.ok) {
      return { success: false, rawResponse: body, errorMessage: body.error ?? 'Klarna capture failed' };
    }

    this.logger.log(`Klarna order ${request.providerOrderId} captured: capture_id=${body.capture_id}`);
    return { success: true, providerCaptureId: body.capture_id, rawResponse: body };
  }

  async refundOrder(request: BnplRefundRequest): Promise<BnplRefundResponse> {
    const response = await fetch(
      `${this.baseUrl}/ordermanagement/v1/orders/${encodeURIComponent(request.providerOrderId)}/refunds`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.idempotencyKey },
        body: JSON.stringify({ refunded_amount: Number(request.amount.amountMinorUnits), description: request.reason }),
        signal: AbortSignal.timeout(15000),
      },
    );

    const body = await response.json();
    if (!response.ok) {
      return { success: false, rawResponse: body, errorMessage: body.error ?? 'Klarna refund failed' };
    }

    this.logger.log(`Klarna order ${request.providerOrderId} refunded: refund_id=${body.refund_id}`);
    return { success: true, providerRefundId: body.refund_id, rawResponse: body };
  }
}
