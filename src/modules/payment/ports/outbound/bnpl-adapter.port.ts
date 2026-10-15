import { Money } from '../../domain/value-objects/money.vo';

export interface BnplOrderRequest {
  bnplOrderId: string;
  idempotencyKey: string;
  amount: Money;
  merchantId: string;
  customerId?: string;
  description?: string;
}

export interface BnplOrderResponse {
  success: boolean;
  status: 'AUTHORIZED' | 'REJECTED';
  providerOrderId: string;
  rawResponse: Record<string, unknown>;
  errorMessage?: string;
}

export interface BnplCaptureRequest {
  providerOrderId: string;
  amount: Money;
  idempotencyKey: string;
}

export interface BnplCaptureResponse {
  success: boolean;
  providerCaptureId?: string;
  rawResponse: Record<string, unknown>;
  errorMessage?: string;
}

export interface BnplRefundRequest {
  providerOrderId: string;
  amount: Money;
  reason: string;
  idempotencyKey: string;
}

export interface BnplRefundResponse {
  success: boolean;
  providerRefundId?: string;
  rawResponse: Record<string, unknown>;
  errorMessage?: string;
}

/**
 * BNPL Adapter Port (Outbound)
 * Deliberately a separate port from `PSPAdapterPort` rather than
 * another method on it — a card charge and a BNPL order don't share a
 * request/response shape at any step: `createOrder()` returns
 * `AUTHORIZED`/`REJECTED` (Klarna's own real-time credit decision, not
 * an auth/capture split a card makes), `captureOrder()` is the point
 * money actually moves to the merchant (not a formality the way
 * capturing an already-authorized card charge can feel), and
 * `refundOrder()` routes back through the BNPL provider itself rather
 * than a card-network reversal. See `BnplOrder`'s own docblock and
 * `docs/business-domain/bnpl.md` for the full real-vs-modeled scope.
 *
 * One concrete adapter today (`KlarnaBnplAdapter`) — no
 * `BANK_TRANSFER_PROVIDER`-style multi-provider selection, since this
 * reference project only models one BNPL provider; a second (Affirm,
 * Afterpay) would need its own adapter behind this same port, the same
 * way `AchBankTransferAdapter`/`WireBankTransferAdapter` share
 * `BankTransferPort`.
 */
export abstract class BnplAdapterPort {
  abstract createOrder(request: BnplOrderRequest): Promise<BnplOrderResponse>;
  abstract captureOrder(request: BnplCaptureRequest): Promise<BnplCaptureResponse>;
  abstract refundOrder(request: BnplRefundRequest): Promise<BnplRefundResponse>;
}
