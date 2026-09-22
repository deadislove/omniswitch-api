export interface OmniSwitchClientOptions {
    baseUrl: string;
    apiKeyId: string;
    apiKeySecret: string;
    hmacSecret: string;
    merchantId: string;
    fetch?: typeof fetch;
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
    splits?: {
        merchantId: string;
        amount: number;
    }[];
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
    estimatedFee?: {
        amount: number;
        currency: string;
    };
    presentmentAmount?: number | null;
    presentmentCurrency?: string | null;
    createdAt: string;
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
export interface IdempotentCallOptions {
    idempotencyKey?: string;
}
