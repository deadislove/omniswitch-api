export interface OmniSwitchClientOptions {
  /** e.g. `https://api.example.com/api/v1` — no trailing slash. */
  baseUrl: string;
  apiKeyId: string;
  apiKeySecret: string;
  /** This merchant's HMAC signing key (from `POST /admin/merchants` or a rotation call) — never the JWT. */
  hmacSecret: string;
  /** Business-facing merchant id, sent as `X-Merchant-Id` on every signed request. */
  merchantId: string;
  /** Injectable for tests/non-standard runtimes — defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Request timeout, milliseconds. Default 30000. */
  timeoutMs?: number;
}

export interface BinInfo {
  bin: string;
  country: string;
  cardBrand?: string;
  cardType?: string;
  issuingBank?: string;
}

export interface ChargeParams {
  /** Major currency units, e.g. `99.99`. */
  amount: number;
  currency: string;
  customerId?: string;
  paymentMethodId?: string;
  cardToken?: string;
  orderId?: string;
  description?: string;
  statementDescriptor?: string;
  binInfo?: BinInfo;
  preferredProvider?: 'STRIPE' | 'ADYEN' | 'PAYPAL' | 'CHASE';
  metadata?: Record<string, string>;
  category?: string;
  captureMethod?: 'automatic' | 'manual';
  presentmentCurrency?: string;
  splits?: { merchantId: string; amount: number }[];
}

export interface ChargeResponse {
  paymentId: string;
  status: 'SUCCEEDED' | 'REQUIRES_ACTION' | 'REQUIRES_CAPTURE' | 'FAILED' | 'AMBIGUOUS' | 'PENDING_APPROVAL';
  pspTransactionId?: string;
  pspProvider?: 'STRIPE' | 'ADYEN' | 'PAYPAL' | 'CHASE';
  actionUrl?: string | null;
  requiresAction: boolean;
  riskScore?: number;
  usedFallback: boolean;
  estimatedFee?: { amount: number; currency: string };
  presentmentAmount?: number | null;
  presentmentCurrency?: string | null;
  createdAt: string;
  /** Only present when an AGENT charge exceeded its delegation's requireApprovalAboveAmount — see docs/guide/api/agentic-payments.md. */
  approvalId?: string;
}

export interface PaymentDetail extends ChargeResponse {
  amount: number;
  currency: string;
  merchantId: string;
  customerId?: string;
  orderId?: string;
  metadata?: Record<string, string>;
  refunds: unknown[];
  captures: unknown[];
}

export interface RefundParams {
  /** Major currency units — omit for a full refund of the remaining refundable balance. */
  amount?: number;
  reason?: string;
}

export interface RefundResponse {
  paymentId: string;
  status: string;
  totalRefunded: number;
  remainingRefundable: number;
  currency: string;
  refunds: unknown[];
}

export interface CaptureParams {
  /** Major currency units — omit for a full capture of the remaining authorized amount. */
  amount?: number;
}

export interface CaptureResponse {
  paymentId: string;
  status: string;
  pspTransactionId: string;
  amount: number;
  totalCaptured: number;
  remainingCapturable: number;
  currency: string;
  captures: unknown[];
}

export interface CancelResponse {
  paymentId: string;
  status: string;
}

/** Passed per-call to reuse the same Idempotency-Key across a retried logical operation — see docs/guide/api/README.md#idempotency. Omit to have the SDK generate a fresh UUID v4 per call. */
export interface IdempotentCallOptions {
  idempotencyKey?: string;
}
